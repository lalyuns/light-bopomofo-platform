// ⑦ 分析：給編輯做營運決策。六項分析中，後三項要合併 MongoDB 與 PostgreSQL 的資料。
import { Router } from 'express';
import { mongoDb, query } from '../db.js';
import { requireEditor } from '../auth.js';
import { handle, HttpError } from '../errors.js';

export const analytics = Router();
analytics.use('/analytics', requireEditor);

// 資料到 2026-11-18 為止；「最近」以最後一筆資料的時間為準，demo 時才不會變成 0
const LATEST = `(SELECT max(last_synced_at) FROM devices)`;

analytics.get('/analytics/overview', handle(async (req, res) => {
  const [row] = await query(`
    SELECT (SELECT count(*) FROM word_reviews WHERE status = 'pending') AS pending,
           (SELECT count(*) FROM reports WHERE status = 'open') AS open_reports,
           (SELECT count(*) FROM devices WHERE last_synced_at > ${LATEST} - interval '7 days') AS active_devices,
           (SELECT count(*) FROM lexicon_entries WHERE status = 'active') AS active_entries,
           (SELECT count(*) FROM users WHERE status = 'active') AS users`);
  res.json(row);
}));

/**
 * 1. 很多裝置在用、卻等很久還沒審的詞（PostgreSQL）
 * 編輯的待辦：已經有 100 台以上裝置在用，第一次出現超過 7 天還在待審。
 */
analytics.get('/analytics/backlog', handle(async (req, res) => {
  res.json({ rows: await query(`
    SELECT w.text, count(DISTINCT s.device_id) AS devices, sum(s.use_count) AS uses,
           min(s.first_seen) AS first_seen,
           extract(day FROM ${LATEST} - min(s.first_seen))::int AS waiting_days
      FROM word_reviews r JOIN words w USING (word_id) JOIN submissions s USING (word_id)
     WHERE r.status = 'pending'
     GROUP BY w.word_id
    HAVING count(DISTINCT s.device_id) >= 100 AND min(s.first_seen) < ${LATEST} - interval '7 days'
     ORDER BY devices DESC
     LIMIT 20`) });
}));

/**
 * 2. 使用次數與票數落差大的詞（PostgreSQL）
 * 把待審詞的使用次數、淨票各自排名成 0–1 的百分位，相減：
 * 正值＝很多人在用卻沒人投票（可能大家不知道有投票功能），負值＝票很多卻少人用（可能被灌票）。
 * 票數只算 active 帳號（R2）；編輯在「管理」停權洗票帳號後，這裡的結果會跟著變。
 */
analytics.get('/analytics/gap', handle(async (req, res) => {
  const rows = await query(`
    WITH s AS (SELECT word_id, sum(use_count) AS uses FROM submissions GROUP BY word_id),
         -- 停權、已刪除帳號的票不算（R2），與待審列表的排序一致
         v AS (SELECT v.word_id, sum(v.value) AS net_votes, count(*) AS votes
                 FROM votes v JOIN users u USING (user_id) WHERE u.status = 'active' GROUP BY v.word_id),
         x AS (
           SELECT w.text, s.uses, coalesce(v.net_votes, 0) AS net_votes, coalesce(v.votes, 0) AS votes,
                  percent_rank() OVER (ORDER BY s.uses) - percent_rank() OVER (ORDER BY coalesce(v.net_votes, 0)) AS gap
             FROM word_reviews r JOIN words w USING (word_id) JOIN s USING (word_id) LEFT JOIN v USING (word_id)
            WHERE r.status = 'pending')
    (SELECT 'used' AS side, * FROM x ORDER BY gap DESC, uses DESC LIMIT 10)
    UNION ALL
    (SELECT 'voted' AS side, * FROM x ORDER BY gap ASC, votes DESC LIMIT 10)`);
  res.json({ used: rows.filter((r) => r.side === 'used'), voted: rows.filter((r) => r.side === 'voted') });
}));

/**
 * 3. 各來源被回報的比例（PostgreSQL）
 * 哪個來源的詞條品質最差：每千筆詞條收到幾筆回報、回報成立的比例。
 */
analytics.get('/analytics/sources', handle(async (req, res) => {
  res.json({ rows: await query(`
    SELECT s.name AS source,
           count(DISTINCT e.entry_id) AS entries,
           count(r.report_id) AS reports,
           round(1000.0 * count(r.report_id) / count(DISTINCT e.entry_id), 2) AS per_thousand,
           count(r.report_id) FILTER (WHERE r.status = 'resolved') AS resolved,
           round(100.0 * count(r.report_id) FILTER (WHERE r.status = 'resolved')
                 / nullif(count(r.report_id) FILTER (WHERE r.status <> 'open'), 0), 1) AS resolved_pct
      FROM sources s
      JOIN lexicon_entries e USING (source_id)
      LEFT JOIN reports r USING (entry_id)
     GROUP BY s.source_id
     ORDER BY per_thousand DESC`) });
}));

async function mongo() {
  try {
    return await mongoDb();
  } catch {
    throw new HttpError(503, 'MongoDB 沒有連線，這項分析需要它');
  }
}

