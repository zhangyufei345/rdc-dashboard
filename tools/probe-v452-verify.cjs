#!/usr/bin/env node
/** 逐字段核实：指定月份下 hi 行的 sales-progress（plan/shipped/comp/dev/status）与归因 */
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
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 });
  await page.evaluate(() => { window._shortageTab = 'monthly'; if (typeof navigateTo === 'function') navigateTo('shortage'); });
  // 等 demand 真并入完成（比固定 sleep 可靠）
  const ready = await page.waitForFunction(() => typeof _demandReady === 'function' && _demandReady(), { timeout: 90000 }).then(() => true).catch(() => false);
  console.log('demand 并入就绪:', ready);
  await page.waitForTimeout(2500);

  for (const PERIOD of ['2026-10', '2026-09']) {
    const o = await page.evaluate(P => {
      const prof = getMonthlyShortageProfile();
      const valid = prof.list.filter(p => p.month === P && p.shortQty > 0 && p.orderDayCnt >= MS_PROFILE.MIN_DAYS);
      const hi = valid.filter(p => p.isPersistent);
      const agg = buildPlanSkuAgg(P);
      const month = window._planSkuAggMonth, tp = window._planSkuAggTimeProg, basis = window._planSkuAggShipBasis;
      const rows = hi.slice(0, 5).map(p => {
        const k = normSkuCode(p.sku) + '|' + normalizeRdcName(p.rdc);
        const sp = agg[k] || null;
        return {
          sku: p.sku, rdc: p.rdc, orderQty: p.orderQty, shortQty: p.shortQty,
          key: k, found: !!sp,
          plan: sp ? sp.plan : null, shipped: sp ? sp.shipped : null,
          comp: sp ? (isFinite(sp.comp) ? sp.comp : 'Inf') : null,
          dev: sp ? sp.dev : null, status: sp ? sp.status : null,
          scc: (typeof skuSupplyChainCat === 'function') ? skuSupplyChainCat(p.sku) : 'NOFN'
        };
      });
      // 直接对账 demand.json 的键
      const inv = dataStore.inventory || {};
      const pb = inv.planBySkuRdc || {}, ab = inv.actualShipBySkuRdc || {};
      const probeSku = hi[0] ? hi[0].sku : '';
      const probeRdc = hi[0] ? normalizeRdcName(hi[0].rdc) : '';
      return {
        period: P, hiCnt: hi.length, aggMonth: month, tp: tp, basis: basis,
        rawPlan: (pb[probeSku] && pb[probeSku][probeRdc]) || null,
        rawShip: (ab[probeSku] && ab[probeSku][probeRdc]) || null,
        probeSku, probeRdc, rows,
        actualShipMonths: (function () { const s = {}; Object.keys(ab).forEach(k => { const br = ab[k] || {}; Object.keys(br).forEach(r => Object.keys(br[r] || {}).forEach(m => { s[m] = (s[m] || 0) + 1; })); }); return s; })()
      };
    }, PERIOD);
    console.log('\n============ ' + o.period + ' ============');
    console.log('hi条数=' + o.hiCnt + '  aggMonth=' + o.aggMonth + '  tp=' + o.tp + '  basis=' + o.basis);
    console.log('actualShipBySkuRdc 各月键数:', JSON.stringify(o.actualShipMonths));
    console.log('首个 SKU(' + o.probeSku + '/' + o.probeRdc + ') planBySkuRdc:', JSON.stringify(o.rawPlan));
    console.log('                                    actualShipBySkuRdc:', JSON.stringify(o.rawShip));
    console.log('前 5 行:');
    o.rows.forEach(r => console.log('  ' + String(r.sku).padEnd(7) + String(r.rdc).padEnd(9) +
      ' 订单=' + String(r.orderQty).padStart(6) + ' 缺货=' + String(r.shortQty).padStart(6) +
      ' key=' + r.key.padEnd(14) + ' found=' + (r.found ? 'Y' : 'N') +
      ' 计划=' + String(r.plan).padStart(8) + ' 出货=' + String(r.shipped).padStart(8) +
      ' comp=' + String(typeof r.comp === 'number' ? (r.comp * 100).toFixed(1) + '%' : r.comp).padStart(9) +
      ' dev=' + String(r.dev == null ? '—' : (r.dev * 100).toFixed(1) + 'pt').padStart(9) +
      ' 状态=' + String(r.status).padEnd(6) + ' 品类=' + r.scc));
  }
  console.log('\n运行时错误:', errs.length ? errs.slice(0, 3) : '无');
  await browser.close(); server.close();
})().catch(e => { console.error('异常:', e && e.message); process.exit(2); });
