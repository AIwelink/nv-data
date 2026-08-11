const TOKEN_KEY = 'nvt_web_token';

let token = localStorage.getItem(TOKEN_KEY) || null;
let productsCache = [];
let sparkCharts = {};

const $ = (s) => document.querySelector(s);

function setAuth(t) {
  token = t;
  localStorage.setItem(TOKEN_KEY, t);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), 'x-auth-token': token },
  });
  if (res.status === 401) {
    // 区分“口令错”和“token 过期”
    throw { api401: true, res };
  }
  return res.json();
}

// 与后端一致的哈希算法（sha256("nvt:" + password)）
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('nvt:' + s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fmtYuan(cents) {
  return '¥' + (cents / 100).toFixed(2);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.includes('T') ? '' : 'Z'));
  if (isNaN(d)) return iso;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ---- 登录 ----
async function submitPass() {
  const v = $('#pass-input').value.trim();
  if (!v) return;
  const hashed = await sha256hex(v);
  setAuth(hashed);
  try {
    await api('/api/current');
    $('#login-box').style.display = 'none';
    $('#dashboard').style.display = 'block';
    start();
  } catch {
    $('#login-err').style.display = 'block';
    localStorage.removeItem(TOKEN_KEY);
  }
}
$('#pass-btn').addEventListener('click', submitPass);
$('#pass-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPass(); });

// ---- 价格面板 ----
const PLAN_LABELS = { plus: 'Plus', pro: 'Pro', team: 'Team', bugteam: 'Bug Team', k12: 'K12', free: 'Free', grokfree: 'Grok Free', grokpro: 'Grok Pro' };
let boardCache = [];

function renderBoard(board) {
  const grid = $('#board-grid');
  grid.innerHTML = '';
  if (!board.length) {
    grid.innerHTML = '<div class="empty">暂无价格面板数据</div>';
    return;
  }
  const prev = new Map(boardCache.map((p) => [p.plan, p.median_cents]));
  for (const p of board) {
    const lvlLabel = p.inventory_label || (p.available ? '有现货' : '无现货');
    const lvlClass = p.inventory_level || (p.available ? 'high' : 'none');
    const old = prev.get(p.plan);
    let trend = '';
    if (old !== undefined && p.available) {
      if (p.median_cents > old) trend = '<div class="trend up">▲ 较上次 +' + fmtYuan(p.median_cents - old) + '</div>';
      else if (p.median_cents < old) trend = '<div class="trend down">▼ 较上次 -' + fmtYuan(old - p.median_cents) + '</div>';
    }
    const el = document.createElement('div');
    el.className = 'plan-card';
    el.innerHTML = `
      <div class="plan-head">
        <span class="plan-name">${PLAN_LABELS[p.plan] || p.plan}<span class="fmt">${p.plan}</span></span>
        <span class="lvl-badge ${lvlClass}">${escapeHtml(lvlLabel)}</span>
      </div>
      <div class="big-price">${p.available ? '<span class="from">最低 </span>' + fmtYuan(p.min_cents) : '暂无现货'}</div>
      <div class="price-stats">
        <span>中位 <b>${p.available ? fmtYuan(p.median_cents) : '—'}</b></span>
        <span>最高 <b>${p.available ? fmtYuan(p.max_cents) : '—'}</b></span>
        <span>平均 <b>${p.available ? fmtYuan(p.avg_cents) : '—'}</b></span>
        <span>库存token <b>${p.token_count}</b></span>
      </div>
      ${trend}
    `;
    el.addEventListener('click', () => openBoardModal(p));
    grid.appendChild(el);
  }
  boardCache = board;
}

let boardModalChart = null;
function openBoardModal(p) {
  $('#modal-title').textContent = (PLAN_LABELS[p.plan] || p.plan) + ' 价格走势';
  $('#modal-sub').textContent = '中位价 ' + (p.available ? fmtYuan(p.median_cents) : '—') + ' · 最低 ' + (p.available ? fmtYuan(p.min_cents) : '—') + ' · 最高 ' + (p.available ? fmtYuan(p.max_cents) : '—');
  $('#modal').classList.add('show');
  fetch('/api/board/history?plan=' + encodeURIComponent(p.plan), { headers: { 'x-auth-token': token } })
    .then((r) => r.json())
    .then((d) => {
      const hist = d.history || [];
      if (boardModalChart) boardModalChart.destroy();
      const ctx = $('#modal-chart').getContext('2d');
      boardModalChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: hist.map((h) => fmtTime(h.captured_at)),
          datasets: [
            {
              label: '中位价(¥)',
              data: hist.map((h) => h.median_cents / 100),
              borderColor: '#0d9488',
              backgroundColor: 'rgba(13,148,136,.08)',
              fill: true,
              borderWidth: 2,
              pointRadius: 2,
              tension: 0.3,
            },
            {
              label: '最低价(¥)',
              data: hist.map((h) => h.min_cents / 100),
              borderColor: '#dc2626',
              borderWidth: 1.5,
              pointRadius: 0,
              tension: 0.3,
              borderDash: [4, 3],
            },
            {
              label: '最高价(¥)',
              data: hist.map((h) => h.max_cents / 100),
              borderColor: '#2563eb',
              borderWidth: 1.5,
              pointRadius: 0,
              tension: 0.3,
              borderDash: [4, 3],
            },
          ],
        },
        options: {
          responsive: true,
          plugins: { legend: { position: 'top' } },
          scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { beginAtZero: false } },
        },
      });
    });
}

