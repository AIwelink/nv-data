// refresh-cookie.js
// 本机脚本：通过 CDP 连接已登录的真实 Chrome，读取 scm_session cookie，
// 写入 session-cookie.txt（供采集器使用）。约每月需要执行一次。
//
// 用法:
//   1. 启动本机真实 Chrome（已用 aululu 账号登录过）:
//      "C:\Program Files\Google\Chrome\Application\chrome.exe" \
//        --remote-debugging-port=9222 \
//        --user-data-dir=%USERPROFILE%\.chrome-cdp-profile \
//        --proxy-server=http://127.0.0.1:7897
//   2. node refresh-cookie.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CDP_URL = 'http://127.0.0.1:9222';
const OUT = process.env.NVT_COOKIE_FILE || path.join(__dirname, 'session-cookie.txt');
const COOKIE_NAME = 'scm_session';
const TARGET = 'https://nvtokens.com';

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    console.error('[ERROR] 无法连接 CDP（' + CDP_URL + '）。请先按 README 启动真实 Chrome。');
    process.exit(1);
  }

  const ctx = browser.contexts()[0];
  const cookies = await ctx.cookies();
  const scm = cookies.find((c) => c.name === COOKIE_NAME && c.domain.includes('nvtokens'));

  if (!scm) {
    console.error('[ERROR] 未找到 ' + COOKIE_NAME + ' cookie。');
    console.error('        请确认该 Chrome 已登录 nvtokens.com（打开 https://nvtokens.com/workspace 应直接显示工作台）。');
    await browser.close();
    process.exit(1);
  }

  fs.writeFileSync(OUT, scm.value, 'utf8');
  const exp = new Date(scm.expires * 1000).toLocaleString('zh-CN');
  console.log('[OK] 已写入 ' + OUT);
  console.log('[OK] cookie 过期时间: ' + exp);
  console.log('[OK] 将文件内容设置到服务器的 NVT_COOKIE 环境变量，或把文件传到服务器对应位置。');

  await browser.close();
})();
