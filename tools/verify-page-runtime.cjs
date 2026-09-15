#!/usr/bin/env node
/**
 * 页面运行时自检工具（v345 新增）—— 补上 node --check 抓不到的那一类 bug
 *
 * 背景：2026-09-15 v344 上线后「补货调整跟踪」整页白屏，报 `ReferenceError: typeList is not defined`。
 *   node --check 只校验语法，对"引用了未声明标识符"完全无感；关键字 grep 也查不出（定义名写成了
 *   _adjTypeList()，调用点却是 typeList）。唯一可靠的拦截方式 = 真实浏览器把每个页面都渲染一遍。
 *
 * 用法（在项目根目录执行）：
 *   NODE_PATH="C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules" \
 *   "C:/Users/zhangyufei1/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" tools/verify-page-runtime.cjs
 *   # 只测部分页签：在后面加路由名，例如  ... verify-page-runtime.cjs adjust-track plan-monitor
 *
 * 说明：
 * - 自带静态服务（无需另起 http server）；需要项目根有 manifest.json 与各 *.json 数据文件（本地即具备）。
 * - 登录用页面源码里定义的账号（ADMIN_USER/ADMIN_PASS = admin/admin123）。
 * - 退出码：全部页签无 JS 运行时错误且渲染非空 → 0；否则 1（可直接用于部署前卡口）。
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

// 项目根 = 本脚本所在 tools/ 的上级目录
const ROOT = path.resolve(__dirname, '..');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

// 全部页签路由（data-page）；data=数据管理页（空态正常，单独容忍）
const DEFAULT_ROUTES = ['overview', 'fulfillment', 'order-insight', 'shortage', 'weekend-sim', 'transship',
  'replenishment', 'shortage-compare', 'plan-monitor', 'biz-demand', 'adjust-track',
  'inventory-structure', 'inventory', 'slow-moving'];

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(base)) throw new Error('未找到 ms-playwright 目录：' + base);
  const cands = [];
  for (const d of fs.readdirSync(base)) {
    cands.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    cands.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  const hit = cands.find(p => fs.existsSync(p));
  if (!hit) throw new Error('ms-playwright 下未找到 chromium 可执行文件');
  return hit;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  let chromium;
  try { chromium = require('playwright-core').chromium; }
  catch (e) { console.error('需要 playwright-core：设置 NODE_PATH 指向 binaries/node/workspace/node_modules'); process.exit(2); }

  const routes = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const list = routes.length ? routes : DEFAULT_ROUTES;
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();

  let errs = [];
  page.on('pageerror', e => errs.push(e && e.message ? e.message : String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 300)); });

  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  const loaded = await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 })
    .then(() => true).catch(() => false);
  console.log('数据装载:', loaded ? 'OK' : '超时（后续结果可能因无数据而不准）');

  const results = [];
  for (const r of list) {
    errs = [];
    const nav = await page.evaluate(route => {
      try {
        if (typeof navigateTo === 'function') { navigateTo(route); return 'ok'; }
        return 'no navigateTo';
      } catch (e) { return 'THREW ' + e.message; }
    }, r).catch(e => 'evaluate failed ' + e.message);
    await page.waitForTimeout(2500);
    const len = await page.evaluate(route => {
      const el = document.getElementById('page-' + route);
      return el ? el.innerHTML.length : -1;
    }, r).catch(() => -1);
    const ok = errs.length === 0 && len > 200;
    results.push({ route: r, ok, htmlLen: len, errors: errs.slice(0, 3) });
    console.log((ok ? '✅' : '❌') + ' ' + r.padEnd(20) + ' html=' + String(len).padStart(8) + (errs.length ? '  ERR: ' + errs[0] : ''));
  }

  await browser.close();
  server.close();
  const bad = results.filter(x => !x.ok);
  console.log('\n合计 ' + results.length + ' 页签，失败 ' + bad.length + ' 个');
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('工具异常:', e && e.message); process.exit(2); });