// ---- 渲染 ----
function renderGrid(products) {
  const grid = $('#grid');
  grid.innerHTML = '';
  if (!products.length) {
    grid.innerHTML = '<div class="empty">暂无商品数据</div>';
    return;
  }
  for (const p of products) {
    const el = document.createElement('div');
    el.className = 'card';
    const badge = p.status === 'active'
      ? '<span class="badge active">在售</span>'
      : '<span class="badge inactive">下架</span>';
    const tag = p._changed === 'new' ? '<span class="changed-tag new">新</span>'
      : p._changed === 'down' ? '<span class="changed-tag down">▼ 降价</span>'
      : p._changed === 'up' ? '<span class="changed-tag up">▲ 涨价</span>'
      : '';
    el.innerHTML = `
      <div class="name"><span>${escapeHtml(p.name)}</span>${badge}</div>
      <div class="type">${escapeHtml(p.type_name || '')} · ${escapeHtml(p.supplier_name || '')}</div>
      <div class="price ${p._changed === 'down' ? 'down' : p._changed === 'up' ? 'up' : ''}">${fmtYuan(p.price_cents)}</div>
      <div class="meta">
        <span>库存 ${p.available_count}</span>
        <span>已售 ${p.sold_count}</span>
      </div>
      <div class="spark-wrap"><canvas class="spark" data-id="${p.id}"></canvas></div>
      ${tag}
    `;
    el.addEventListener('click', () => openModal(p));
    grid.appendChild(el);
  }
  drawSparks(products);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function drawSparks(products) {
  for (const p of products) {
    const canvas = document.querySelector(`.card canvas[data-id="${CSS.escape(p.id)}"]`);
    if (!canvas) continue;
    if (sparkCharts[p.id]) sparkCharts[p.id].destroy();
    // 用价格历史画迷你线
    fetchHistory(p.id).then((history) => {
      if (!history || history.length < 2) return;
      const el = document.querySelector(`.card canvas[data-id="${CSS.escape(p.id)}"]`);
      if (!el) return;
      const ctx = el.getContext('2d');
      sparkCharts[p.id] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: history.map((h) => h.captured_at),
          datasets: [{
            data: history.map((h) => h.price_cents / 100),
            borderColor: '#0d9488',
            backgroundColor: 'rgba(13,148,136,.08)',
            fill: true,
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } },
        },
      });
    });
  }
}

async function fetchHistory(productId) {
  try {
    const r = await api('/api/history?product_id=' + encodeURIComponent(productId));
    return r.history || [];
  } catch { return []; }
}

