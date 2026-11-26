// ③ 我的：裝置、回報、個人詞、詞庫包訂閱；以及輸入法同步個人詞用的 API
import { Router } from 'express';
import { pool, query, transaction } from '../db.js';
import { requireUser } from '../auth.js';
import { handle, HttpError } from '../errors.js';

export const me = Router();

// 一個詞：1–20 個漢字（基本區、擴充 A、相容區、擴充 B 以後），與資料庫的 han_text 相同。
// 用 \u 跳脫寫碼位：直接貼相容區的字，可能被編輯器正規化成基本區的同形字，範圍就錯了。
const HAN_WORD = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{323AF}]{1,20}$/u;

// ---------- 輸入法同步個人詞（不用登入，用已綁定的裝置識別） ----------
/**
 * 裝置綁定的帳號。停權的帳號不能同步（R2）。
 * 已刪除的帳號照樣回傳，由各 API 決定：裝置還要取回刪除標記，但不能再寫入。
 * lock：寫入前用 'FOR SHARE OF u' 鎖住帳號，同時進行的停權、刪除要等這個交易結束。
 */
async function deviceOwner(db, deviceId, lock = '') {
  const { rows: [owner] } = await db.query(
    `SELECT u.user_id, u.status FROM devices d JOIN users u USING (user_id) WHERE d.device_id = $1 ${lock}`,
    [deviceId]);
  if (!owner) throw new HttpError(404, '這台裝置還沒綁定帳號');
  if (owner.status === 'suspended') throw new HttpError(403, '這個帳號已被停權');
  return owner;
}

// GET /api/devices/<uuid>/personal-words?since=<時間>：只回傳那之後有變動的（含刪除標記，R19）
// 帳號已刪除時 account_deleted 是 true，個人詞都帶刪除標記，裝置據此清掉本機資料。
me.get('/devices/:deviceId/personal-words', handle(async (req, res) => {
  const owner = await deviceOwner(pool, req.params.deviceId);
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(0);
  const words = await query(
    `SELECT w.text, p.bopomofo, p.status, p.updated_at
       FROM personal_words p JOIN words w USING (word_id)
      WHERE p.user_id = $1 AND p.updated_at > $2
      ORDER BY p.updated_at`, [owner.user_id, since]);   // personal_words_sync 索引
  // 多取一段時間：同步期間別的裝置剛好在改，下次還會拿到，由裝置端依主鍵去重
  res.json({ words, next_since: new Date(Date.now() - 60_000), account_deleted: owner.status === 'deleted' });
}));