/**
 * 4. 從第一次投稿到審核完成的天數（MongoDB ＋ PostgreSQL）
 * 審核時間：MongoDB review_history 裡每個詞第一次被決定的時間（word_reviews 重審後會被蓋掉）
 * 投稿時間：PostgreSQL submissions 裡最早的 first_seen
 */
analytics.get('/analytics/review-time', handle(async (req, res) => {
  const decisions = await (await mongo()).collection('review_history').aggregate([
    { $match: { from: 'pending', to: { $in: ['approved', 'rejected', 'blocked'] } } },
    { $sort: { ts: 1 } },
    { $group: { _id: '$word_id', to: { $first: '$to' }, ts: { $first: '$ts' } } },
  ]).toArray();
  const first = await query(
    `SELECT word_id, min(first_seen) AS first_seen FROM submissions WHERE word_id = ANY($1) GROUP BY word_id`,
    [decisions.map((d) => d._id)]);
  const firstSeen = new Map(first.map((r) => [r.word_id, r.first_seen]));
  const byOutcome = {};
  for (const d of decisions) {
    const start = firstSeen.get(d._id);
    if (!start) continue;   // 編輯直接加的詞沒有投稿
    (byOutcome[d.to] ??= []).push((d.ts - start) / 86_400_000);
  }
  const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  res.json({ rows: Object.entries(byOutcome).map(([outcome, days]) => {
    days.sort((a, b) => a - b);
    return { outcome, words: days.length, avg: days.reduce((a, b) => a + b, 0) / days.length,
             median: pct(days, 0.5), p90: pct(days, 0.9) };
  }).sort((a, b) => b.words - a.words) });
}));

/**
 * 5. 常在第 5 名之後才被選中的詞條（MongoDB ＋ PostgreSQL）
 * 使用者要翻頁才找得到：詞頻可能設太低，編輯可以考慮調高。
 * MongoDB 依詞條彙總 200 萬筆選字紀錄，再到 PostgreSQL 查詞與目前詞頻。
 * 單字的同音字本來就多，只看兩個字以上的詞。
 */
analytics.get('/analytics/late-picks', handle(async (req, res) => {
  const stats = await (await mongo()).collection('selection_events').aggregate([
    { $match: { entry_id: { $ne: null } } },
    { $group: { _id: '$entry_id', picks: { $sum: 1 }, late: { $sum: { $cond: [{ $gt: ['$rank', 5] }, 1, 0] } },
                avg_rank: { $avg: '$rank' } } },
    { $match: { picks: { $gte: 20 } } },
    { $set: { late_ratio: { $divide: ['$late', '$picks'] } } },
    { $sort: { late_ratio: -1, picks: -1 } },
    { $limit: 2000 },
  ], { allowDiskUse: true }).toArray();
  const entries = await query(
    `SELECT e.entry_id, w.text, e.bopomofo, e.frequency, e.status, e.row_version
       FROM lexicon_entries e JOIN words w USING (word_id)
      WHERE e.entry_id = ANY($1) AND char_length(w.text) >= 2`, [stats.map((s) => s._id)]);
  const byId = new Map(entries.map((e) => [e.entry_id, e]));
  res.json({ rows: stats.filter((s) => byId.has(s._id)).slice(0, 20).map((s) => ({
    ...byId.get(s._id), picks: s.picks, late: s.late, late_ratio: s.late_ratio, avg_rank: s.avg_rank })) });
}));

/**
 * 6. 各版新加入的詞，發布後被選用的情形（MongoDB ＋ PostgreSQL）
 * PostgreSQL 列出每個已發布版本新增的詞條，MongoDB 數這些詞條被選了幾次。
 * 用來判斷審核的眼光：收進來的詞真的有人用嗎？
 */
analytics.get('/analytics/adoption', handle(async (req, res) => {
  const added = await query(
    `SELECT c.entry_id, r.version, r.published_at, w.text
       FROM release_changes c JOIN releases r USING (release_id)
       JOIN lexicon_entries e USING (entry_id) JOIN words w USING (word_id)
      WHERE c.action = 'add' AND r.status = 'published'`);
  const counts = await (await mongo()).collection('selection_events').aggregate([
    { $match: { entry_id: { $in: added.map((a) => a.entry_id) } } },
    { $group: { _id: '$entry_id', picks: { $sum: 1 } } },
  ]).toArray();
  const picks = new Map(counts.map((c) => [c._id, c.picks]));
  const versions = new Map();
  for (const a of added) {
    const v = versions.get(a.version) ?? { version: a.version, published_at: a.published_at, words: 0, picks: 0, unused: 0, top: [] };
    const n = picks.get(a.entry_id) ?? 0;
    v.words += 1;
    v.picks += n;
    if (n === 0) v.unused += 1;
    v.top.push({ text: a.text, picks: n });
    versions.set(a.version, v);
  }
  res.json({ rows: [...versions.values()]
    .map((v) => ({ ...v, per_word: v.picks / v.words, top: v.top.sort((a, b) => b.picks - a.picks).slice(0, 5) }))
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at)) });
}));
