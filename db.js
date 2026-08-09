const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type_code     TEXT DEFAULT '',
  type_name     TEXT DEFAULT '',
  supplier_name TEXT DEFAULT '',
  price_cents   INTEGER NOT NULL DEFAULT 0,
  available_count INTEGER NOT NULL DEFAULT 0,
  sold_count    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  source        TEXT NOT NULL DEFAULT 'self',
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    TEXT NOT NULL,
  price_cents   INTEGER NOT NULL,
  available_count INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  captured_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_history_product ON price_history(product_id, captured_at);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL,
  from_value TEXT DEFAULT '',
  to_value   TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(created_at DESC);

CREATE TABLE IF NOT EXISTS price_board (
  plan            TEXT PRIMARY KEY,
  available       INTEGER NOT NULL DEFAULT 0,
  inventory_label TEXT NOT NULL DEFAULT '',
  inventory_level TEXT NOT NULL DEFAULT '',
  min_cents       INTEGER NOT NULL DEFAULT 0,
  p25_cents       INTEGER NOT NULL DEFAULT 0,
  median_cents    INTEGER NOT NULL DEFAULT 0,
  p75_cents       INTEGER NOT NULL DEFAULT 0,
  max_cents       INTEGER NOT NULL DEFAULT 0,
  avg_cents       INTEGER NOT NULL DEFAULT 0,
  token_count     INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS board_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plan        TEXT NOT NULL,
  min_cents   INTEGER NOT NULL DEFAULT 0,
  median_cents INTEGER NOT NULL DEFAULT 0,
  max_cents   INTEGER NOT NULL DEFAULT 0,
  avg_cents   INTEGER NOT NULL DEFAULT 0,
  available   INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_board_history ON board_history(plan, captured_at);

CREATE TABLE IF NOT EXISTS board_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plan        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  from_value  TEXT DEFAULT '',
  to_value    TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_board_events ON board_events(created_at DESC);
`);

const upsertProduct = db.prepare(`
  INSERT INTO products (id, name, type_code, type_name, supplier_name, price_cents,
                        available_count, sold_count, status, source, updated_at)
  VALUES (@id, @name, @type_code, @type_name, @supplier_name, @price_cents,
          @available_count, @sold_count, @status, @source, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, type_code=excluded.type_code, type_name=excluded.type_name,
    supplier_name=excluded.supplier_name, price_cents=excluded.price_cents,
    available_count=excluded.available_count, sold_count=excluded.sold_count,
    status=excluded.status, source=excluded.source, updated_at=datetime('now')
`);

const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
const insertHistory = db.prepare(`
  INSERT INTO price_history (product_id, price_cents, available_count, status) VALUES (?, ?, ?, ?)
`);
const insertEvent = db.prepare(`
  INSERT INTO events (product_id, product_name, kind, from_value, to_value) VALUES (?, ?, ?, ?, ?)
`);

const lastHistoryFor = db.prepare(
  'SELECT price_cents, available_count, status FROM price_history WHERE product_id = ? ORDER BY id DESC LIMIT 1'
);

function getEventKind(prev, cur) {
  if (!prev) return 'new';
  if (prev.status !== cur.status) return 'status_change';
  if (prev.price_cents !== cur.price_cents) return 'price_change';
  if (prev.available_count !== cur.available_count) return 'stock_change';
  return null;
}

// 合并商品：以 id 去重，self-products 优先（信息更全）
function syncProducts(rawProducts) {
  const merged = new Map();
  for (const p of rawProducts) {
    if (!p || !p.id) continue;
    merged.set(p.id, p);
  }
  const now = new Date().toISOString();
  const tx = db.transaction((list) => {
    let changed = 0;
    for (const p of list) {
      const row = {
        id: p.id,
        name: p.name || '未命名',
        type_code: p.type_code || '',
        type_name: p.type_name || '',
        supplier_name: p.supplier_name || '',
        price_cents: Number(p.price_cents) || 0,
        available_count: Number(p.available_count) || 0,
        sold_count: Number(p.sold_count) || 0,
        status: p.status || 'active',
        source: p.source || 'self',
      };
      const prev = getProduct.get(p.id);
      upsertProduct.run(row);
      insertHistory.run(row.id, row.price_cents, row.available_count, row.status);
      const kind = getEventKind(prev, {
        status: row.status,
        price_cents: row.price_cents,
        available_count: row.available_count,
      });
      if (kind) {
        changed++;
        insertEvent.run(
          row.id,
          row.name,
          kind,
          JSON.stringify({ price_cents: prev?.price_cents ?? null, available_count: prev?.available_count ?? null, status: prev?.status ?? null }),
          JSON.stringify({ price_cents: row.price_cents, available_count: row.available_count, status: row.status })
        );
      }
    }
    return changed;
  });
  return tx(Array.from(merged.values()));
}

// 删除不再出现的商品（下架/移除）
function removeMissingProducts(activeIds) {
  const all = db.prepare('SELECT id, name FROM products').all();
  const tx = db.transaction((ids) => {
    for (const p of all) {
      if (!ids.has(p.id)) {
        insertEvent.run(p.id, p.name, 'removed', '', '');
        db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
      }
    }
  });
  tx(activeIds);
}

function getCurrent() {
  return db.prepare('SELECT * FROM products ORDER BY name').all();
}

function getHistory(productId, limit = 500) {
  return db.prepare(
    'SELECT price_cents, available_count, status, captured_at FROM price_history WHERE product_id = ? ORDER BY id DESC LIMIT ?'
  ).all(productId, limit).reverse();
}

function getEvents(limit = 50) {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
}

function getLastCapture() {
  const row = db.prepare('SELECT MAX(captured_at) AS last FROM price_history').get();
  return row ? row.last : null;
}

function pruneHistory(days = 90) {
  db.prepare("DELETE FROM price_history WHERE captured_at < datetime('now', ?)").run('-' + days + ' days');
  db.prepare("DELETE FROM events WHERE created_at < datetime('now', ?)").run('-' + days + ' days');
  db.prepare("DELETE FROM board_history WHERE captured_at < datetime('now', ?)").run('-' + days + ' days');
  db.prepare("DELETE FROM board_events WHERE created_at < datetime('now', ?)").run('-' + days + ' days');
}

// ---------- price-board ----------
const upsertBoard = db.prepare(`
  INSERT INTO price_board (plan, available, inventory_label, inventory_level, min_cents, p25_cents,
                           median_cents, p75_cents, max_cents, avg_cents, token_count, updated_at)
  VALUES (@plan, @available, @inventory_label, @inventory_level, @min_cents, @p25_cents,
          @median_cents, @p75_cents, @max_cents, @avg_cents, @token_count, datetime('now'))
  ON CONFLICT(plan) DO UPDATE SET
    available=excluded.available, inventory_label=excluded.inventory_label,
    inventory_level=excluded.inventory_level, min_cents=excluded.min_cents,
    p25_cents=excluded.p25_cents, median_cents=excluded.median_cents,
    p75_cents=excluded.p75_cents, max_cents=excluded.max_cents,
    avg_cents=excluded.avg_cents, token_count=excluded.token_count, updated_at=datetime('now')
`);
const getBoardPlan = db.prepare('SELECT * FROM price_board WHERE plan = ?');
const insertBoardHistory = db.prepare(
  'INSERT INTO board_history (plan, min_cents, median_cents, max_cents, avg_cents, available) VALUES (?, ?, ?, ?, ?, ?)'
);
const insertBoardEvent = db.prepare(
  'INSERT INTO board_events (plan, kind, from_value, to_value) VALUES (?, ?, ?, ?)'
);

// 同步价格面板：写当前态 + 时序 + 变更事件
function syncPriceBoard(plans) {
  const tx = db.transaction((list) => {
    let changed = 0;
    for (const p of list) {
      if (!p || !p.plan) continue;
      const row = {
        plan: p.plan,
        available: p.available ? 1 : 0,
        inventory_label: p.inventory_label || '',
        inventory_level: p.inventory_level || '',
        min_cents: Number(p.min_cents) || 0,
        p25_cents: Number(p.p25_cents) || 0,
        median_cents: Number(p.median_cents) || 0,
        p75_cents: Number(p.p75_cents) || 0,
        max_cents: Number(p.max_cents) || 0,
        avg_cents: Number(p.avg_cents) || 0,
        token_count: Number(p.inventory_token_count) || 0,
      };
      const prev = getBoardPlan.get(p.plan);
      upsertBoard.run(row);
      insertBoardHistory.run(row.plan, row.min_cents, row.median_cents, row.max_cents, row.avg_cents, row.available);

      const prevAvail = prev ? !!prev.available : null;
      const prevMedian = prev ? prev.median_cents : null;
      const prevMin = prev ? prev.min_cents : null;
      if (prevAvail === null) {
        // 首次见到，只记录（不视为变更事件刷屏）
        continue;
      }
      const availChanged = prevAvail !== !!row.available;
      const medianChanged = prevMedian !== row.median_cents;
      const minChanged = prevMin !== row.min_cents;
      if (availChanged || medianChanged || minChanged) {
        changed++;
        insertBoardEvent.run(
          row.plan,
          availChanged ? 'availability' : 'price',
          JSON.stringify({ available: prevAvail, median_cents: prevMedian, min_cents: prevMin }),
          JSON.stringify({ available: !!row.available, median_cents: row.median_cents, min_cents: row.min_cents })
        );
      }
    }
    return changed;
  });
  return tx(plans);
}

function getBoard() {
  return db.prepare('SELECT * FROM price_board ORDER BY CASE plan WHEN \'plus\' THEN 0 WHEN \'free\' THEN 1 WHEN \'team\' THEN 2 WHEN \'bugteam\' THEN 3 WHEN \'k12\' THEN 4 ELSE 5 END').all();
}

function getBoardHistory(plan, limit = 500) {
  return db.prepare(
    'SELECT min_cents, median_cents, max_cents, avg_cents, available, captured_at FROM board_history WHERE plan = ? ORDER BY id DESC LIMIT ?'
  ).all(plan, limit).reverse();
}

// 按小时窗口返回最近数据（hours 为整数，如 6 = 最近 6 小时；内部用 SQLite datetime 计算，避免 ISO 格式不匹配）
function getBoardHistorySince(plan, hours, limit = 2000) {
  const h = Math.max(1, Math.min(parseInt(hours, 10) || 6, 24 * 30));
  return db.prepare(
    `SELECT min_cents, median_cents, max_cents, avg_cents, available, captured_at
     FROM board_history WHERE plan = ? AND captured_at >= datetime('now', ?) ORDER BY id ASC LIMIT ?`
  ).all(plan, '-' + h + ' hours', limit);
}

function getBoardEvents(limit = 50) {
  return db.prepare('SELECT * FROM board_events ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  db,
  syncProducts,
  removeMissingProducts,
  getCurrent,
  getHistory,
  getEvents,
  getLastCapture,
  pruneHistory,
  lastHistoryFor,
  syncPriceBoard,
  getBoard,
  getBoardHistory,
  getBoardHistorySince,
  getBoardEvents,
};