// POST /api/devices/<uuid>/personal-words  {"words": [{"text", "bopomofo", "status": "active" | "deleted"}]}
// 輸入法把這台裝置上新增、刪除的個人詞上傳。以「使用者、詞、讀音」為單位（R19），後到的覆蓋先到的；
// 刪除只把 status 改成 deleted，其他裝置下次 GET 時就會拿到這個刪除標記。
// 格式不對的（含英數、注音不合法）略過，不讓整批失敗，與分享新詞的做法相同。
me.post('/devices/:deviceId/personal-words', handle(async (req, res) => {
  const { words } = req.body;
  if (!Array.isArray(words) || words.length > 500) throw new HttpError(400, 'words 必須是陣列，最多 500 個');
  // 只收格式正確的：詞 1–20 個漢字、讀音是以空格分隔的注音音節（與 words、personal_words 的 domain 相同）
  const valid = words
    .map((w) => ({ text: String(w?.text ?? '').trim(), bopomofo: String(w?.bopomofo ?? '').trim().replace(/\s+/g, ' '),
                   status: w?.status ?? 'active' }))
    .filter((w) => HAN_WORD.test(w.text)
      && /^[ㄅ-ㄩˊˇˋ˙]+( [ㄅ-ㄩˊˇˋ˙]+)*$/.test(w.bopomofo) && w.bopomofo.length <= 100
      && ['active', 'deleted'].includes(w.status));
  // 同一批裡同一個詞＋讀音出現多次，以最後一次為準
  const latest = [...new Map(valid.map((w) => [`${w.text} ${w.bopomofo}`, w])).values()];
  await transaction(async (db) => {
    const owner = await deviceOwner(db, req.params.deviceId, 'FOR SHARE OF u');
    if (owner.status === 'deleted') throw new HttpError(403, '這個帳號已刪除');
    await db.query(
      `INSERT INTO words (text) SELECT DISTINCT text FROM jsonb_to_recordset($1::jsonb) AS x(text text)
       ON CONFLICT DO NOTHING`, [JSON.stringify(latest)]);
    await db.query(
      `INSERT INTO personal_words (user_id, word_id, bopomofo, status)
       SELECT $1::bigint, w.word_id, x.bopomofo, x.status
         FROM jsonb_to_recordset($2::jsonb) AS x(text text, bopomofo text, status text)
         JOIN words w USING (text)
       ON CONFLICT (user_id, word_id, bopomofo) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
      [owner.user_id, JSON.stringify(latest)]);
    await db.query('UPDATE devices SET last_synced_at = greatest(last_synced_at, now()) WHERE device_id = $1',
      [req.params.deviceId]);
  });
  res.json({ accepted: valid.length, skipped: words.length - valid.length });
}));

// GET /api/devices/<uuid>/packs：這台裝置的帳號訂閱中、而且上架中的詞庫包，連同上線中的詞條一起下載。
// 詞庫包沒有修改時間，所以每次回傳完整內容；包被下架或取消訂閱，就不會出現在清單裡，輸入法據此移除。
me.get('/devices/:deviceId/packs', handle(async (req, res) => {
  // 已刪除帳號的訂閱都取消了，會拿到空清單，裝置據此移除詞庫包
  const owner = await deviceOwner(pool, req.params.deviceId);
  const packs = await query(
    `SELECT p.pack_id, p.name,
            coalesce(json_agg(json_build_object('text', w.text, 'bopomofo', e.bopomofo, 'frequency', e.frequency)
                              ORDER BY w.text) FILTER (WHERE e.entry_id IS NOT NULL), '[]') AS entries
       FROM subscriptions s
       JOIN packs p ON p.pack_id = s.pack_id AND p.status = 'published'
       LEFT JOIN pack_entries pe ON pe.pack_id = p.pack_id
       LEFT JOIN lexicon_entries e ON e.entry_id = pe.entry_id AND e.status = 'active'
       LEFT JOIN words w ON w.word_id = e.word_id
      WHERE s.user_id = $1 AND s.status = 'active'
      GROUP BY p.pack_id
      ORDER BY p.name`, [owner.user_id]);
  res.json({ packs });
}));

me.use('/me', requireUser);

// ---------- 網頁分享新詞 ----------
// 計劃書表一：網頁投稿視為平台為「網頁」的裝置。每個帳號最多一台網頁裝置（devices_one_web_per_user），
// 第一次投稿時建立、直接綁在這個帳號；之後跟輸入法一樣呼叫 upload_words()，規則（R4–R6）完全相同。
me.post('/me/submissions', handle(async (req, res) => {
  const text = String(req.body.text ?? '').trim();
  const typed = String(req.body.typed ?? '').replace(/\s+/g, '');
  if (!HAN_WORD.test(text)) throw new HttpError(400, '詞要是 1 到 20 個漢字，不能有英數或符號');
  if (!/^[ㄅ-ㄩˉˊˇˋ˙]{1,60}$/.test(typed)) throw new HttpError(400, '請輸入你打這個詞用的注音（首字或完整都可以）');
  const [inLexicon] = await query(
    `SELECT 1 FROM lexicon_entries e JOIN words w USING (word_id) WHERE w.text = $1 AND e.status = 'active'`, [text]);
  if (inLexicon) throw new HttpError(409, '詞庫裡已經有這個詞了');

  await query(
    `INSERT INTO devices (device_id, user_id, platform) VALUES (gen_random_uuid(), $1, 'web')
     ON CONFLICT (user_id) WHERE platform = 'web' DO NOTHING`, [req.user.user_id]);
  const [{ device_id: device }] = await query(
    `SELECT device_id FROM devices WHERE user_id = $1 AND platform = 'web'`, [req.user.user_id]);
  const [{ upload_words: result }] = await query(
    'SELECT upload_words($1, $2, NULL, $3)', [device, 'web', JSON.stringify([{ text, typed, count: 1 }])]);
  if (result.accepted === 0) throw new HttpError(409, '這個詞已被編輯封鎖，不再接受投稿');
  res.json(result);
}));

// ---------- 裝置 ----------
me.get('/me/devices', handle(async (req, res) => {
  res.json({ devices: await query(
    `SELECT d.device_id, d.platform, d.app_version, d.first_seen, d.last_synced_at,
            (SELECT count(*) FROM submissions s WHERE s.device_id = d.device_id) AS submissions
       FROM devices d WHERE d.user_id = $1 ORDER BY d.last_synced_at DESC`, [req.user.user_id]) });
}));

// 綁定：把匿名裝置歸到這個帳號（R3：一台裝置最多綁一個帳號）。原本的帳號已刪除的裝置也可以重新綁定
me.post('/me/devices', handle(async (req, res) => {
  const rows = await query(
    `UPDATE devices SET user_id = $1
      WHERE device_id = $2 AND platform <> 'web'
        AND (user_id IS NULL OR user_id IN (SELECT user_id FROM users WHERE status = 'deleted'))
     RETURNING device_id`,
    [req.user.user_id, String(req.body.device_id ?? '').trim()]);
  if (rows.length === 0) throw new HttpError(404, '找不到這台裝置，或它已經綁定其他帳號');
  res.json({ ok: true });
}));

me.delete('/me/devices/:deviceId', handle(async (req, res) => {
  await query(`UPDATE devices SET user_id = NULL WHERE device_id = $1 AND user_id = $2 AND platform <> 'web'`,
    [req.params.deviceId, req.user.user_id]);
  res.json({ ok: true });
}));

// ---------- 我的回報 ----------
me.get('/me/reports', handle(async (req, res) => {
  res.json({ reports: await query(
    `SELECT r.report_id, r.kind, r.note, r.status, r.created_at, r.handled_at, w.text, e.bopomofo, e.status AS entry_status
       FROM reports r JOIN lexicon_entries e USING (entry_id) JOIN words w USING (word_id)
      WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [req.user.user_id]) });
}));

