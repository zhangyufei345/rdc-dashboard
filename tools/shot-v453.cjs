#!/usr/bin/env node
/** v453 视觉核验：①7 张归因卡片（含 E）②清单里 E 行的「计划 MM-DD ↑N.Nx」小字 */
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
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 });
  await page.evaluate(() => { window._shortageTab = 'monthly'; if (typeof navigateTo === 'function') navigateTo('shortage'); });
  await page.waitForFunction(() => !!window._dpHist, { timeout: 60000 }).catch(() => {});
  await page.evaluate(() => {
    document.querySelectorAll('[id^="page-"]').forEach(e => { if (e.id !== 'page-shortage') e.style.display = 'none'; });
    var pg = document.getElementById('page-shortage'); pg.style.display = 'block';
    var a = pg.parentElement;
    while (a && a !== document.body) { if (getComputedStyle(a).display === 'none') a.style.display = 'block'; a = a.parentElement; }
  });
  await page.waitForFunction(() => typeof _demandReady === 'function' && _demandReady(), { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window._msMonth = '2026-10'; window._msPage = 1; window._attrFilter = 'all'; window._msDrill = null; renderShortage(); });
  await page.waitForTimeout(2000);

  // ⓿ 卡片行实测
  const meas = await page.evaluate(() => {
    var pg = document.getElementById('page-shortage');
    var g = [].slice.call(pg.querySelectorAll('div')).filter(function (d) {
      if (getComputedStyle(d).display !== 'grid') return false;
      var f = d.firstElementChild;
      // 卡片内首个元素是右上角百分比小字，innerText 不以 A1 开头 → 用 includes
      return f && (f.innerText || '').indexOf('A1 ·') >= 0;
    })[0];
    if (!g) return { found: false };
    var cs = getComputedStyle(g);
    return { found: true, cols: cs.gridTemplateColumns, n: g.children.length,
      gridW: Math.round(g.getBoundingClientRect().width),
      vw: window.innerWidth,
      items: [].slice.call(g.children).map(function (c) {
        var r = c.getBoundingClientRect();
        return ((c.innerText || '').match(/[A-E] ?· ?[^\n]{0,10}/) || ['?'])[0] + ' L=' + Math.round(r.left) + ' R=' + Math.round(r.right);
      }) };
  });
  console.log('⓿ 卡片行:', JSON.stringify(meas, null, 1));

  // ① 归因卡片行
  const s1 = await page.evaluate(() => {
    var pg = document.getElementById('page-shortage');
    var all = [].slice.call(pg.querySelectorAll('div'));
    var e = all.filter(d => /E\s*·\s*📋\s*计划口径变动/.test(d.innerText || ''))[0];
    if (!e) return 'no-E-card';
    // 往上找到卡片行容器
    var row = e; for (var i = 0; i < 3 && row.parentElement; i++) row = row.parentElement;
    var r = e.getBoundingClientRect();
    window.scrollTo(0, r.top + window.scrollY - 500);
    return 'ok top=' + Math.round(r.top);
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(ROOT, '.cache', 'v453_cards.png') });
  console.log('① 归因卡片:', s1);

  // ② 清单里第一条 E 行
  const s2 = await page.evaluate(() => {
    var pg = document.getElementById('page-shortage');
    var trs = [].slice.call(pg.querySelectorAll('tbody tr'));
    var tr = trs.filter(t => /计划 \d\d-\d\d ↑[\d.]+x/.test(t.innerText || ''))[0];
    if (!tr) return 'no-E-row';
    var r = tr.getBoundingClientRect();
    window.scrollTo(0, r.top + window.scrollY - 260);
    return 'ok row=' + (tr.innerText || '').replace(/\s+/g, ' ').slice(0, 90);
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(ROOT, '.cache', 'v453_row.png') });
  console.log('② E 行:', s2);

  console.log('pageErrors =', errs.length, errs.slice(0, 3).join(' | '));
  await browser.close(); server.close();
})().catch(e => { console.error('异常:', e && e.message); process.exit(2); });
