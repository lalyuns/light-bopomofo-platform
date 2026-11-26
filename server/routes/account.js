// 帳號：註冊、登入、登出、目前的使用者
import { Router } from 'express';
import { query, transaction } from '../db.js';
import { checkPassword, currentUser, hashPassword, requireUser } from '../auth.js';
import { handle, HttpError } from '../errors.js';

export const account = Router();

account.get('/me', handle(async (req, res) => {
  res.json({ user: await currentUser(req) });
}));

account.post('/login', handle(async (req, res) => {
  const { email, password } = req.body;
  const [user] = await query(
    `SELECT user_id, password_hash, status FROM users WHERE email = lower($1)`, [email ?? '']);
  if (!user || !checkPassword(String(password ?? ''), user.password_hash)) {
    throw new HttpError(401, '帳號或密碼錯誤');
  }
  if (user.status !== 'active') throw new HttpError(403, '這個帳號已被停權');
  req.session.userId = user.user_id;
  res.json({ user: await currentUser(req) });
}));

account.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

account.post('/register', handle(async (req, res) => {
  const { email, password, display_name: name } = req.body;
  if (!email || !password || String(password).length < 8) {
    throw new HttpError(400, '請填寫 email，密碼至少 8 個字元');
  }
  const [user] = await query(
    `INSERT INTO users (email, password_hash, display_name) VALUES (lower($1), $2, $3) RETURNING user_id`,
    [email, hashPassword(String(password)), name || String(email).split('@')[0].slice(0, 30)]);
  req.session.userId = user.user_id;
  res.json({ user: await currentUser(req) });
}));

// 刪除自己的帳號（計劃書第 2、4.6 節）：不真的刪除那一列，因為投票、回報、審核紀錄都參照它。
//  - 狀態改成 deleted，清空 email 與顯示名稱（users 的 CHECK 只在 deleted 時允許 NULL），密碼換成無法登入的值
//  - 個人詞標成刪除、訂閱取消，裝置下次同步時就會清掉
//  - 裝置保留綁定：解除的話裝置就取不到刪除標記。之後可以改綁到別的帳號（me.js）；過去的投稿留在裝置上
//  - 投票保留，但帳號不是 active，不會再計入排序（R2）
// 三個更新在同一個交易裡做完，任何一步失敗就全部回復。
account.post('/me/delete', requireUser, handle(async (req, res) => {
  const [row] = await query('SELECT password_hash FROM users WHERE user_id = $1', [req.user.user_id]);
  if (!checkPassword(String(req.body.password ?? ''), row.password_hash)) {
    throw new HttpError(401, '密碼錯誤');
  }
  await transaction(async (db) => {
    await db.query(
      `UPDATE users SET status = 'deleted', email = NULL, display_name = NULL, password_hash = 'deleted'
        WHERE user_id = $1`, [req.user.user_id]);
    await db.query(
      `UPDATE personal_words SET status = 'deleted', updated_at = now() WHERE user_id = $1 AND status = 'active'`,
      [req.user.user_id]);
    await db.query(
      `UPDATE subscriptions SET status = 'cancelled' WHERE user_id = $1 AND status = 'active'`, [req.user.user_id]);
  });
  req.session.destroy(() => res.json({ ok: true }));
}));
