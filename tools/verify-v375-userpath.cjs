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
//   D  页面 81014·东北RDC 显示 89820（实际出货口径），非 38220
//   E  导出 81014·东北RDC = 89820 / 59.3%
//   F  就绪后无「回退值」警示条；未就绪时有（且含重试按钮）
//   G  无运行时错误
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
  T('版本号 = 375', bv === 375, 'BUILD_VERSION=' + bv);

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

  // ---- D 页面显示值 ----
  const d = await page.evaluate(() => {
    const pg = document.getElementById('page-plan-monitor');
    if (!pg) return { err: 'no page' };
    const rows = [];
    pg.querySelectorAll('tr').forEach(tr => {
      const t = (tr.innerText || '').replace(/\s+/g, ' ');
      if (t.indexOf('81014') >= 0 && t.indexOf('东北') >= 0) rows.push(t);
    });
    return { banner: (pg.innerText || '').indexOf('订单口径回退值') >= 0, rows, has89820: (pg.innerText || '').indexOf('89820') >= 0, has38220: (pg.innerText || '').indexOf('38220') >= 0 };
  });
  T('D 页面 81014·东北RDC 显示 89820（非 38220）', d.has89820 === true && d.has38220 === false, '含89820=' + d.has89820 + ' 含38220=' + d.has38220);
  d.rows.slice(0, 2).forEach(r => console.log('      ' + r.slice(0, 180)));

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

  // ---- F2 未就绪时警示条必须可见（人为打回） ----
  const f2 = await page.evaluate(() => {
    const bak = dataStore.inventory.actualShipBySkuRdc;
    _demandMerged = false; window._demandMerging = false; window._demandFail = 0;
    dataStore.inventory.actualShipBySkuRdc = {};
    renderPlanAdvice();
    const pg = document.getElementById('page-plan-monitor');
    const txt = pg ? pg.innerText : '';
    const out = { banner: txt.indexOf('订单口径回退值') >= 0, retry: txt.indexOf('重试加载') >= 0 };
    _demandMerged = true; dataStore.inventory.actualShipBySkuRdc = bak;
    return out;
  });
  T('F2 未就绪时警示条 + 重试按钮可见', f2.banner === true && f2.retry === true, JSON.stringify(f2));

  T('G 无运行时错误', errs.length === 0, errs.length ? errs.slice(0, 4).join(' | ') : '0 条');

  console.log('\n===== 汇总 =====');
  const bad = results.filter(r => !r.ok);
  console.log(bad.length ? `❌ ${bad.length}/${results.length} 项失败` : `✅ ${results.length}/${results.length} 项全部通过`);
  await browser.close(); process.exit(bad.length ? 1 : 0);
})();
