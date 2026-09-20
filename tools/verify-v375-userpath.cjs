// v375 门控：复现用户真实路径 —— 冷启动后**直接**进「分仓计划优化建议」页
//
// 用户路径（2026-09-20）：打开/刷新看板 → 停在 overview → 切到「分仓计划优化建议」→ 点导出
// 修复前实测：停在 overview 时 demand.json **从未被 fetch**（_demandMerged=false、actualShipBySkuRdc 0 SKU、
//   无 ensureDemandMerged 日志）→ 该页一直按「订单口径回退值」渲染（页面+导出同为 38220）。
//
// 断言：
//   A  冷启动停在 overview：_demandReady() = false（复现前提）
//   B  切到 advice 页后，**本页自身**触发 ensureDemandMerged（不再依赖别的页面）
//   C  最终就绪：_demandReady() = true，actualShipBySkuRdc 有数据
//   D  页面数据源（buildPlanOptimAdvice，页面与导出同一入口）81014·东北RDC = 89820 / 59.3%
//   E  导出 81014·东北RDC = 89820 / 59.3%
//   F  就绪后无「回退值」警示条；F2 未就绪（已失败态）时有警示条 + 🔄 重试按钮
//   G  无运行时错误
//
// ⚠️ 断言口径教训（本文件两处踩过）：
//   ① **不要用 DOM 文本搜 SKU 判断页面值** —— 分页/默认筛选下目标行不在可见区，
//      会得到「既不含新值也不含旧值」的假失败。要断言「页面值」就读页面同源的数据函数
//      （buildPlanOptimAdvice），它才是页面与导出的共同入口。
//   ② 警示条有「⏳ 加载中」(merging=true，**无按钮**) 与「⚠ 未加载成功」(有重试按钮) 两态；
//      要验证按钮必须显式构造失败态（_demandFail>0 且 merging=false）。
const fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const LIVE = process.env.LIVE_URL || 'https://rdc-dashboard.pages.dev/';
const results = [];
const T = (n, ok, d) => { results.push({ n, ok }); console.log((ok ? '✅' : '❌') + ' ' + n + (d ? '  — ' + d : '')); };

