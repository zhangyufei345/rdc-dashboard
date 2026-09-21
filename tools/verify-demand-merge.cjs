// 验证 demand.json 新数据是否真实并入页面（分仓计划监控页）
// 用法：NODE_PATH=<...> node tools/verify-demand-20260920.cjs
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
  // 复用 verify-page-runtime.cjs 的可执行文件解析（实测正确路径：chrome-headless-shell-win64/）
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
  // 🔴 必须等 _bootLoading 结束：handleLogin 收尾会强制 navigateTo('overview')，早导航会被抢回
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 120000 });

  // 关键：等 demand 并入
  await page.evaluate(async () => { if (typeof ensureDemandMerged === 'function') await ensureDemandMerged(); });
  await page.waitForTimeout(1500);

  // ---- A1: demand.json 并入状态 ----
  // 🔴 作用域铁律：dataStore / _demandMerged 都是顶层 let/const，**不挂 window**
  //    （实测 window.dataStore === undefined），page.evaluate 里必须裸写变量名。
  const a1 = await page.evaluate(() => {
    const inv = (typeof dataStore !== 'undefined' && dataStore && dataStore.inventory) || {};
    const plan = inv.planBySkuRdc || {};
    const ship = inv.actualShipBySkuRdc || {};
    let planN = 0, shipN = 0;
    for (const s in plan) for (const r in plan[s]) planN += Object.keys(plan[s][r]).length;
    for (const s in ship) for (const r in ship[s]) shipN += Object.keys(ship[s][r]).length;
    return {
      demandMerged: (typeof _demandMerged !== 'undefined') ? _demandMerged : 'ERR:barescope',
      demandFail: window._demandFail || 0,
      invPlanReady: window._invPlanReady === true,
      planSku: Object.keys(plan).length, planMonthVals: planN,
      shipSku: Object.keys(ship).length, shipMonthVals: shipN,
      demandMetaSku: Object.keys(inv.demandMeta || {}).length,
    };
  });
  console.log('A1 demand 并入状态:', JSON.stringify(a1));

  // A1b: 渲染完成后再读一次（ensureInventoryPlan 可能晚于 ensureDemandMerged 建好 dataStore.inventory）
  await page.evaluate(() => { if (typeof ensureInventoryPlan === 'function') return ensureInventoryPlan(); });
  await page.waitForTimeout(1500);
  const a1b = await page.evaluate(() => {
    const inv = (typeof dataStore !== 'undefined' && dataStore && dataStore.inventory) || {};
    const plan = inv.planBySkuRdc || {};
    const ship = inv.actualShipBySkuRdc || {};
    let planN = 0, shipN = 0, plan09 = 0, ship09 = 0;
    for (const s in plan) for (const r in plan[s]) {
      const md = plan[s][r] || {};
      planN += Object.keys(md).length;
      plan09 += md['2026-09'] || 0;
    }
    for (const s in ship) for (const r in ship[s]) {
      const md = ship[s][r] || {};
      shipN += Object.keys(md).length;
      ship09 += md['2026-09'] || 0;
    }
    return {
      invPlanReady: window._invPlanReady === true,
      planSku: Object.keys(plan).length, planMonthVals: planN, plan09: Math.round(plan09),
      shipSku: Object.keys(ship).length, shipMonthVals: shipN, ship09: Math.round(ship09),
      demandMetaSku: Object.keys(inv.demandMeta || {}).length,
    };
  });
  console.log('A1b 渲染后规模:', JSON.stringify(a1b));

  // A1c: 与 Node 侧 demand.json 逐位对账（必须完全一致）
  const dj = JSON.parse(fs.readFileSync(ROOT + '/demand.json', 'utf8'));
  let np09 = 0, ns09 = 0;
  for (const s in dj.plan) for (const r in dj.plan[s]) np09 += dj.plan[s][r]['2026-09'] || 0;
  for (const s in dj.actualShip) for (const r in dj.actualShip[s]) ns09 += dj.actualShip[s][r]['2026-09'] || 0;
  const okPlan = a1b.plan09 === Math.round(np09);
  const okShip = a1b.ship09 === Math.round(ns09);
  console.log('A1c 对账 分仓计划09: 页面=' + a1b.plan09.toLocaleString() + ' vs json=' + Math.round(np09).toLocaleString() + '  ' + (okPlan ? '✅' : '❌'));
  console.log('    对账 实际出货09: 页面=' + a1b.ship09.toLocaleString() + ' vs json=' + Math.round(ns09).toLocaleString() + '  ' + (okShip ? '✅' : '❌'));
  if (!okPlan || !okShip) { console.log('❌ 页面数据与 demand.json 不一致'); }

  // ---- A2: 页面渲染 plan-monitor 并抓 KPI ----
  await page.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('plan-monitor'); });
  await page.waitForTimeout(2500);
  const a2 = await page.evaluate(() => {
    const el = document.querySelector('.page.active');
    const txt = el ? el.innerText : '';
    return { page: (typeof currentPage !== 'undefined' ? currentPage : '?'), len: txt.length, head: txt.slice(0, 400) };
  });
  console.log('A2 页面:', a2.page, '文本长度:', a2.len);

  // ---- A3: 抓完成率 KPI（应基于 demand.json 真值，而非回退值）----
  const a3 = await page.evaluate(() => {
    const el = document.querySelector('.page.active');
    const warn = el ? el.innerText.includes('未加载成功') : false;
    const cards = Array.from(el ? el.querySelectorAll('.kpi-card, .stat-card, .kpi') : []).slice(0, 8).map(c => c.innerText.replace(/\s+/g, ' ').trim().slice(0, 120));
    return { hasFallbackWarn: warn, cards };
  });
  console.log('A3 回退警示条出现:', a3.hasFallbackWarn, '(应 False)');
  a3.cards.forEach((c, i) => console.log('   KPI' + i + ':', c));

  // ---- A4: Node 侧独立复算 demand.json 合计，与页面口径对照 ----
  const d = JSON.parse(fs.readFileSync(ROOT + '/demand.json', 'utf8'));
  let plan09 = 0, ship09 = 0;
  for (const s in d.plan) for (const r in d.plan[s]) plan09 += d.plan[s][r]['2026-09'] || 0;
  for (const s in d.actualShip) for (const r in d.actualShip[s]) ship09 += d.actualShip[s][r]['2026-09'] || 0;
  console.log('A4 Node侧 demand.json: 分仓计划09=' + Math.round(plan09).toLocaleString() + ' 实际出货09=' + Math.round(ship09).toLocaleString());
  console.log('   generatedAt=' + d.generatedAt + '  source=' + d.source);

  // ---- A5: RDC 键必须全部落在看板 6 大标准名内（2026-09-21 新增）----
  //   背景：源表「分仓需求」sheet 曾把「华南RDC」改名为「广东RDC」，而看板全套口径只认
  //   东北/华北/华南/华中/西北/西南 RDC —— 键对不上时该仓计划不会被更新、实际出货**静默丢失**。
  //   故这里把它钉成门控：出现未登记 RDC 名即失败。
  const STD_RDC = ['东北RDC', '华北RDC', '华南RDC', '华中RDC', '西北RDC', '西南RDC'];
  const aliasHits = {};
  const scanRdc = obj => {
    const agg = {};
    for (const s in obj) for (const r in obj[s]) {
      agg[r] = (agg[r] || 0) + 1;
      if (STD_RDC.indexOf(r) < 0) aliasHits[r] = (aliasHits[r] || 0) + 1;
    }
    return agg;
  };
  const rdcPlan = scanRdc(dj.plan), rdcShip = scanRdc(dj.actualShip);
  console.log('A5 demand.json RDC 键分布:');
  console.log('   计划     :', JSON.stringify(rdcPlan));
  console.log('   实际出货 :', JSON.stringify(rdcShip));
  const badRdc = Object.keys(aliasHits);
  const missRdc = STD_RDC.filter(r => !rdcPlan[r] || !rdcShip[r]);
  console.log('   未登记 RDC 名:', badRdc.length ? '❌ ' + JSON.stringify(aliasHits) : '✅ 无');
  console.log('   缺数据的 RDC :', missRdc.length ? '❌ ' + missRdc.join(',') : '✅ 6 仓计划与实际出货齐全');
  const okRdc = badRdc.length === 0 && missRdc.length === 0;

  console.log('\n运行时错误 ' + errs.length + ' 条');
  errs.slice(0, 15).forEach(e => console.log('  ❌ ' + e));

  await browser.close();
  srv.close();
  const gate = errs.length === 0 && okPlan && okShip && okRdc && a1b.demandMerged !== false && a3.hasFallbackWarn === false;
  console.log(gate ? '\n✅ 门控通过（数据一致 + RDC 名合法 + 无回退警示 + 零运行时错误）' : '\n❌ 门控未通过');
  process.exit(gate ? 0 : 1);
})();