function renderEvents(events) {
  const box = $('#events');
  box.innerHTML = '';
  if (!events.length) {
    box.innerHTML = '<div class="empty">暂无变更记录</div>';
    return;
  }
  const tagMap = {
    price_change: '价格', stock_change: '库存', status_change: '状态',
    new: '新上架', removed: '下架',
    board_price: '面板价', board_availability: '现货',
  };
  for (const e of events) {
    let detail;
    if (e.kind === 'board_price' || e.kind === 'board_availability') {
      const f = JSON.parse(e.from_value || '{}');
      const t = JSON.parse(e.to_value || '{}');
      if (e.kind === 'board_availability') {
        detail = `${PLAN_LABELS[e.plan] || e.plan} 现货 ${f.available ? '有' : '无'} → ${t.available ? '有' : '无'}`;
      } else {
        detail = `${PLAN_LABELS[e.plan] || e.plan} 中位价 ${f.median_cents != null ? fmtYuan(f.median_cents) : '—'} → ${fmtYuan(t.median_cents)}`;
      }
    } else if (e.kind === 'price_change') {
      const f = JSON.parse(e.from_value || '{}');
      const t = JSON.parse(e.to_value || '{}');
      detail = `${fmtYuan(f.price_cents)} → ${fmtYuan(t.price_cents)}`;
    } else if (e.kind === 'stock_change') {
      const f = JSON.parse(e.from_value || '{}');
      const t = JSON.parse(e.to_value || '{}');
      detail = `库存 ${f.available_count} → ${t.available_count}`;
    } else if (e.kind === 'status_change') {
      const t = JSON.parse(e.to_value || '{}');
      detail = `状态 → ${t.status === 'active' ? '在售' : '下架'}`;
    } else if (e.kind === 'new') {
      detail = '上架';
    } else {
      detail = '已下架/移除';
    }
    const el = document.createElement('div');
    el.className = 'event';
    el.innerHTML = `
      <span class="tag ${e.kind}">${tagMap[e.kind] || e.kind}</span>
      <span class="detail">${escapeHtml(detail)}</span>
      <span class="time">${fmtTime(e.created_at)}</span>
    `;
    box.appendChild(el);
  }
}

// ---- 状态栏 ----
function renderStatus(st) {
  const dot = $('#collect-dot');
  const text = $('#collect-status');
  const last = $('#last-update');
  if (st.auth_ok === false) {
    dot.className = 'dot dead';
    text.textContent = '会话失效';
    $('#banner').classList.add('show');
    $('#banner').textContent = '⚠ nvtokens 登录会话已失效，请在服务器上重新刷新 cookie（node refresh-cookie.js）';
  } else if (st.lastError) {
    dot.className = 'dot err';
    text.textContent = '采集异常';
  } else if (st.lastRunAt) {
    dot.className = 'dot ok';
    text.textContent = '正常';
  } else {
    dot.className = 'dot';
    text.textContent = '初始化中';
  }
  if (st.lastRunAt) last.textContent = '· 更新于 ' + fmtTime(st.lastRunAt);
}

// ---- 汇总加载 ----
async function refresh() {
  try {
    const [r, br, st] = await Promise.all([
      api('/api/current'),
      api('/api/board').catch(() => ({ board: [] })),
      api('/api/status').catch(() => ({})),
    ]);
    const prev = new Map(productsCache.map((p) => [p.id, p.price_cents]));
    for (const p of r.products) {
      const old = prev.get(p.id);
      if (old === undefined) p._changed = 'new';
      else if (p.price_cents > old) p._changed = 'up';
      else if (p.price_cents < old) p._changed = 'down';
      else p._changed = null;
    }
    productsCache = r.products;
    renderGrid(r.products);
    renderBoard(br.board || []);
    renderStatus(st);
  } catch (e) {
    if (e && e.api401) {
      localStorage.removeItem(TOKEN_KEY);
      $('#dashboard').style.display = 'none';
      $('#login-box').style.display = 'block';
      $('#login-err').textContent = '口令已失效，请重新输入';
      $('#login-err').style.display = 'block';
    }
  }
}

async function refreshEvents() {
  try {
    const [r, br] = await Promise.all([
      api('/api/events?limit=20'),
      api('/api/board/events?limit=20').catch(() => ({ events: [] })),
    ]);
    renderEvents([...(br.events || []).map((e) => ({ ...e, kind: 'board_' + e.kind })), ...(r.events || [])]);
  } catch {}
}

