// 輕注音詞庫共享平台：一個 Express 伺服器同時提供 JSON API（/api）與網頁（public/）
import express from 'express';
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { account } from './routes/account.js';
import { input } from './routes/input.js';
import { lexicon } from './routes/lexicon.js';
import { candidates } from './routes/candidates.js';
import { review } from './routes/review.js';
import { me } from './routes/me.js';
import { reports } from './routes/reports.js';
import { analytics } from './routes/analytics.js';
import { admin } from './routes/admin.js';
import { errorHandler } from './errors.js';
import { pool } from './db.js';

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET ?? randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 },
}));

app.use('/api', account, input, lexicon, candidates, me, reports, analytics, admin);
app.use('/api', review);  // 以下全部需要編輯身分
app.use('/api', (req, res) => res.status(404).json({ error: '沒有這個 API' }));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.use(errorHandler);

// 待審列表的投稿統計每 10 分鐘重算一次（CONCURRENTLY：重算時不擋讀取）
setInterval(() => {
  pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY candidate_stats')
    .catch((e) => console.warn(`candidate_stats 更新失敗：${e.message}`));
}, 10 * 60 * 1000);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`輕注音詞庫共享平台：http://localhost:${port}`));
