// 截图验证：调整明细排序、展开控制条、图表是否正常
const fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.xlsx': 'application/octet-stream' };
function findC() { const b = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : 'C:/Users/zhangyufei1/AppData/Local/ms-playwright'; const c = []; for (const d of fs.readdirSync(b)) { c.push(path.join(b, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(b, d, 'chrome-win64', 'chrome.exe')); } return c.find(p => fs.existsSync(p)); }
function srv() { const s = http.createServer((q, r) => { const rel = decodeURIComponent(q.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html'; const f = path.join(ROOT, rel); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('nf'); return; } r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }); return new Promise(x => s.listen(0, '127.0.0.1', () => x(s))); }
(async () => {
  const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
  const s = await srv(); const port = s.address().port;
  const b = await chromium.launch({ headless: true, executablePath: findC(), args: ['--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e && e.message)));
  await p.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.fill('#login-user', 'admin').catch(() => {}); await p.fill('#login-pass', 'admin123').catch(() => {});
  await p.click('#login-page button').catch(() => {});
  await p.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).catch(() => {});
  await p.waitForTimeout(6000);
  await p.evaluate(() => { if (typeof ensureInventoryPlan === 'function') ensureInventoryPlan(); });
  await p.waitForFunction(() => window._invPlanReady === true, { timeout: 90000 }).catch(() => {});
  await p.waitForTimeout(1500);
  await p.evaluate(() => navigateTo('adjust-track'));
  await p.waitForTimeout(2500);
  fs.mkdirSync(path.join(ROOT, '.cache'), { recursive: true });
  // 明细卡滚动到视野内
  await p.evaluate(() => { const el = document.getElementById('adj-detail-card'); if (el) el.scrollIntoView({ block: 'start' }); });
  await p.waitForTimeout(600);
  await p.screenshot({ path: path.join(ROOT, '.cache', 'adj_detail.png'), clip: { x: 230, y: 0, width: 1370, height: 1150 } });
  // 图表区
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(400);
  await p.evaluate(() => { const el = document.getElementById('adj-chart-type'); if (el) el.scrollIntoView({ block: 'center' }); });
  await p.waitForTimeout(600);
  await p.screenshot({ path: path.join(ROOT, '.cache', 'adj_charts.png'), clip: { x: 230, y: 0, width: 1370, height: 1150 } });
  console.log('已截图 .cache/adj_detail.png .cache/adj_charts.png ｜ 运行时错误 ' + errs.length + (errs.length ? ': ' + errs.slice(0, 2).join(' || ') : ''));
  await b.close(); s.close(); process.exit(0);
})().catch(e => { console.error('异常', e && e.message); process.exit(2); });