// ---- 历史曲线弹窗 ----
let modalChart = null;
function openModal(p) {
  $('#modal-title').textContent = p.name;
  $('#modal-sub').textContent = `${fmtYuan(p.price_cents)} · 库存 ${p.available_count} · ${escapeHtml(p.type_name || '')}`;
  $('#modal').classList.add('show');
  fetchHistory(p.id).then((history) => {
    if (modalChart) modalChart.destroy();
    const ctx = $('#modal-chart').getContext('2d');
    modalChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: history.map((h) => fmtTime(h.captured_at)),
        datasets: [{
          label: '价格(¥)',
          data: history.map((h) => h.price_cents / 100),
          borderColor: '#0d9488',
          backgroundColor: 'rgba(13,148,136,.08)',
          fill: true,
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.3,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxTicksLimit: 8 } },
          y: { beginAtZero: false },
        },
      },
    });
  });
}
$('#modal-close').addEventListener('click', () => $('#modal').classList.remove('show'));
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) $('#modal').classList.remove('show'); });

document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
document.querySelectorAll('#range-picker button').forEach((b) => b.addEventListener('click', () => setChartWindow(Number(b.dataset.hours))));

// ---- 分时走势（klinecharts K线）----
let klineWindowHours = 6;         // 当前时间跨度（小时），可由选择器调整
let klinePeriodSec = 300;         // 当前 K 线聚合周期（秒）
let klineCharts = {};             // plan -> klinecharts 图表实例
let klineTicks = {};              // plan -> 全部已加载原始 tick（升序、去重）
let klineKlines = {};             // plan -> 全部聚合 K 线
let klineLoading = {};            // plan -> 是否正在加载更早历史
let klineLoadedAll = {};          // plan -> 已到最早历史
let chartTimer = null;

// 固定 5 分 K（aicoin 风格）：窗口选择器只改变数据范围，不改变 K 线周期
function klinePeriod() { return 300; }

// 标准 K 线：不叠加任何自定义折线/指标（最低/中位/最高均通过单根 K 的 OHLC 体现），
// 符合行业 K 线规范。

