// 探针：分仓需求优化建议（buildPlanOptimAdvice）81014·东北RDC 的 plan/shipped/comp 实际取值
// 目的：判断页面究竟是「已用 demand.json 实际出货」还是「仍停留在已放行订单口径」
// 用法：node tools/probe-advice-81014.cjs
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
  const srv = await serve();
  const port = srv.address().port;
  const exe = (() => {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    const cands = [];
    for (const d of fs.readdirSync(base)) {
      cands.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
      cands.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
    }
    return cands.find(p => fs.existsSync(p));
  })();
  if (!exe) throw new Error('ms-playwright 下未找到 chromium 可执行文件');

  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console.error: ' + m.text()); });

  await page.goto(`http://127.0.0.1:${port}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 120000 });

  await page.evaluate(async () => { if (typeof ensureDemandMerged === 'function') await ensureDemandMerged(); });
  await page.evaluate(() => { if (typeof ensureInventoryPlan === 'function') return ensureInventoryPlan(); });
  await page.waitForTimeout(3000);

  // ---- A: demand.json 里 81014 的真值 ----
  const a = await page.evaluate(() => {
    const inv = (typeof dataStore !== 'undefined' && dataStore && dataStore.inventory) || {};
    const ship = inv.actualShipBySkuRdc || {};
    const plan = inv.planBySkuRdc || {};
    const skus = ['81014', '081014'];
    const out = {};
    for (const s of skus) {
      out[s] = {
        planKeys: plan[s] ? Object.keys(plan[s]) : null,
        planNE: plan[s] && plan[s]['东北RDC'] ? plan[s]['东北RDC']['2026-09'] : null,
        shipKeys: ship[s] ? Object.keys(ship[s]) : null,
        shipNE: ship[s] && ship[s]['东北RDC'] ? ship[s]['东北RDC']['2026-09'] : null,
      };
    }
    return {
      out,
      actualShipOf_81014_NE: (typeof _actualShipOf === 'function') ? _actualShipOf('81014', '东北RDC', '2026-09') : 'ERR',
      actualShipOf_081014_NE: (typeof _actualShipOf === 'function') ? _actualShipOf('081014', '东北RDC', '2026-09') : 'ERR',
      demandMeta_81014: (inv.demandMeta || {})['81014'] || null,
      demandMeta_081014: (inv.demandMeta || {})['081014'] || null,
    };
  });
  console.log('=== A. demand.json 81014 真值 ===');
  console.log(JSON.stringify(a, null, 2));

  // ---- B: buildPlanOptimAdvice() 输出里 81014 的行 ----
  const b = await page.evaluate(() => {
    const rows = (typeof buildPlanOptimAdvice === 'function') ? (buildPlanOptimAdvice() || []) : 'ERR:fn';
    if (rows === 'ERR:fn') return { err: 'buildPlanOptimAdvice undefined' };
    const hit = rows.filter(r => String(r.sku) === '81014' || String(r.sku) === '081014' || String(r.sku) === '1014');
    return {
      total: rows.length,
      hit: hit.map(r => ({ sku: r.sku, skuName: r.skuName, rdc: r.rdc, plan: r.plan, shipped: r.shipped, comp: +(r.comp).toFixed(4), dir: r.direction, bigOrder: !!r.bigOrder })),
    };
  });
  console.log('\n=== B. buildPlanOptimAdvice() 输出中的 81014 ===');
  console.log(JSON.stringify(b, null, 2));

  // ---- C: 计划监控页（renderPlanMonitor）里 81014 的值 ----
  const c = await page.evaluate(() => {
    if (typeof navigateTo === 'function') navigateTo('plan-monitor');
    return true;
  });
  await page.waitForTimeout(3000);
  const c2 = await page.evaluate(() => {
    const rows = (typeof buildPlanSkuAgg === 'function') ? (buildPlanSkuAgg() || []) : 'ERR:fn';
    if (rows === 'ERR:fn') return { err: 'buildPlanSkuAgg undefined' };
    const hit = rows.filter(r => String(r.sku) === '81014' || String(r.sku) === '081014');
    return {
      total: rows.length,
      sample_keys: rows.length ? Object.keys(rows[0]) : [],
      hit: hit.map(r => ({ sku: r.sku, rdc: r.rdc, plan: r.plan, shipped: r.shipped, comp: r.comp, shippedSrc: r.shippedSrc || r.src || null })),
    };
  });
  console.log('\n=== C. buildPlanSkuAgg() 中的 81014（计划监控页口径） ===');
  console.log(JSON.stringify(c2, null, 2));

  // ---- D: Node 侧 demand.json 直读对账 ----
  const dj = JSON.parse(fs.readFileSync(ROOT + '/demand.json', 'utf8'));
  const dPlan = dj.plan['81014'] && dj.plan['81014']['东北RDC'] ? dj.plan['81014']['东北RDC']['2026-09'] : null;
  const dShip = dj.actualShip['81014'] && dj.actualShip['81014']['东北RDC'] ? dj.actualShip['81014']['东北RDC']['2026-09'] : null;
  console.log('\n=== D. Node 直读 demand.json ===');
  console.log('  81014·东北RDC·2026-09  plan=' + dPlan + '  actualShip=' + dShip);
  console.log('  demand.json SKU 是否含 81014:', !!dj.plan['81014'], '| 键样例:', Object.keys(dj.plan).filter(k => /81014|1014/.test(k)));
  console.log('  generatedAt=' + dj.generatedAt);

  console.log('\n运行时错误 ' + errs.length + ' 条');
  errs.slice(0, 15).forEach(e => console.log('  ❌ ' + e));

  await browser.close();
  srv.close();
  process.exit(0);
})();
