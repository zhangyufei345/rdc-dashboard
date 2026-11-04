#!/usr/bin/env node
/**
 * 探针：导出 2026-10 的 buildPlanSkuAgg 全量聚合（计划/出货/完成率/dev）
 * 目的：为「假 D」翻转测试提供页面权威口径的 plan 与 shipped
 *   —— 清单「订单量」列 ≠ 销售进度分子（后者并入大仓直发，v360），不能混用
 */
const fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
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
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 });
  await page.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('shortage'); window._shortageTab = 'monthly'; });
  await page.waitForFunction(() => typeof _demandReady === 'function' && _demandReady(), { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const out = await page.evaluate(() => {
    const agg = buildPlanSkuAgg('2026-10');
    const keep = {};
    Object.keys(agg).forEach(k => {
      const v = agg[k];
      keep[k] = { plan: v.plan, shipped: v.shipped, comp: v.comp, dev: v.dev, mt: v.mt, od: v.od };
    });
    return { basis: window._planSkuAggShipBasis, tp: window._planSkuAggTimeProg, n: Object.keys(agg).length, keep };
  });
  fs.writeFileSync(path.join(ROOT, '.cache/_psa_2026-10.json'), JSON.stringify(out, null, 0), 'utf-8');
  console.log('basis =', out.basis, ' timeProg =', out.tp, ' keys =', out.n);
  console.log('已写入 .cache/_psa_2026-10.json');
  console.log('pageErrors =', errs.length, errs.slice(0, 5).join(' | '));
  await browser.close(); server.close();
})();
