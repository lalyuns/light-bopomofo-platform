// 輸入法用的 API：分享新詞（格式與輕注音現有的 /api/words 相同，輸入法不用改）、回傳選字紀錄
//   POST /api/words       {"device": "<uuid>", "app": "8.0", "platform": "macos", "words": [{"text", "typed", "count"}]}
//   POST /api/selections  {"device": "<uuid>", "app": "8.0", "platform": "macos",
//                          "events": [{"typed", "entry_id", "rank", "shown", "ts"}]}
import { Router } from 'express';
import { mongoDb, query } from '../db.js';
import { handle, HttpError } from '../errors.js';

export const input = Router();

// 匿名裝置的 UUID 可以隨便造：同一個 IP 每分鐘最多 30 次上傳。
// 本機（伺服器自己所在的機器）不限，bench/concurrency.mjs 才能一次送 100 個請求。
const recent = new Map();
function rateLimit(req) {
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip)) return;
  const now = Date.now();
  const hits = (recent.get(req.ip) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= 30) throw new HttpError(429, '上傳太頻繁，請稍後再試');
  recent.set(req.ip, [...hits, now]);
}

input.post('/words', handle(async (req, res) => {
  rateLimit(req);
  const { device, app, platform = 'macos', words } = req.body;
  if (!Array.isArray(words) || words.length > 500) throw new HttpError(400, 'words 必須是陣列，最多 500 個');
  if (!['macos', 'windows'].includes(platform)) throw new HttpError(400, 'platform 只能是 macos 或 windows');
  const [{ upload_words: result }] = await query(
    'SELECT upload_words($1, $2, $3, $4)', [device, platform, String(app ?? ''), JSON.stringify(words)]);
  res.json(result);
}));

// ---------- 選字紀錄（MongoDB 的 selection_events，計劃書附錄 B） ----------
// 只記被選中的詞條與名次，不記整句輸入。entry_id 是 null 表示選到詞庫沒有的詞，這時可以沒有 rank。
// ts 是選字的時間，沒給就用收到的時間。

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPED = /^[ㄅ-ㄩˉˊˇˋ˙]{1,60}$/;   // 與 submissions.typed 相同
const isPosition = (n) => Number.isInteger(n) && n >= 1 && n <= 1000;

/** 檢查一筆選字紀錄的格式；不合格回傳 null */
function parseSelection(event, now) {
  const { typed, entry_id: entryId = null, rank = null, shown, ts } = event ?? {};
  if (typeof typed !== 'string' || !TYPED.test(typed) || !isPosition(shown)) return null;
  if (entryId !== null && !(Number.isSafeInteger(entryId) && entryId > 0)) return null;
  // 選到詞庫裡的詞一定有名次；名次不超過看到的候選數
  if (rank === null ? entryId !== null : !(isPosition(rank) && rank <= shown)) return null;
  const at = ts == null ? now : new Date(ts);
  if (Number.isNaN(at.getTime()) || at - now > 5 * 60_000) return null;   // 容許裝置時鐘快 5 分鐘
  return { typed, entry_id: entryId, rank, shown, ts: at };
}

input.post('/selections', handle(async (req, res) => {
  rateLimit(req);
  const { device, app, platform = 'macos', events } = req.body;
  if (typeof device !== 'string' || !UUID.test(device)) throw new HttpError(400, 'device 必須是 UUID');
  if (typeof app !== 'string' || !app || app.length > 20) throw new HttpError(400, '請帶輸入法版本 app（最多 20 個字元）');
  if (!['macos', 'windows'].includes(platform)) throw new HttpError(400, 'platform 只能是 macos 或 windows');
  if (!Array.isArray(events) || events.length > 500) throw new HttpError(400, 'events 必須是陣列，最多 500 筆');

  const now = new Date();
  const parsed = events.map((e) => parseSelection(e, now)).filter(Boolean);
  // 詞條代號由後端到 PostgreSQL 確認存在；草稿版本裡的詞條輸入法還拿不到
  const ids = [...new Set(parsed.map((e) => e.entry_id).filter((id) => id !== null))];
  const known = new Set((await query(
    `SELECT entry_id FROM lexicon_entries WHERE entry_id = ANY($1::bigint[]) AND status <> 'staged'`, [ids]))
    .map((r) => r.entry_id));
  const docs = parsed
    .filter((e) => e.entry_id === null || known.has(e.entry_id))
    .map((e) => ({ device_id: device.toLowerCase(), app_version: app, ...e }));

  // 沿用上傳新詞的做法登記裝置、更新最後同步時間（空的詞清單）
  await query(`SELECT upload_words($1, $2, $3, '[]')`, [device, platform, app]);
  if (docs.length > 0) {
    try {
      await (await mongoDb()).collection('selection_events').insertMany(docs);
    } catch (e) {
      console.warn(`MongoDB selection_events 寫入失敗：${e.message}`);
      throw new HttpError(503, '紀錄暫時寫不進去，請稍後再傳');
    }
  }
  res.json({ accepted: docs.length, skipped: events.length - docs.length });
}));
