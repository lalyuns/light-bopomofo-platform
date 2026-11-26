// ④ 審核台與 ⑤ 版本：只有編輯能用。會改到詞庫的動作都呼叫 03_functions.sql 的交易函式。
import { Router } from 'express';
import { mongoDb, query, record } from '../db.js';
import { requireEditor } from '../auth.js';
import { handle, HttpError } from '../errors.js';

export const review = Router();
review.use(requireEditor);

const one = async (sql, params) => (await query(sql, params))[0];

/** 審核歷程存進 MongoDB（word_reviews 只留最後一次決定） */
const history = (req, wordId, text, from, to) =>
  record('review_history', { word_id: Number(wordId), text, from, to, editor_id: req.user.user_id });

// ---------- 審核 ----------

review.get('/review/draft', handle(async (req, res) => {
  res.json({ draft: await one(
    `SELECT release_id, version, max_new_words, used_quota(release_id) AS used FROM releases WHERE status = 'draft'`) ?? null });
}));

/** 從單字的讀音組出可能的完整讀音，讓編輯不用手打注音 */
async function suggestReadings(text, typedFull) {
  const chars = [...text];
  const perChar = await Promise.all(chars.map((c) => query(
    `SELECT e.bopomofo FROM lexicon_entries e JOIN words w USING (word_id)
      WHERE w.text = $1 AND e.status = 'active' ORDER BY e.frequency DESC LIMIT 3`, [c])));
  if (perChar.some((r) => r.length === 0)) return [];
  let combos = [[]];
  for (const options of perChar) {
    const limit = chars.length > 5 ? 1 : options.length;
    combos = combos.flatMap((prefix) => options.slice(0, limit).map((o) => [...prefix, o.bopomofo]));
  }
  const toneless = (r) => r.replace(/[ˊˇˋ˙ ]/g, '');
  return combos.map((c) => c.join(' '))
    .sort((a, b) => (toneless(b) === typedFull) - (toneless(a) === typedFull))
    .slice(0, 6);
}

review.get('/review/:wordId', handle(async (req, res) => {
  const word = await one(
    `SELECT w.word_id, w.text, r.status, r.row_version, r.decided_at, u.display_name AS reviewer
       FROM words w JOIN word_reviews r USING (word_id) LEFT JOIN users u ON u.user_id = r.reviewer_id
      WHERE w.word_id = $1`, [req.params.wordId]);
  if (!word) throw new HttpError(404, '找不到這個詞的審核紀錄');
  const typed = await query(
    `SELECT typed, count(*) AS devices, sum(use_count) AS uses, min(first_seen) AS first_seen
       FROM submissions WHERE word_id = $1 GROUP BY typed ORDER BY devices DESC LIMIT 10`, [word.word_id]);
  const full = typed.map((t) => t.typed).find((t) => t.length > [...word.text].length) ?? '';
  const entries = await query(
    `SELECT e.entry_id, e.bopomofo, e.frequency, e.status FROM lexicon_entries e WHERE e.word_id = $1`, [word.word_id]);
  let past = [];
  try {
    past = await (await mongoDb()).collection('review_history')
      .find({ word_id: Number(word.word_id) }).sort({ ts: 1 }).toArray();
  } catch { /* MongoDB 沒開就不顯示歷程 */ }
  res.json({ word, typed, entries, history: past, suggestions: await suggestReadings(word.text, full) });
}));

// 加入：一個讀音占一個名額。兩位編輯搶最後一個名額，靠 approve_word 裡的 lock_draft() 排隊
review.post('/review/:wordId/approve', handle(async (req, res) => {
  const { row_version: rowVersion, readings } = req.body;
  if (!Array.isArray(readings) || readings.length === 0) throw new HttpError(400, '至少要有一個讀音');
  const { approve_word: version } = await one(
    'SELECT approve_word($1, $2, $3, $4)',
    [req.params.wordId, req.user.user_id, rowVersion, JSON.stringify(readings.map((r) => ({
      bopomofo: String(r.bopomofo).trim().replace(/\s+/g, ' '), frequency: Number(r.frequency) || 1000,
    })))]);
  const { text } = await one('SELECT text FROM words WHERE word_id = $1', [req.params.wordId]);
  history(req, req.params.wordId, text, 'pending', 'approved');
  res.json({ version });
}));

// 不收、封鎖、重新審核
review.post('/review/:wordId/decide', handle(async (req, res) => {
  const { row_version: rowVersion, status } = req.body;
  const before = await one(
    'SELECT r.status, w.text FROM word_reviews r JOIN words w USING (word_id) WHERE word_id = $1', [req.params.wordId]);
  await query('SELECT decide_word($1, $2, $3, $4)', [req.params.wordId, req.user.user_id, rowVersion, status]);
  history(req, req.params.wordId, before?.text, before?.status, status);
  res.json({ ok: true });
}));

