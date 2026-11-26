// ⑧ 管理：只有編輯能用。詞庫包（建立、上架、下架、內容）與帳號（停權、解除停權）。
// 狀態能不能這樣變由 02_triggers.sql 的 packs_check、pack_entries_only_active 等 trigger 檢查，這裡不重複寫規則。
import { Router } from 'express';
import { query } from '../db.js';
import { requireEditor } from '../auth.js';
import { handle, HttpError } from '../errors.js';

export const admin = Router();
admin.use('/admin', requireEditor);

// ---------- 詞庫包 ----------

admin.get('/admin/packs', handle(async (req, res) => {
  res.json({ packs: await query(
    `SELECT p.pack_id, p.name, p.description, p.status, p.created_at, u.display_name AS owner,
            (SELECT count(*) FROM pack_entries pe WHERE pe.pack_id = p.pack_id) AS entries,
            (SELECT count(*) FROM subscriptions s WHERE s.pack_id = p.pack_id AND s.status = 'active') AS subscribers
       FROM packs p JOIN users u ON u.user_id = p.owner_id
      ORDER BY CASE p.status WHEN 'draft' THEN 0 WHEN 'published' THEN 1 ELSE 2 END, p.name`) });
}));

// 新詞庫包一律是草稿（trigger 檢查），建立者是目前的編輯
admin.post('/admin/packs', handle(async (req, res) => {
  const name = String(req.body.name ?? '').trim();
  if (!name || name.length > 30) throw new HttpError(400, '名稱要 1 到 30 個字');
  const [pack] = await query(
    `INSERT INTO packs (name, description, owner_id) VALUES ($1, NULLIF($2, ''), $3) RETURNING pack_id`,
    [name, String(req.body.description ?? '').trim(), req.user.user_id]);
  res.json(pack);
}));

// 上架（draft/archived → published）、下架（published → archived）；不合規定的變化由 packs_check 擋下
admin.post('/admin/packs/:packId/status', handle(async (req, res) => {
  const { status } = req.body;
  if (!['published', 'archived'].includes(status)) throw new HttpError(400, 'status 只能是 published 或 archived');
  const rows = await query('UPDATE packs SET status = $1 WHERE pack_id = $2 RETURNING pack_id', [status, req.params.packId]);
  if (rows.length === 0) throw new HttpError(404, '找不到這個詞庫包');
  res.json({ ok: true });
}));

// 只有草稿能刪（trigger 檢查），內容 ON DELETE CASCADE 一起刪掉
admin.delete('/admin/packs/:packId', handle(async (req, res) => {
  const rows = await query('DELETE FROM packs WHERE pack_id = $1 RETURNING pack_id', [req.params.packId]);
  if (rows.length === 0) throw new HttpError(404, '找不到這個詞庫包');
  res.json({ ok: true });
}));

admin.get('/admin/packs/:packId/entries', handle(async (req, res) => {
  res.json({ entries: await query(
    `SELECT e.entry_id, w.text, e.bopomofo, e.frequency, e.status
       FROM pack_entries pe JOIN lexicon_entries e USING (entry_id) JOIN words w USING (word_id)
      WHERE pe.pack_id = $1
      ORDER BY w.text`, [req.params.packId]) });
}));

// 只能放上線中的詞條（R21，trigger 檢查）；已經在包裡就略過
admin.post('/admin/packs/:packId/entries', handle(async (req, res) => {
  if (!Number.isInteger(Number(req.body.entry_id))) throw new HttpError(400, '請指定要加入的詞條');
  const rows = await query(
    `INSERT INTO pack_entries (pack_id, entry_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING entry_id`,
    [req.params.packId, req.body.entry_id]);
  res.json({ added: rows.length });
}));

admin.delete('/admin/packs/:packId/entries/:entryId', handle(async (req, res) => {
  await query('DELETE FROM pack_entries WHERE pack_id = $1 AND entry_id = $2', [req.params.packId, req.params.entryId]);
  res.json({ ok: true });
}));

// ---------- 帳號 ----------

// 依 email 或顯示名稱找帳號；附上投票數，方便判斷是不是洗票帳號
admin.get('/admin/users', handle(async (req, res) => {
  const q = String(req.query.q ?? '').trim().replace(/[\\%_]/g, '\\$&');
  res.json({ users: await query(
    `SELECT u.user_id, u.email, u.display_name, u.role, u.status, u.created_at,
            (SELECT count(*) FROM votes v WHERE v.user_id = u.user_id) AS votes,
            (SELECT count(*) FROM devices d WHERE d.user_id = u.user_id) AS devices,
            (SELECT count(*) FROM reports r WHERE r.user_id = u.user_id) AS reports
       FROM users u
      WHERE u.status <> 'deleted'
        AND ($1 = '' OR u.email LIKE '%' || lower($1) || '%' OR u.display_name LIKE '%' || $1 || '%')
      ORDER BY votes DESC, u.user_id
      LIMIT 50`, [q]) });
}));

// 停權／解除停權。停權的帳號不能登入、投票、回報，票也不計入排序（R2：見 candidates.js、auth.js）。
// 已刪除的帳號不能復原；也不能停權自己，免得最後一位編輯把自己鎖在外面。
admin.post('/admin/users/:userId/status', handle(async (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) throw new HttpError(400, 'status 只能是 active 或 suspended');
  if (Number(req.params.userId) === req.user.user_id) throw new HttpError(400, '不能停權自己');
  const rows = await query(
    `UPDATE users SET status = $1 WHERE user_id = $2 AND status <> 'deleted' RETURNING user_id`,
    [status, req.params.userId]);
  if (rows.length === 0) throw new HttpError(404, '找不到這個帳號，或它已被刪除');
  res.json({ ok: true });
}));
