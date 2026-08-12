# NVT 商品价格监控平台

监控 [nvtokens.com](https://nvtokens.com)（NexusVault 号池交易台）的**平台价格面板**（Plus / Team / Bug Team / K12 / Free / Pro / Grok 各计划的最低/中位/最高/均价 + 现货状态），以及账号可见的商品价格、库存与上下架状态，生成团队共享的网页看板（历史价格曲线 + 变更事件）。采集自登录态接口，登录态约每月需刷新一次。

## 架构

```
nvtokens.com ──HTTPS+scm_session cookie──> 本服务(Node/Express)
   /api/pool/price-board  ──> 价格面板(plans)   ─┐
   /api/merchant-rankings ──> 商家分计划价格     ├─ collector.js  定时轮询+变更检测
   /api/self-products     ──> 账号可见商品       ├─ SQLite         面板/商品/历史/事件
   /api/supplier/products ──> 自身上架商品      ─┘
                                            └─ 网页看板       同事浏览器访问
```

- 采集用 Node 内置 fetch（带 cookie），**不需要** Playwright
- Playwright 仅用于本机辅助登录导出 cookie（因为登录页有 Cloudflare Turnstile）
- 服务器默认直连 nvtokens.com；若需代理，设置 `PROXY` 环境变量（并 `npm i undici`）

## 本地运行

```bash
npm install          # better-sqlite3 / express / playwright / undici(本地代理需要)
```

1. **准备 cookie**：按下面“刷新 cookie”一节操作，得到 `session-cookie.txt`
2. **启动**：
   ```bash
   PROXY=http://127.0.0.1:7897 WEB_PASSWORD=你的口令 node server.js
   # 本机访问 nvtokens.com 被墙，需走代理；服务器直连时去掉 PROXY
   ```
3. 浏览器打开 `http://localhost:3000`，输入口令查看看板

### 刷新 cookie（约每月一次）

登录页有 Cloudflare Turnstile，无头自动化会被拦截，因此用“真实 Chrome + CDP”登录后导出 cookie：

1. 启动本机真实 Chrome（需已用监控账号登录过 nvtokens.com）：
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" \
     --remote-debugging-port=9222 \
     --user-data-dir=%USERPROFILE%\.chrome-cdp-profile \
     --proxy-server=http://127.0.0.1:7897
   ```
   首次使用该 profile 时，先在浏览器里手动登录一次 nvtokens.com。
2. 运行 `node refresh-cookie.js`，生成 `session-cookie.txt`
3. 本地直接可用；**部署在服务器**时，把该文件里的 cookie 值填到服务器的 `NVT_COOKIE` 环境变量（服务器是海外且无浏览器环境，务必用环境变量而非本机文件）

> 注意：监控账号为 `aululu`（邮箱 `251873620@qq.com`，member 角色）。避免使用其他账号，防止被封。

## 服务器部署（一键，Ubuntu/Debian）

```bash
git clone https://github.com/PWMPro-a/nvt-monitor.git && cd nvt-monitor
bash deploy.sh
```

`deploy.sh` 会自动完成：装 Node 18+ → `npm install` → 生成 `.env` → pm2 常驻 + 开机自启 → 健康检查。首次运行会停在"请编辑 .env"，填好后重跑一次即可：

```bash
# .env 至少要填这两项
WEB_PASSWORD=你的看板口令
NVT_COOKIE=scm_session 的 cookie 值   # 从本机 session-cookie.txt 复制
```

海外服务器直连 nvtokens 通常可通；需要代理时在 `.env` 加 `PROXY=http://代理地址`。

**cookie 每月刷新**：`scm_session` 约每月过期，需要在**本机**用 `node refresh-cookie.js` 重新导出，把新值更新到服务器的 `.env`（`NVT_COOKIE`），然后 `pm2 restart nvt-monitor`。看板顶部会显示采集状态，`auth_ok=false` 即表示 cookie 已失效。

手动部署（可选）：

```bash
git clone <repo> nvt-monitor && cd nvt-monitor
npm install --omit=dev
cp .env.example .env   # 编辑填写 PORT / WEB_PASSWORD / NVT_COOKIE
node server.js          # 先前台确认启动正常

# 用 pm2 常驻
npm i -g pm2
pm2 start server.js --name nvt-monitor
pm2 save && pm2 startup
```

nginx 反向代理（HTTPS 用 certbot 签发）：

```nginx
server {
    server_name 你的域名;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务端口 |
| `WEB_PASSWORD` | `admin` | 看板访问口令 |
| `NVT_COOKIE` | 空 | nvtokens 的 `scm_session` cookie 值（推荐，服务器用） |
| `NVT_COOKIE_FILE` | `./session-cookie.txt` | cookie 文件路径（本机用） |
| `POLL_INTERVAL` | `10` | 轮询间隔（秒），默认 10（分时走势 5 分 K 用，注意平台风控） |
| `HISTORY_RETENTION_DAYS` | `90` | 历史数据保留天数 |
| `PROXY` | 空 | 如 `http://127.0.0.1:7897`（配了需要 `npm i undici`） |

## Web API

- `GET /api/current` — 全部商品当前态（含涨跌标记）
- `GET /api/history?product_id=xx` — 单商品历史时序
- `GET /api/events?limit=50` — 最近变更事件
- `GET /api/board` — 平台价格面板（各 plan 的 min/p25/median/p75/max/avg + 现货状态）
- `GET /api/board/history?plan=plus` — 单 plan 价格时序（画历史曲线）
- `GET /api/board/history?plan=plus&window=6` — 只返回最近 6 小时的数据（分时走势用）
- `GET /api/board/history?plan=plus&from_ts=2026-08-09 00:00:00&to_ts=2026-08-09 23:59:59&limit=50000` — 按时间范围分页（K 线「拖动加载更早历史」用，`from_ts`/`to_ts` 为 UTC 字符串）
- `GET /api/board/events?limit=50` — 面板价格/现货变化事件
- `GET /api/merchants` — 商家排行榜（转发 merchant-rankings，5 分钟缓存），含各商家分计划价格/活跃率/销量
- `GET /api/status` — 采集状态（最近轮询、cookie 是否失效）
- 所有 API 需带请求头 `x-auth-token: <sha256("nvt:"+WEB_PASSWORD)>`（看板前端会自动计算）

## 大盘指数与商家排行榜

- **大盘指数**（看板顶部）：各**有现货且中位价 ≥¥1** 的计划中位价等权平均的综合指数（排除免费等低价计划，避免拉低）+ 近 6 小时迷你走势，实时反映号池主要价格水平
- **商家排行榜**（顶部 tab）：展示各商家排名、Plus 最低价、活跃率、总销量、在售数，**点击表头排序**。数据来自 merchant-rankings，5 分钟缓存

## 分时走势面板

看板顶部有两个 tab：**看板** 与 **分时走势**。
- 每个 plan **占一整行**，渲染一张**K 线图**，红涨绿跌（A股习惯），十字光标显示 时间/开/高/低/收（OHLC）
- **K 线只用最低价计算**：open/close 取周期首末最低价（实体反映最低价走势），**上下影线（针）取最低价在周期内的最高/最低波动范围**（避免用平台挂单高价导致贯穿全图）
- **最高价（橙）/ 中位价（teal）折线放独立副图**（不拉伸主图 Y 轴，K 线清晰占主图主体）。若叠加主图会与 K 线共享价格轴，折线高位会把 K 线压缩得很小
- 成交量副图（aicoin 风格）：来自 `last_sold_at` 更新的成交活跃度；已关闭每根 K 的高低点价格标签，标价靠十字光标
- **库存副图**（蓝色折线，主图下方）：各 plan 可售库存数历史走势（来自 `merchant-rankings` 聚合 `available_count`）
- **看板价格面板卡片「在售」凸显**：各 plan 当前可售库存数用绿色大号数字突出显示，售罄置灰
- **K 线周期可选**：1 分 / 3 分 / 5 分 / 15 分 / 30 分 / 1 小时（时间范围 1h~7d）
- **滚轮缩放 + 鼠标拖拽平移**（K 线软件交互），拖到最左边界自动加载更早历史（`applyMoreData`，不打断当前视图）
- 每 ~10 秒采集、~20 秒增量刷新（`updateData`，不重置缩放/平移位置）；固定 5 分 K
- **成交量副图**（aicoin 风格，主图下方红绿柱）：来自 `merchant-rankings` 的 `last_sold_at`（最近成交时间），5 分成交量 = 周期内成交时间更新的次数（成交活跃度）。平台号池成交稀疏，5 分成交量多为 0 或个位数，属正常
- 时间轴自动显示日期+时分
- 历史数据保留 90 天（`HISTORY_RETENTION_DAYS` 可调），重启后曲线仍能回看
- K 线库使用 [klinecharts](https://github.com/klinecharts/KLineChart)（Apache-2.0，国产专做 K 线），本地化到 `public/`，无需外网 CDN

## 数据来源

- `GET /api/pool/price-board` — 平台价格面板（Plus/Team/Bug Team/K12/Free/Pro/Grok 各计划价格+现货）
- `GET /api/merchant-rankings` — 商家排名（各商家分计划价格、活跃率等）
- `GET /api/self-products` — 商城全部上架商品 + 价格
- `GET /api/supplier/products` — 当前账号自身上架的商品

价格字段为 `price_cents`（分），展示时换算为元。
