// 验证：orderDetail.warehouse 与 directShip.rdc 键口径是否真的能 join
// 用法：node tools/probe-keyjoin.cjs
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript' };
function serve() { return new Promise(res => { const s = http.createServer((req, rq) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rq.writeHead(404); rq.end('nf'); return; } rq.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' }); fs.createReadStream(f).pipe(rq); }); s.listen(0, '127.0.0.1', () => res(s)); }); }
(async () => {
  const srv = await serve(); const port = srv.address().port;
  const exe = (() => { const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'); const c = []; for (const d of fs.readdirSync(base)) { c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(base, d, 'chrome-win64', 'chrome.exe')); } return c.find(p => fs.existsSync(p)); })();
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {}); await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 120000 });
  await page.waitForTimeout(2000);

  const r = await page.evaluate(() => {
    const od = dataStore.orderDetail || [], ds = dataStore.directShip || [];
    const odWh = {}, dsRdc = {}, dsNorm = {};
    od.forEach(d => { if (d.warehouse) odWh[d.warehouse] = (odWh[d.warehouse] || 0) + 1; });
    ds.forEach(d => { if (d.rdc) dsRdc[d.rdc] = (dsRdc[d.rdc] || 0) + 1;
      const n = normalizeRdcName(d.rdc); dsNorm[n] = (dsNorm[n] || 0) + 1; });
    // 用 skuCode|warehouse 建 orderDetail 键集合，检查 directShip 键能否命中
    const odKeys = new Set(od.map(d => String(d.skuCode) + '|' + d.warehouse));
    let hit = 0, miss = 0; const missSample = [];
    ds.forEach(d => {
      const k = String(d.skuCode) + '|' + normalizeRdcName(d.rdc);
      if (odKeys.has(k)) hit++; else { miss++; if (missSample.length < 8) missSample.push(k); }
    });
    // 反向：normSkuCode 是否会导致碰撞
    const dsRawKeys = new Set(ds.map(d => String(d.skuCode)));
    return { odWarehouseVals: odWh, dsRdcVals: dsRdc, dsNormVals: dsNorm,
      odKeyCount: odKeys.size, dsHit: hit, dsMiss: miss, missSample,
      dsRawSkuSample: Array.from(dsRawKeys).slice(0, 12),
      normalizeRdcName_type: typeof normalizeRdcName,
      dsQty_ok: (typeof _dsQty === 'function'),
    };
  });
  console.log('orderDetail.warehouse 取值分布:'); console.log(JSON.stringify(r.odWarehouseVals, null, 2));
  console.log('\ndirectShip.rdc 原始取值:'); console.log(JSON.stringify(r.dsRdcVals, null, 2));
  console.log('\ndirectShip.rdc 归一化后:'); console.log(JSON.stringify(r.dsNormVals, null, 2));
  console.log('\n键 join 测试（directShip 的 skuCode|归一化rdc 能否命中 orderDetail 键集）:');
  console.log(`  命中=${r.dsHit}  未命中=${r.dsMiss}  （orderDetail 键数=${r.odKeyCount}）`);
  if (r.missSample.length) { console.log('  未命中样例:'); r.missSample.forEach(x => console.log('    ' + x)); }
  console.log('\ndirectShip 原始 skuCode 样例:'); console.log('  ' + r.dsRawSkuSample.join(', '));
  await browser.close(); srv.close(); process.exit(0);
})();