// ---------- 個人詞 ----------
me.get('/me/personal-words', handle(async (req, res) => {
  res.json({ words: await query(
    `SELECT w.word_id, w.text, p.bopomofo, p.updated_at,
            EXISTS (SELECT 1 FROM lexicon_entries e WHERE e.word_id = p.word_id AND e.status = 'active') AS in_lexicon
       FROM personal_words p JOIN words w USING (word_id)
      WHERE p.user_id = $1 AND p.status = 'active' ORDER BY p.updated_at DESC`, [req.user.user_id]) });
}));

me.post('/me/personal-words', handle(async (req, res) => {
  const text = String(req.body.text ?? '').trim();
  const bopomofo = String(req.body.bopomofo ?? '').trim().replace(/\s+/g, ' ');
  await query('INSERT INTO words (text) VALUES ($1) ON CONFLICT DO NOTHING', [text]);
  // 刪掉過再加回來：同一筆改回 active（R19：以使用者、詞、讀音為單位不重複）
  await query(
    `INSERT INTO personal_words (user_id, word_id, bopomofo)
     SELECT $1, word_id, $3 FROM words WHERE text = $2
     ON CONFLICT (user_id, word_id, bopomofo) DO UPDATE SET status = 'active', updated_at = now()`,
    [req.user.user_id, text, bopomofo]);
  res.json({ ok: true });
}));

me.delete('/me/personal-words/:wordId', handle(async (req, res) => {
  await query(
    `UPDATE personal_words SET status = 'deleted', updated_at = now()
      WHERE user_id = $1 AND word_id = $2 AND bopomofo = $3`,
    [req.user.user_id, req.params.wordId, String(req.query.bopomofo ?? '')]);
  res.json({ ok: true });
}));

// ---------- 詞庫包 ----------
me.get('/me/packs', handle(async (req, res) => {
  res.json({ packs: await query(
    `SELECT p.pack_id, p.name, p.description,
            (SELECT count(*) FROM pack_entries pe WHERE pe.pack_id = p.pack_id) AS entries,
            (SELECT count(*) FROM subscriptions s WHERE s.pack_id = p.pack_id AND s.status = 'active') AS subscribers,
            coalesce(my.status = 'active', false) AS subscribed
       FROM packs p LEFT JOIN subscriptions my ON my.pack_id = p.pack_id AND my.user_id = $1
      WHERE p.status = 'published' OR my.status = 'active'
      ORDER BY subscribers DESC`, [req.user.user_id]) });
}));

me.post('/me/packs/:packId', handle(async (req, res) => {
  const status = req.body.subscribe ? 'active' : 'cancelled';
  // 重新訂閱時更新原本那一筆；只能訂上架中的詞庫包，由 trigger 檢查（R20）
  await query(
    `INSERT INTO subscriptions (user_id, pack_id, status) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, pack_id) DO UPDATE SET status = EXCLUDED.status, subscribed_at = now()`,
    [req.user.user_id, req.params.packId, status]);
  res.json({ ok: true });
}));
