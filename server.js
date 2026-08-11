require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const collector = require('./collector');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const WEB_PASSWORD = process.env.WEB_PASSWORD || 'admin';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '10', 10); // 秒

// 采集状态
const state = {
  lastRunAt: null,
  lastError: null,
  lastResult: null,
  nextRunAt: null,
  authOk: true,
  running: false,
};

function sessionToken() {
  return crypto.createHash('sha256').update('nvt:' + WEB_PASSWORD).digest('hex');
}

function authMiddleware(req, res, next) {
  const tok = req.headers['x-auth-token'];
  if (tok === sessionToken()) return next();
  return res.status(401).json({ error: '需要口令' });
}

async function tick() {
  if (state.running) return;
  state.running = true;
  try {
    const r = await collector.runOnce();
    state.lastResult = r;
    state.lastRunAt = new Date().toISOString();
    state.lastError = null;
    state.authOk = true;
    state.nextRunAt = new Date(Date.now() + POLL_INTERVAL * 1000).toISOString();
  } catch (e) {
    state.lastError = e.message;
    state.lastRunAt = new Date().toISOString();
    if (e.message === 'AUTH_REQUIRED' || e.message === 'NO_COOKIE') state.authOk = false;
    state.nextRunAt = new Date(Date.now() + Math.max(15, POLL_INTERVAL) * 1000).toISOString();
  } finally {
    state.running = false;
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/current', authMiddleware, (req, res) => {
  const rows = db.getCurrent();
  const current = rows.map((r) => ({
    ...r,
    price_yuan: (r.price_cents / 100).toFixed(2),
  }));
  res.json({ products: current, updated_at: state.lastRunAt, auth_ok: state.authOk });
});

app.get('/api/history', authMiddleware, (req, res) => {
  const pid = req.query.product_id;
  if (!pid) return res.status(400).json({ error: '缺少 product_id' });
  res.json({ history: db.getHistory(pid) });
});

app.get('/api/events', authMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  res.json({ events: db.getEvents(limit) });
});

app.get('/api/status', authMiddleware, (req, res) => {
  res.json({
    ...state,
    cookie_loaded: !!collector.loadCookie(),
    poll_interval_seconds: POLL_INTERVAL,
  });
});

app.get('/api/board', authMiddleware, (req, res) => {
  const rows = db.getBoard();
  const board = rows.map((r) => ({
    ...r,
    min_yuan: (r.min_cents / 100).toFixed(2),
    median_yuan: (r.median_cents / 100).toFixed(2),
    max_yuan: (r.max_cents / 100).toFixed(2),
    avg_yuan: (r.avg_cents / 100).toFixed(2),
  }));
  res.json({ board, updated_at: state.lastRunAt, auth_ok: state.authOk });
});

app.get('/api/board/history', authMiddleware, (req, res) => {
  const plan = req.query.plan;
  if (!plan) return res.status(400).json({ error: '缺少 plan' });
  const window = req.query.window; // 小时，可选
  const from = req.query.from_ts;  // "YYYY-MM-DD HH:MM:SS" (UTC)，可选，与 to_ts 成对用于范围分页
  const to = req.query.to_ts;      // 同上
  const limit = req.query.limit;   // 范围查询时的单页上限
  let history;
  if (from || to) {
    history = db.getBoardHistoryRange(plan, from, to, limit);
  } else if (window) {
    history = db.getBoardHistorySince(plan, window);
  } else {
    history = db.getBoardHistory(plan);
  }
  res.json({ history });
});

app.get('/api/board/events', authMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  res.json({ events: db.getBoardEvents(limit) });
});

// 启动
app.listen(PORT, () => {
  console.log(`[server] 看板启动: http://localhost:${PORT}`);
  console.log(`[server] 口令: ${WEB_PASSWORD}`);
  tick();
  setInterval(tick, POLL_INTERVAL * 1000);
});