(async () => {
  const exe = (() => { const b = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'); const c = []; for (const d of fs.readdirSync(b)) { c.push(path.join(b, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(b, d, 'chrome-win64', 'chrome.exe')); } return c.find(p => fs.existsSync(p)); })();
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [], mergeLogs = [];
  const noise = t => /Failed to load resource/i.test(t) || /\b404\b/.test(t) || /net::ERR_/.test(t);
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (/ensureDemandMerged/.test(t)) mergeLogs.push(t.slice(0, 140));
    if (m.type() === 'error' && !noise(t)) errs.push('console.error: ' + t);
  });

  await page.goto(LIVE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore.loaded === true, { timeout: 240000 });
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 180000 });

  const bv = await page.evaluate(() => BUILD_VERSION);
  T('版本号 ≥ 375（本修复引入版）', bv >= 375, 'BUILD_VERSION=' + bv);

  // ---- A 冷启动停在 overview ----
  const a = await page.evaluate(() => ({ cur: currentPage, ready: _demandReady(), shipSkus: Object.keys((dataStore.inventory && dataStore.inventory.actualShipBySkuRdc) || {}).length }));
  T('A 冷启动停在 overview（复现前提）', a.cur === 'overview', JSON.stringify(a));
  console.log('      此刻 _demandReady=' + a.ready + ' actualShip SKU 数=' + a.shipSkus);

  // ---- B/C 切到 advice 页 → 本页自身应触发并入并最终就绪 ----
  await page.evaluate(() => { window._planTab = 'advice'; navigateTo('plan-monitor'); });
  let ready = false, waited = 0;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000); waited += 1000;
    ready = await page.evaluate(() => _demandReady());
    if (ready) break;
  }
  T('B/C 切到 advice 页后自动就绪（本页自身触发）', ready === true, '耗时 ' + waited + 'ms，ensureDemandMerged 日志 ' + mergeLogs.length + ' 条');
  if (mergeLogs.length) mergeLogs.slice(0, 3).forEach(l => console.log('      ' + l));

  await page.waitForTimeout(3000);

  // ---- D 页面数据源（buildPlanOptimAdvice 是页面与导出的同一入口；
  //         直接搜 DOM 文本不可靠 —— 分页/默认筛选下 81014 可能不在当前可见行） ----
  const d = await page.evaluate(() => {
    const pg = document.getElementById('page-plan-monitor');
    const txt = pg ? pg.innerText : '';
    const all = buildPlanOptimAdvice();
    const h = all.filter(x => x.sku === '81014' && String(x.rdc).indexOf('东北') >= 0);
    const row = h[0] || {};
    return {
      planMonthIdx: window._planMonthIdx,
      shipSkus: Object.keys((dataStore.inventory && dataStore.inventory.actualShipBySkuRdc) || {}).length,
      rowShipped: row.shipped, rowPlan: row.plan, rowComp: row.comp != null ? +(row.comp * 100).toFixed(1) : null,
      banner: txt.indexOf('订单口径回退值') >= 0
    };
  });
  T('D 页面数据源 81014·东北RDC 订单 = 89820 / 59.3%',
    d.rowShipped === 89820 && d.rowComp === 59.3,
    'cov月idx=' + d.planMonthIdx + ' 实际出货表SKU数=' + d.shipSkus + ' 计划=' + d.rowPlan + ' 订单=' + d.rowShipped + ' 完成率=' + d.rowComp);

  // ---- F 就绪后无警示条 ----
  T('F 就绪后无「回退值」警示条', d.banner === false, 'banner=' + d.banner);

  // ---- E 导出 ----
  const csv = await page.evaluate(() => {
    let cap = null; const orig = window.downloadFile;
    window.downloadFile = (n, c) => { cap = c; };
    return Promise.resolve().then(() => exportPlanAdvice())
      .then(() => { window.downloadFile = orig; return cap; }, e => { window.downloadFile = orig; return 'ERR:' + e.message; });
  });
  if (typeof csv !== 'string' || csv.startsWith('ERR:')) {
    T('E 导出 81014·东北RDC = 89820 / 59.3%', false, String(csv));
  } else {
    const L = csv.split('\n').filter(l => l.startsWith('81014,'));
    const ne = L.filter(l => l.indexOf(',东北RDC,') >= 0)[0] || '';
    const c = ne.split(',');
    T('E 导出 81014·东北RDC = 89820 / 59.3%', c[7] === '89820' && c[8] === '59.3',
      '计划=' + c[6] + ' 订单=' + c[7] + ' 完成率=' + c[8] + ' 总行数=' + (csv.split('\n').length - 1));
  }

  // ---- F2 未就绪时必须给出「可见出口」：加载中(⏳) 或 失败(⚠+重试按钮) 二者之一 ----
  //   注意：renderPlanAdvice 头部现在会触发 ensureDemandMerged → 同步置 _demandMerging=true，
  //   所以正常重试中看到的是 ⏳ 态（无按钮，符合设计）；要验证 ⚠+按钮态必须构造「僵死」态。
  const f2a = await page.evaluate(() => {
    const bak = dataStore.inventory.actualShipBySkuRdc;
    _demandMerged = false; dataStore.inventory.actualShipBySkuRdc = {};
    window._demandMerging = true; window._demandMergingSince = Date.now();   // 正在合并
    renderPlanAdvice();
    const txt = (document.getElementById('page-plan-monitor') || {}).innerText || '';
    const outA = { banner: txt.indexOf('订单口径回退值') >= 0, loading: txt.indexOf('正在加载中') >= 0, retry: txt.indexOf('重试加载') >= 0 };
    // 构造「僵死」态：merging 标记超 60s → 应放行并回到可重试/失败展示
    window._demandMerging = true; window._demandMergingSince = Date.now() - 90000;
    window._demandFail = 2;
    window._demandMerging = false;   // 直接落失败态验证按钮
    renderPlanAdvice();
    const txt2 = (document.getElementById('page-plan-monitor') || {}).innerText || '';
    const outB = { banner: txt2.indexOf('订单口径回退值') >= 0, retry: txt2.indexOf('重试加载') >= 0 };
    _demandMerged = true; window._demandFail = 0; window._demandMergingSince = 0; dataStore.inventory.actualShipBySkuRdc = bak;
    return { outA, outB };
  });
  T('F2a 未就绪(合并中)时显示 ⏳ 加载中 + 回退值告知',
    f2a.outA.banner === true && f2a.outA.loading === true, JSON.stringify(f2a.outA));
  T('F2b 未就绪(失败态)时显示 ⚠ 警示条 + 🔄 重试按钮',
    f2a.outB.banner === true && f2a.outB.retry === true, JSON.stringify(f2a.outB));

  T('G 无运行时错误', errs.length === 0, errs.length ? errs.slice(0, 4).join(' | ') : '0 条');

  console.log('\n===== 汇总 =====');
  const bad = results.filter(r => !r.ok);
  console.log(bad.length ? `❌ ${bad.length}/${results.length} 项失败` : `✅ ${results.length}/${results.length} 项全部通过`);
  await browser.close(); process.exit(bad.length ? 1 : 0);
})();