// 撤回加入（只在草稿版本發布前）
review.post('/review/:wordId/withdraw', handle(async (req, res) => {
  await query('SELECT withdraw_word($1, $2, $3)', [req.params.wordId, req.user.user_id, req.body.row_version]);
  const { text } = await one('SELECT text FROM words WHERE word_id = $1', [req.params.wordId]);
  history(req, req.params.wordId, text, 'approved', 'pending');
  res.json({ ok: true });
}));

// ---------- 維護詞庫 ----------

review.post('/lexicon/:entryId/change', handle(async (req, res) => {
  const { action, new_frequency: freq, row_version: rowVersion } = req.body;
  await query('SELECT change_entry($1, $2, $3, $4, $5)',
    [req.params.entryId, req.user.user_id, rowVersion, action, freq ?? null]);
  res.json({ ok: true });
}));

// 新增讀音（或詞庫沒有的詞）：建立草稿中的詞條，占一個新詞名額。詞頻沒填用 1000
review.post('/lexicon', handle(async (req, res) => {
  const text = String(req.body.text ?? '').trim();
  const bopomofo = String(req.body.bopomofo ?? '').trim().replace(/\s+/g, ' ');
  const given = req.body.frequency;
  const frequency = given == null || given === '' ? 1000 : Number(given);
  if (!/^[ㄅ-ㄩˊˇˋ˙]+( [ㄅ-ㄩˊˇˋ˙]+)*$/.test(bopomofo) || bopomofo.length > 100) {
    throw new HttpError(400, '讀音要用注音符號與聲調，音節之間空一格');
  }
  if (!Number.isInteger(frequency) || frequency < 0 || frequency > 2147483647) {
    throw new HttpError(400, '詞頻要是 0 以上的整數');
  }
  // 同一詞的同一讀音只有一筆（R13），先查是為了給看得懂的訊息；同時新增仍由 UNIQUE 擋下
  const existing = await one(
    `SELECT 1 FROM lexicon_entries e JOIN words w USING (word_id) WHERE w.text = $1 AND e.bopomofo = $2`,
    [text, bopomofo]);
  if (existing) throw new HttpError(409, '這個讀音已經有詞條了（可能在草稿中或已停用）');
  const { add_entry: entryId } = await one('SELECT add_entry($1, $2, $3, $4)',
    [text, bopomofo, frequency, req.user.user_id]);
  res.json({ entry_id: entryId });
}));

// ---------- 版本 ----------

review.get('/releases', handle(async (req, res) => {
  res.json({ releases: await query(
    `SELECT r.release_id, r.version, r.status, r.max_new_words, r.published_at, r.note, u.display_name AS created_by,
            count(c.*) FILTER (WHERE c.action = 'add') AS added,
            count(c.*) FILTER (WHERE c.action = 'remove') AS removed,
            count(c.*) FILTER (WHERE c.action = 'reweight') AS reweighted
       FROM releases r JOIN users u ON u.user_id = r.created_by
       LEFT JOIN release_changes c USING (release_id)
      GROUP BY r.release_id, u.display_name
      ORDER BY version_key(r.version) DESC`) });
}));

review.get('/releases/:version', handle(async (req, res) => {
  const release = await one('SELECT release_id, version, status, max_new_words FROM releases WHERE version = $1',
    [req.params.version]);
  if (!release) throw new HttpError(404, '找不到這個版本');
  const changes = await query(
    `SELECT c.entry_id, c.action, c.old_frequency, c.new_frequency, w.word_id, w.text, e.bopomofo, e.status,
            s.name AS source, r.row_version AS review_row_version, r.status AS review_status,
            coalesce(rv.display_name, ed.display_name) AS editor
       FROM release_changes c
       JOIN lexicon_entries e USING (entry_id) JOIN words w USING (word_id) JOIN sources s USING (source_id)
       LEFT JOIN word_reviews r ON r.word_id = e.word_id
       LEFT JOIN users rv ON rv.user_id = r.reviewer_id AND c.action = 'add'
       LEFT JOIN users ed ON ed.user_id = e.updated_by
      WHERE c.release_id = $1
      ORDER BY c.action, w.text`, [release.release_id]);
  res.json({ release, changes });
}));

review.post('/releases', handle(async (req, res) => {
  const { version, max_new_words: max = 200, note } = req.body;
  const [release] = await query(
    `INSERT INTO releases (version, max_new_words, created_by, note) VALUES ($1, $2, $3, NULLIF($4, ''))
     RETURNING release_id, version`, [version, max, req.user.user_id, note ?? '']);
  res.json(release);
}));

review.post('/releases/publish', handle(async (req, res) => {
  const { publish_release: result } = await one('SELECT publish_release($1)', [req.user.user_id]);
  res.json(result);
}));