// captured_at "YYYY-MM-DD HH:MM:SS" (UTC) → 毫秒时间戳（klinecharts 用毫秒）
function capturedAtToMs(capturedAt) {
  const m = String(capturedAt || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// 毫秒 → SQLite 时间字符串 "YYYY-MM-DD HH:MM:SS" (UTC)，供后端范围查询
function msToSqliteUtc(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// 合并两批 tick，按 captured_at 去重并升序
function mergeTicks(a, b) {
  const map = new Map();
  for (const t of [...a, ...b]) if (t && t.captured_at) map.set(t.captured_at, t);
  return Array.from(map.values()).sort((x, y) => capturedAtToMs(x.captured_at) - capturedAtToMs(y.captured_at));
}

// 原始 tick → 标准 K 线(OHLC) + 成交量(volume)。
//   open/close 取周期首末均价（实体）  high/low 取均价最高/最低价最低（上下影线）
//   volume  = 周期内「最近成交时间(last_sold_at)更新」的采集轮次数，作为成交活跃度/成交量。
//             (sold_count 累计已售受商家排名变动影响会跳变，差分不可靠，故改用 last_sold_at)
// 不使用平台 max（挂单高价）做 high，避免影线贯穿；不叠加任何自定义折线。
function aggregateKline(ticks, periodSec) {
  const period = periodSec * 1000;
  const map = new Map();
  for (const t of ticks) {
    const ms = capturedAtToMs(t.captured_at);
    if (ms == null) continue;
    const bucket = Math.floor(ms / period) * period;
    const avg = t.avg_cents / 100, min = t.min_cents / 100;
    const lastSold = t.last_sold_at || '';
    let k = map.get(bucket);
    if (!k) { k = { timestamp: bucket, open: avg, close: avg, low: min, avgMax: avg, vol: 0, prevLastSold: lastSold }; map.set(bucket, k); }
    else {
      // 最近成交时间变化 = 该轮有新成交 → 计 1 笔
      if (lastSold && lastSold !== k.prevLastSold) k.vol += 1;
      if (lastSold) k.prevLastSold = lastSold;
      k.close = avg; if (avg > k.avgMax) k.avgMax = avg; if (min < k.low) k.low = min;
    }
  }
  return Array.from(map.values())
    .map((k) => ({
      timestamp: k.timestamp, open: k.open, close: k.close, high: k.avgMax, low: k.low,
      volume: k.vol,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// 切换时间跨度
function setChartWindow(hours) {
  klineWindowHours = hours;
  klinePeriodSec = klinePeriod();
  document.querySelectorAll('#range-picker button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.hours) === hours);
  });
  $('#chart-hint').textContent = `近 ${hours} 小时 · 5分K · 每 10 秒更新`;
  // 重建图表（数据范围变化）
  rebuildCharts();
}

async function rebuildCharts() {
  // 重置已建标记，让 initCharts 重建所有卡片与图表
  const grid = $('#chart-grid');
  grid.dataset.built = '';
  // 销毁旧图表实例，释放 canvas 与事件监听
  for (const plan in klineCharts) {
    try { klinecharts.dispose(klineCharts[plan]); } catch {}
  }
  klineCharts = {};
  klineTicks = {};
  klineKlines = {};
  klineLoading = {};
  klineLoadedAll = {};
  await initCharts();
}

// 切换到指定 tab（数据在 login 后才可用，login 时会触发 initCharts）
let activeTab = 'overview';
function switchTab(tab) {
  if (activeTab === tab) return;
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#tab-overview').style.display = tab === 'overview' ? '' : 'none';
  $('#tab-chart').style.display = tab === 'chart' ? '' : 'none';
  if (tab === 'chart') {
    initCharts();
    if (!chartTimer) {
      chartTimer = setInterval(() => updateCharts(), 20000);
    }
  }
}

// 首次进入分时 tab：为每个 plan 建一整行 K 线卡片
async function initCharts() {
  const grid = $('#chart-grid');
  if (grid.dataset.built) { updateCharts(); return; }
  try {
    const r = await api('/api/board');
    const plans = r.board || [];
    if (!plans.length) { grid.innerHTML = '<div class="empty">暂无价格面板数据</div>'; return; }
    grid.innerHTML = '';
    klinePeriodSec = klinePeriod();
    $('#chart-hint').textContent = `近 ${klineWindowHours} 小时 · 5分K · 每 10 秒更新`;
    for (const p of plans) {
      const el = document.createElement('div');
      el.className = 'chart-card';
      el.innerHTML = `
        <div class="chart-head">
          <span class="chart-name">${PLAN_LABELS[p.plan] || p.plan}
            <span class="lvl-badge ${p.available ? 'high' : 'none'}">${p.available ? '有现货' : '无现货'}</span>
          </span>
          <span class="chart-state" id="kline-state-${p.plan}"></span>
        </div>
        <div class="chart-wrap" id="kline-canvas-${p.plan}"></div>
      `;
      grid.appendChild(el);
    }
    grid.dataset.built = '1';
    await updateCharts();
  } catch (e) {
    grid.innerHTML = '<div class="empty">加载走势失败，请检查服务</div>';
  }
}

// 用 klinecharts 建一张 K 线图（蜡烛 + 十字光标 + 缩放拖拽内置）
function createKlineChart(plan) {
  const el = $('#kline-canvas-' + plan);
  if (!el) return null;
  const chart = klinecharts.init(el, {
    locale: 'zh-CN',
    styles: {
      grid: { horizontal: { color: '#f3f4f6' }, vertical: { color: '#f3f4f6' } },
      candle: {
        bar: {
          upColor: '#ef4444', downColor: '#16a34a', noChangeColor: '#9ca3af',
          upBorderColor: '#ef4444', downBorderColor: '#16a34a',
          upWickColor: '#ef4444', downWickColor: '#16a34a',
        },
        // 十字光标 tooltip：只显示时间+OHLC，不显示成交量（平台无成交数据，避免 n/a）
        tooltip: {
          custom: [
            { title: '时间', value: '{time}' },
            { title: '开盘', value: '{open}' },
            { title: '最高', value: '{high}' },
            { title: '最低', value: '{low}' },
            { title: '收盘', value: '{close}' },
          ],
        },
        // 关闭每根 K 的高低点价格标签（避免标注杂乱，标价靠十字光标）
        priceMark: {
          high: { show: false },
          low: { show: false },
          last: { show: false },
        },
      },
      xAxis: { axisLine: { color: '#e5e7eb' }, tickText: { color: '#6b7280' } },
      yAxis: { axisLine: { color: '#e5e7eb' }, tickText: { color: '#6b7280' } },
      crosshair: {
        horizontal: { line: { color: '#9ca3af' }, text: { backgroundColor: '#6b7280' } },
        vertical: { line: { color: '#9ca3af' }, text: { backgroundColor: '#6b7280' } },
      },
    },
  });
  // 成交量副图（aicoin 风格）：内置 VOL 指标，数据取 KLineData.volume
  chart.createIndicator('VOL');
  // 成交量柱：红涨绿跌（对齐 K 线配色）
  chart.setStyles({
    indicator: { bars: [{ upColor: '#ef4444', downColor: '#16a34a', noChangeColor: '#9ca3af' }] },
  });
  return chart;
}

// 拉取各 plan 数据并更新图表（首次 applyNewData，之后增量 updateData）
async function updateCharts() {
  const wraps = document.querySelectorAll('#tab-chart .chart-wrap[id^="kline-canvas-"]');
  if (!wraps.length) return;
  for (const w of wraps) {
    const plan = w.id.replace('kline-canvas-', '');
    try {
      const d = await api('/api/board/history?plan=' + encodeURIComponent(plan) + '&window=' + klineWindowHours);
      const hist = (d.history || []).filter((h) => h.available && h.median_cents > 0);
      if (!hist.length) continue;
      klineTicks[plan] = mergeTicks(klineTicks[plan] || [], hist);
      const klines = aggregateKline(klineTicks[plan], klinePeriodSec);
      let chart = klineCharts[plan];
      if (!chart) {
        chart = createKlineChart(plan);
        if (!chart) continue;
        klineCharts[plan] = chart;
        chart.applyNewData(klines, true);
        attachLoadMore(plan, chart);
      } else if (klines.length) {
        // 增量：最后一根有变化才更新（不重置用户缩放/平移位置）
        const prev = klineKlines[plan] && klineKlines[plan].length ? klineKlines[plan][klineKlines[plan].length - 1] : null;
        const last = klines[klines.length - 1];
        if (!prev || prev.timestamp !== last.timestamp || prev.close !== last.close || prev.high !== last.high || prev.volume !== last.volume) {
          chart.updateData(last);
        }
      }
      klineKlines[plan] = klines;
    } catch {}
  }
}

function setKlineState(plan, text) {
  const el = $('#kline-state-' + plan);
  if (el) el.textContent = text || '';
}

// 滚到最左边界时加载更早历史（applyMoreData 不改变可见范围）
function attachLoadMore(plan, chart) {
  chart.subscribeAction(klinecharts.ActionType.OnVisibleRangeChange, (data) => {
    const vr = data && data.visibleRange;
    if (vr && vr.from <= 1 && !klineLoading[plan] && !klineLoadedAll[plan]) {
      loadOlder(plan, chart);
    }
  });
}

async function loadOlder(plan, chart) {
  klineLoading[plan] = true;
  setKlineState(plan, '加载更早…');
  const ticks = klineTicks[plan] || [];
  const earliest = ticks.length ? capturedAtToMs(ticks[0].captured_at) : Date.now();
  const span = Math.max(klineWindowHours, 24) * 3600 * 1000; // 每页至少 24h
  const fromMs = earliest - span;
  const toMs = earliest - 1000;
  try {
    const d = await api('/api/board/history?plan=' + encodeURIComponent(plan)
      + '&from_ts=' + encodeURIComponent(msToSqliteUtc(fromMs))
      + '&to_ts=' + encodeURIComponent(msToSqliteUtc(toMs))
      + '&limit=200000');
    const older = (d.history || []).filter((h) => h.available && h.median_cents > 0);
    if (!older.length) { klineLoadedAll[plan] = true; setKlineState(plan, '已加载全部历史'); return; }
    klineTicks[plan] = mergeTicks(older, ticks);
    const klines = aggregateKline(klineTicks[plan], klinePeriodSec);
    const oldTimes = new Set((klineKlines[plan] || []).map((k) => k.timestamp));
    const newKlines = klines.filter((k) => !oldTimes.has(k.timestamp));
    if (newKlines.length) chart.applyMoreData(newKlines, true);
    klineKlines[plan] = klines;
    setKlineState(plan, '');
  } catch {} finally { klineLoading[plan] = false; }
}

// ---- 启动 ----
function start() {
  refresh();
  refreshEvents();
  setInterval(refresh, 30000);
  setInterval(refreshEvents, 60000);
}

(async function init() {
  if (!token) return;
  try {
    await api('/api/current');
    $('#login-box').style.display = 'none';
    $('#dashboard').style.display = 'block';
    start();
  } catch {
    localStorage.removeItem(TOKEN_KEY);
  }
})();
