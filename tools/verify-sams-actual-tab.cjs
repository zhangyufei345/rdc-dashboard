/* v513 验证：补货模拟页「模拟趋势 / 实际库存情况」TAB 切换 + 武汉模拟渲染 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const cands = [];
  for (const d of fs.readdirSync(base)) {
    cands.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    cands.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  const hit = cands.find(p => fs.existsSync(p));
  if (!hit) throw new Error('未找到 chromium');
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
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}
(async () => {
  const { chromium } = require('playwright-core');
  const server = await startServer(), port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });
  const target = process.env.TARGET_URL || ('http://127.0.0.1:' + port + '/rdc-dashboard.html');
  console.log('目标页面:', target);
  await page.goto(target + (target.includes('?') ? '&' : '?') + 't=' + Date.now(),
    { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 });
  await page.evaluate(() => navigateTo('sams-sim'));
  await page.waitForFunction(() => window._samsSimState && window._samsSimState.result, { timeout: 60000 });
  console.log('浏览器标题:', await page.title());

  const simInfo = await page.evaluate(() => {
    const box = document.getElementById('samsSimBox');
    return { view: window._samsSimState.view, tabs: (box.innerText.match(/模拟趋势|实际库存情况/g) || []).length,
      svgCount: box.querySelectorAll('svg').length,
      hasWuhan: /武汉FDC/.test(box.innerHTML) };
  });
  console.log('默认模拟视图:', JSON.stringify(simInfo));

  await page.evaluate(() => samsSimSetView('actual'));
  await page.waitForFunction(() => window._samsSimState.actualData || window._samsSimState.actualErr, { timeout: 30000 });
  await page.waitForTimeout(2500);   // 等异步建议卡片补渲染完，避免元素被替换
  const actInfo = await page.evaluate(() => {
    const box = document.getElementById('samsSimBox'), h = box.innerHTML;
    return { view: window._samsSimState.view, err: window._samsSimState.actualErr || '',
      svgCount: box.querySelectorAll('svg').length,
      hasTJ27840: /27,840/.test(h), hasWuhan: /山姆-武汉FDC/.test(h),
      hasSMWHNote: /SMWH/.test(h), hasLeadCorrect: /11\/12 补货 → 11\/16 到仓/.test(h), h: h.length };
  });
  console.log('实际库存视图:', JSON.stringify(actInfo));
  const outDir = path.join(ROOT, '.cache', '_v513');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    await page.evaluate(() => navigateTo('sams-sim'));
    await page.waitForTimeout(1200);
    await page.locator('#samsSimBox').screenshot({ path: path.join(outDir, 'actual_tab.png'), timeout: 8000 });
  } catch (e) { console.log('截图跳过（不影响断言）:', String(e.message).slice(0, 80)); }
  console.log('页面错误:', errs.length ? errs.slice(0, 5) : '无');
  const ok = simInfo.view === 'sim' && simInfo.tabs === 2 && simInfo.svgCount >= 4 && simInfo.hasWuhan
    && actInfo.view === 'actual' && !actInfo.err && actInfo.svgCount === 5 && actInfo.hasTJ27840 && actInfo.hasWuhan
    && actInfo.hasSMWHNote && actInfo.hasLeadCorrect && errs.length === 0;
  console.log(ok ? '✅ v513 TAB 与武汉模拟渲染验证通过' : '❌ v513 验证失败');
  await browser.close(); server.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
