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

// ---- 分时走势 ----
let chartWindowHours = 6; // 当前时间跨度，可由选择器调整
let chartCharts = {}; // plan -> Chart 实例
let chartData = {};   // plan -> 最近数据
let chartYMin = {};   // plan -> 固定 Y 轴下界(元)
let chartYMax = {};   // plan -> 固定 Y 轴下界(元)
let chartTimer = null;

// 切换时间跨度
function setChartWindow(hours) {
  chartWindowHours = hours;
  document.querySelectorAll('#range-picker button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.hours) === hours);
  });
  $('#chart-hint').textContent = `近 ${hours} 小时 · 每 45 秒更新`;
  // 重新拉数据并重建图表（X 轴宽度变化）
  rebuildCharts();
}

async function rebuildCharts() {
  // 重置已建标记，让 initCharts 重建所有卡片与图表
  const grid = $('#chart-grid');
  grid.dataset.built = '';
  chartCharts = {};
  chartYMin = {};
  chartYMax = {};
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

// 首次进入分时 tab：为每个有现货的 plan 建固定尺寸的图表容器
async function initCharts() {
  const grid = $('#chart-grid');
  if (grid.dataset.built) {
    updateCharts();
    return;
  }
  try {
    const r = await api('/api/board');
    const plans = (r.board || []).filter((p) => p.available);
    if (!plans.length) {
      grid.innerHTML = '<div class="empty">暂无有现货的价格面板数据</div>';
      return;
    }
    grid.innerHTML = '';
    for (const p of plans) {
      const el = document.createElement('div');
      el.className = 'chart-card';
      el.innerHTML = `
        <div class="chart-head">
          <span class="chart-name">${PLAN_LABELS[p.plan] || p.plan}</span>
          <span class="chart-price" id="chart-price-${p.plan}">—</span>
        </div>
        <div class="chart-wrap"><canvas id="chart-canvas-${p.plan}"></canvas></div>
      `;
      grid.appendChild(el);
    }
    grid.dataset.built = '1';
    await updateCharts();
  } catch (e) {
    grid.innerHTML = '<div class="empty">加载走势失败，请检查服务</div>';
  }
}

// 拉取各 plan 近 N 小时数据并更新图表（图表实例只建一次，之后原地 update）
async function updateCharts() {
  const canvases = document.querySelectorAll('#tab-chart canvas');
  if (!canvases.length) return;
  for (const cv of canvases) {
    const plan = cv.id.replace('chart-canvas-', '');
    try {
      const d = await api('/api/board/history?plan=' + encodeURIComponent(plan) + '&window=' + chartWindowHours);
      const hist = (d.history || []).filter((h) => h.available && h.median_cents > 0);
      chartData[plan] = hist;
      const priceEl = $('#chart-price-' + plan);
      if (priceEl && hist.length) {
        priceEl.textContent = fmtYuan(hist[hist.length - 1].median_cents);
      }
      upsertPlanChart(plan, hist);
    } catch {}
  }
}

function fmtShortTime(capturedAt) {
  // captured_at 格式: YYYY-MM-DD HH:MM:SS (UTC)，转成北京时间(本机时区)显示
  const m = String(capturedAt || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const [y, mo, d] = m[1].split('-').map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, d, +m[2], +m[3], +m[4]));
    return dt.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return capturedAt || '';
}

// captured_at "YYYY-MM-DD HH:MM:SS" (UTC) → 毫秒时间戳
function capturedAtToMs(capturedAt) {
  const m = String(capturedAt || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// 毫秒时间戳 → 北京时间 HH:MM（供 X 轴刻度显示）
function fmtMsTime(ms) {
  const d = new Date(ms);
  if (isNaN(d)) return '';
  return d.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// 图表：X 轴为真实时间轴，范围 = [最新时间 - 跨度, 最新时间]
// 数据点落在真实时间位置，坐标轴标定时间，不随数据点数变化
function upsertPlanChart(plan, hist) {
  const canvas = $('#chart-canvas-' + plan);
  if (!canvas) return;
  const existing = chartCharts[plan];

  // 确定固定 Y 轴范围：首次按该 plan 历史数据扩 10%，之后保持不变
  if (!(plan in chartYMin) || chartYMin[plan] == null) {
    const all = hist.flatMap((h) => [h.min_cents / 100, h.median_cents / 100, h.max_cents / 100]);
    if (all.length) {
      let lo = Math.min.apply(null, all);
      let hi = Math.max.apply(null, all);
      const pad = (hi - lo || 1) * 0.12;
      chartYMin[plan] = Math.max(0, +(lo - pad).toFixed(2));
      chartYMax[plan] = +(hi + pad).toFixed(2);
    } else {
      chartYMin[plan] = 0;
      chartYMax[plan] = 1;
    }
  }

  // 时间戳数据点 {x: ms, y: 元}
  const pts = (hist || [])
    .map((h) => ({ x: capturedAtToMs(h.captured_at), h }))
    .filter((p) => p.x != null);
  const medianData = pts.map((p) => ({ x: p.x, y: p.h.median_cents / 100 }));
  const maxData = pts.map((p) => ({ x: p.x, y: p.h.max_cents / 100 }));
  const minData = pts.map((p) => ({ x: p.x, y: p.h.min_cents / 100 }));

  // X 轴时间范围：右端 = 最新数据点时间，左端 = 最新 - 跨度。坐标轴永远标定这个真实时间窗口
  const latestMs = pts.length ? pts[pts.length - 1].x : Date.now();
  const spanMs = chartWindowHours * 3600 * 1000;
  const xMin = latestMs - spanMs;
  const xMax = latestMs;

  const mkTicks = () => ({
    maxTicksLimit: 6,
    font: { size: 10 },
    color: '#9ca3af',
    callback: (val) => fmtMsTime(val),
  });

  if (existing) {
    // 原地更新：换数据点 + 推进时间窗（右端始终最新）
    existing.data.datasets[0].data = medianData;
    existing.data.datasets[1].data = maxData;
    existing.data.datasets[2].data = minData;
    existing.options.scales.x.min = xMin;
    existing.options.scales.x.max = xMax;
    existing.update('none');
    return;
  }

  const ctx = canvas.getContext('2d');
  chartCharts[plan] = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: '中位价',
          data: medianData,
          borderColor: '#0d9488',
          backgroundColor: 'rgba(13,148,136,.08)',
          fill: true,
          borderWidth: 2,
          pointRadius: pts.length > 40 ? 0 : 1.5,
          tension: 0.25,
        },
        {
          label: '最高价',
          data: maxData,
          borderColor: '#f59e0b',
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.25,
          borderDash: [4, 3],
        },
        {
          label: '最低价',
          data: minData,
          borderColor: '#6366f1',
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.25,
          borderDash: [4, 3],
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            title: (items) => (items.length ? fmtMsTime(items[0].parsed.x) : ''),
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: xMin,
          max: xMax,
          ticks: mkTicks(),
          grid: { display: false },
        },
        y: {
          min: chartYMin[plan],
          max: chartYMax[plan],
          ticks: { font: { size: 10 }, color: '#9ca3af' },
          grid: { color: '#f3f4f6' },
        },
      },
    },
  });
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
