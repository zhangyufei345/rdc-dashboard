// 复核 v360 注释里声称的「89025·华中 满足率 82.0% → 49.5%」是否还成立
// 用法：node tools/probe-89025-directship.cjs
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript' };
function serve() {
  return new Promise(res => {
    const s = http.createServer((req, rq) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rq.writeHead(404); rq.end('nf'); return; }
      rq.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rq);
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}
(async () => {
  const srv = await serve(); const port = srv.address().port;
  const exe = (() => {
    const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'); const c = [];
    for (const d of fs.readdirSync(base)) { c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(base, d, 'chrome-win64', 'chrome.exe')); }
    return c.find(p => fs.existsSync(p));
  })();
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {}); await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 120000 });
  await page.evaluate(async () => { if (typeof ensureDemandMerged === 'function') await ensureDemandMerged(); });
  await page.waitForTimeout(2000);

  const r = await page.evaluate(() => {
    const orderData = dataStore.orderDetail || [], dsRows = dataStore.directShip || [], shortData = dataStore.shortage || [];
    const latestDate = shortData.map(d => d.dateStr).filter(Boolean).sort().pop();
    const t = new Date(latestDate); t.setDate(t.getDate() - 60);
    const sixtyStr = t.toISOString().slice(0, 10);
    const analysisDays = Math.min(60, Math.ceil((new Date(latestDate) - t) / 86400000));
    const SKU = '89025', RDC = '华中RDC';
    let aT = 0, aF = 0, bT = 0, bF = 0, dsQ = 0, dsN = 0;
    orderData.forEach(function (d) {
      if (d.dateStr < sixtyStr || d.dateStr > latestDate) return;
      if (String(d.skuCode) !== SKU || d.warehouse !== RDC) return;
      aT += d.orderQty; aF += d.totalFulfillQty;
    });
    bT = aT; bF = aF;
    dsRows.forEach(function (d) {
      if (!d.dateStr || d.dateStr < sixtyStr || d.dateStr > latestDate) return;
      if (String(d.skuCode) !== SKU || d.rdc !== RDC) return;
      const q = (typeof _dsQty === 'function') ? _dsQty(d) : (d.orderQty || 0);
      bT += q; bF += q; dsQ += q; dsN++;
    });
    // 直发按「不满足」极端口径也算一遍（历史上 v359 的做法）
    const worstRate = (aT + dsQ) > 0 ? aF / (aT + dsQ) : 0;
    return {
      latestDate, sixtyStr, analysisDays,
      A: { total: aT, fulfill: aF, rate: aT > 0 ? aF / aT : 0 },
      B: { total: bT, fulfill: bF, rate: bT > 0 ? bF / bT : 0 },
      dsQty: dsQ, dsRows: dsN,
      worstCaseRate: worstRate,
      dsAllForThisSku: dsRows.filter(d => String(d.skuCode) === SKU).map(d => ({ date: d.dateStr, rdc: d.rdc, q: (typeof _dsQty === 'function') ? _dsQty(d) : d.orderQty })).slice(0, 10),
    };
  });
  console.log('窗口:', r.latestDate, '60天前', r.sixtyStr, 'analysisDays', r.analysisDays);
  console.log('\n89025 · 华中RDC：');
  console.log(`  口径A(现状)  需求 ${Math.round(r.A.total).toLocaleString()}  满足 ${Math.round(r.A.fulfill).toLocaleString()}  满足率 ${(r.A.rate * 100).toFixed(2)}%`);
  console.log(`  口径B(并入)  需求 ${Math.round(r.B.total).toLocaleString()}  满足 ${Math.round(r.B.fulfill).toLocaleString()}  满足率 ${(r.B.rate * 100).toFixed(2)}%`);
  console.log(`  大仓直发贡献 ${r.dsRows} 行 / ${Math.round(r.dsQty).toLocaleString()} 支`);
  console.log(`  极端口径(直发全算不满足) 满足率 = ${(r.worstCaseRate * 100).toFixed(2)}%`);
  console.log('\n  该 SKU 直发明细(前10):');
  r.dsAllForThisSku.forEach(x => console.log(`    ${x.date} ${x.rdc}  ${x.q}`));
  console.log('\nv360 注释声称: 82.0% -> 49.5%');
  console.log(`本次实测: ${(r.A.rate * 100).toFixed(1)}% -> ${(r.B.rate * 100).toFixed(1)}%  (最坏 ${(r.worstCaseRate * 100).toFixed(1)}%)`);
  await browser.close(); srv.close(); process.exit(0);
})();
