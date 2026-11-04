#!/usr/bin/env node
/** v452 视觉核验：强制显示 page-shortage（SPA 路由在探针里点不稳），滚到清单卡整屏截图 */
const fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };
function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const c = [];
  for (const d of fs.readdirSync(base)) { c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(base, d, 'chrome-win64', 'chrome.exe')); }
  return c.find(p => fs.existsSync(p));
}
function startServer() {
  const s = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(s)));
}
(async () => {
  const { chromium } = require('playwright-core');
  const server = await startServer(); const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1680, height: 1050 } })).newPage();
  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 });
  await page.evaluate(() => { window._shortageTab = 'monthly'; if (typeof navigateTo === 'function') navigateTo('shortage'); });
  await page.waitForTimeout(1500);

  const vis = await page.evaluate(() => {
    document.querySelectorAll('[id^="page-"]').forEach(function (e) {
      if (e.id !== 'page-shortage') e.style.display = 'none';
    });
    var pg = document.getElementById('page-shortage');
    pg.style.display = 'block';
    var a = pg.parentElement;
    while (a && a !== document.body) {
      if (getComputedStyle(a).display === 'none') a.style.display = 'block';
      a = a.parentElement;
    }
    return { ok: !!pg.offsetParent, h: Math.round(pg.getBoundingClientRect().height) };
  });
  console.log('强制可见:', JSON.stringify(vis));

  await page.waitForFunction(() => typeof _demandReady === 'function' && _demandReady(), { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(2000);

  for (const m of ['2026-05', '2026-10']) {
    await page.evaluate(mm => { window._msMonth = mm; window._msPage = 1; window._attrFilter = 'all'; window._msDrill = null; renderShortage(); }, m);
    await page.waitForTimeout(2000);
    const st = await page.evaluate(() => {
      var pg = document.getElementById('page-shortage');
      var cards = [].slice.call(pg.querySelectorAll('.card'));
      var lst = cards.filter(function (c) { return c.textContent.indexOf('严重度高重点跟进清单') >= 0; })[0];
      if (!lst) return 'no-list-card';
      var hd = lst.querySelector('.card-header');
      var r = hd.getBoundingClientRect();
      window.scrollTo(0, r.top + window.scrollY - 420);
      return 'ok hdTop=' + Math.round(r.top);
    });
    await page.waitForTimeout(600);
    const out = path.join(ROOT, '.cache', 'v452_' + m + '.png');
    await page.screenshot({ path: out });
    console.log('已存', out, '|', st);
  }
  await browser.close(); server.close();
})().catch(e => { console.error('异常:', e && e.message); process.exit(2); });
