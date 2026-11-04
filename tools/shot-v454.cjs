#!/usr/bin/env node
/** v454 视觉核验：①7 张归因卡片（D=计划口径变动 / E=需重点排查）②清单 D 行的「计划 MM-DD ↑N.Nx」小字 */
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
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 })).newPage();
  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 });
  await page.evaluate(() => { window._shortageTab = 'monthly'; if (typeof navigateTo === 'function') navigateTo('shortage'); });
  await page.waitForFunction(() => typeof _demandReady === 'function' && _demandReady(), { timeout: 120000 }).catch(() => {});
  await page.waitForFunction(() => !!window._dpHist, { timeout: 60000 }).catch(() => {});
  await page.evaluate(() => {
    document.querySelectorAll('[id^="page-"]').forEach(e => { if (e.id !== 'page-shortage') e.style.display = 'none'; });
    var pg = document.getElementById('page-shortage'); pg.style.display = 'block';
    var a = pg.parentElement;
    while (a && a !== document.body) { if (getComputedStyle(a).display === 'none') a.style.display = 'block'; a = a.parentElement; }
  });
  await page.evaluate(() => { window._msMonth = '2026-10'; window._msPage = 1; window._attrFilter = 'all'; window._msDrill = null; renderShortage(); });
  await page.waitForTimeout(2500);

  fs.mkdirSync(path.join(ROOT, '.cache'), { recursive: true });

  // ① 卡片行
  const box1 = await page.evaluate(() => {
    var pg = document.getElementById('page-shortage');
    var g = [].slice.call(pg.querySelectorAll('div')).filter(function (d) {
      if (getComputedStyle(d).display !== 'grid') return false;
      var f = d.firstElementChild;
      return f && (f.innerText || '').indexOf('A1 ·') >= 0;
    })[0];
    if (!g) return null;
    var r = g.getBoundingClientRect();
    window.scrollTo(0, r.top + window.scrollY - 120);
    return { x: Math.max(0, r.left - 8), y: 100, width: Math.min(window.innerWidth, r.width + 16), height: r.height + 12,
             items: [].slice.call(g.children).map(function (c) { return ((c.innerText || '').match(/[A-E] ?· ?[^\n]{0,12}/) || ['?'])[0]; }) };
  });
  console.log('① 卡片行:', JSON.stringify(box1 && box1.items));
  if (box1) await page.screenshot({ path: path.join(ROOT, '.cache', 'v454_cards.png'), clip: { x: box1.x, y: box1.y, width: box1.width, height: box1.height } });

  // ② 清单里带「计划 MM-DD ↑N.Nx」徽章的行
  const box2 = await page.evaluate(() => {
    var pg = document.getElementById('page-shortage');
    var b = [].slice.call(pg.querySelectorAll('div')).filter(function (d) {
      return /^计划 \d\d-\d\d ↑[\d.]+x$/.test((d.innerText || '').trim());
    });
    if (!b.length) return null;
    var tr = b[0].closest('tr') || b[0];
    var r = tr.getBoundingClientRect();
    window.scrollTo(0, r.top + window.scrollY - 260);
    return { n: b.length };
  });
  console.log('② 徽章数:', box2 && box2.n);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(ROOT, '.cache', 'v454_badge.png') });

  // ③ 只看 D（计划口径变动）：清单里带蓝色小字徽章
  await page.evaluate(() => { window._attrFilter = 'D'; window._msPage = 1; renderShortage(); });
  await page.waitForTimeout(1200);
  const box3 = await page.evaluate(() => {
    var pg = document.getElementById('page-shortage');
    var t = [].slice.call(pg.querySelectorAll('table')).filter(function (tb) { return (tb.innerText || '').indexOf('归因') >= 0; })[0];
    if (!t) return null;
    var r = t.getBoundingClientRect();
    window.scrollTo(0, r.top + window.scrollY - 150);
    return { rows: t.querySelectorAll('tbody tr').length };
  });
  console.log('③ D 筛选后行数:', box3 && box3.rows);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(ROOT, '.cache', 'v454_D_rows.png') });
  console.log('截图完成: .cache/v454_cards.png / .cache/v454_badge.png / .cache/v454_D_rows.png');
  await browser.close(); server.close();
})();
