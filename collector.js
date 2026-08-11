const db = require('./db');
const fs = require('fs');
const path = require('path');

const BASE = 'https://nvtokens.com';
const COOKIE_FILE = process.env.NVT_COOKIE_FILE || path.join(__dirname, 'session-cookie.txt');

// 读取 scm_session cookie（优先环境变量 NVT_COOKIE，其次文件）
function loadCookie() {
  if (process.env.NVT_COOKIE) {
    return process.env.NVT_COOKIE.trim();
  }
  try {
    const raw = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
    const value = raw.startsWith('scm_session=') ? raw.split('=').slice(1).join('=') : raw;
    return value;
  } catch {
    return null;
  }
}

// 可选代理（服务器直连时留空）
let proxyAgent = null;
if (process.env.PROXY) {
  try {
    const { ProxyAgent } = require('undici');
    proxyAgent = new ProxyAgent(process.env.PROXY);
  } catch {
    console.warn('[collector] 提示: 设置了 PROXY 但未安装 undici，将直连。本地开发请 npm i undici');
  }
}

async function nvtFetch(pathname) {
  const cookie = loadCookie();
  if (!cookie) throw new Error('NO_COOKIE');
  const res = await fetch(BASE + pathname, {
    headers: {
      cookie: 'scm_session=' + cookie,
      accept: 'application/json',
    },
    dispatcher: proxyAgent || undefined,
  });
  if (res.status === 401) throw new Error('AUTH_REQUIRED');
  if (res.status === 429) throw new Error('RATE_LIMITED');
  if (!res.ok) throw new Error('HTTP_' + res.status);
  return res.json();
}

async function fetchAllProducts() {
  const [self, supplier] = await Promise.all([
    nvtFetch('/api/self-products').catch((e) => {
      if (e.message === 'AUTH_REQUIRED' || e.message === 'NO_COOKIE') throw e;
      return { products: [] };
    }),
    nvtFetch('/api/supplier/products').catch((e) => {
      if (e.message === 'AUTH_REQUIRED' || e.message === 'NO_COOKIE') throw e;
      return { products: [] };
    }),
  ]);

  const marked = new Map();
  for (const p of self.products || []) marked.set(p.id, { ...p, source: 'self' });
  for (const p of supplier.products || []) {
    if (!marked.has(p.id)) marked.set(p.id, { ...p, source: 'supplier' });
  }
  return marked;
}

async function fetchPriceBoard() {
  const data = await nvtFetch('/api/pool/price-board');
  return data.board || {};
}

// 采集各 plan 的累计已售 sold_count 与最近成交时间 last_sold_at
// （从 merchant-rankings 聚合所有商家；sold_count 受商家排名变动影响不可做差分，
//  用 last_sold_at 的更新做「成交活跃度」更可靠）
async function fetchPlanSold() {
  const data = await nvtFetch('/api/merchant-rankings');
  const sold = {};
  const lastSoldAt = {};
  for (const r of data.rankings || []) {
    for (const [plan, stats] of Object.entries(r.sale_plan_stats || {})) {
      sold[plan] = (sold[plan] || 0) + (stats.sold_count || 0);
      if (stats.last_sold_at && (!lastSoldAt[plan] || stats.last_sold_at > lastSoldAt[plan])) {
        lastSoldAt[plan] = stats.last_sold_at;
      }
    }
  }
  return { sold, lastSoldAt };
}

async function runOnce() {
  const [marked, board, soldInfo] = await Promise.all([
    fetchAllProducts(),
    fetchPriceBoard().catch((e) => {
      if (e.message === 'AUTH_REQUIRED' || e.message === 'NO_COOKIE') throw e;
      return null;
    }),
    fetchPlanSold().catch((e) => {
      if (e.message === 'AUTH_REQUIRED' || e.message === 'NO_COOKIE') throw e;
      return { sold: {}, lastSoldAt: {} };
    }),
  ]);
  const productChanged = db.syncProducts([...marked.values()]);
  db.removeMissingProducts(new Set(marked.keys()));
  let boardChanged = 0;
  if (board && Array.isArray(board.plans)) {
    boardChanged = db.syncPriceBoard(board.plans, soldInfo.sold, soldInfo.lastSoldAt);
  }
  return { total: marked.size, changed: productChanged, boardChanged };
}

// 定期清理旧数据
setInterval(() => db.pruneHistory(parseInt(process.env.HISTORY_RETENTION_DAYS || '90', 10)), 3600 * 1000);

module.exports = { runOnce, loadCookie, nvtFetch, fetchAllProducts, fetchPriceBoard, fetchPlanSold };

if (require.main === module) {
  runOnce()
    .then((r) => {
      console.log(`[collect] total=${r.total} changed=${r.changed} boardChanged=${r.boardChanged}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error('[collect] FAIL', e.message);
      process.exit(1);
    });
}
