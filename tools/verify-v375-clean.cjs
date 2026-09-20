// 干净路径门控：不做任何人为状态注入，纯冷启动 → 直进 advice 页 → 导出
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'application/javascript' };
const serve = () => new Promise(res => { const s = http.createServer((rq, rs) => { let p = decodeURIComponent(rq.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); rs.end('nf'); return; } rs.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' }); fs.createReadStream(f).pipe(rs); }); s.listen(0, '127.0.0.1', () => res(s)); });
const results = [];
const T = (n, ok, d) => { results.push({ n, ok }); console.log((ok ? '✅' : '❌') + ' ' + n + (d ? '  — ' + d : '')); };

(async () => {
  const srv = await serve(); const port = srv.address().port;
  const exe = (() => { const b = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'); const c = []; for (const d of fs.readdirSync(b)) { c.push(path.join(b, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(b, d, 'chrome-win64', 'chrome.exe')); } return c.find(p => fs.existsSync(p)); })();
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [], mergeLogs = [];
  const noise = t => /Failed to load resource/i.test(t) || /\b404\b/.test(t) || /net::ERR_/.test(t);
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { const t = m.text(); if (/ensureDemandMerged/.test(t)) mergeLogs.push(t.slice(0, 130)); if (m.type() === 'error' && !noise(t)) errs.push('console.error: ' + t); });

  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 });
  // 🔴 关键：等 boot 完成（不是只等 loaded）—— 否则会被 handleLogin 的收尾 navigateTo('overview') 抢走
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 120000 });
  await page.waitForTimeout(800);

  console.log('   冷启动: cur=' + await page.evaluate(() => currentPage) + ' ready=' + await page.evaluate(() => _demandReady()));

  // 纯用户路径：切到 advice 页
  await page.evaluate(() => { window._planTab = 'advice'; navigateTo('plan-monitor'); });
  let ready = false, waited = 0;
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); waited += 1000; ready = await page.evaluate(() => _demandReady()); if (ready) break; }
  T('就绪（advice 页自身触发或已被别的路径触发）', ready === true, '耗时 ' + waited + 'ms, merge 日志 ' + mergeLogs.length + ' 条');
  mergeLogs.slice(0, 2).forEach(l => console.log('      ' + l));

  await page.waitForTimeout(4000);

  // 用真实按钮点击来导出（更贴近用户操作），而不是直接调函数
  const csv = await page.evaluate(() => {
    let cap = null; const orig = window.downloadFile;
    window.downloadFile = (n, c) => { cap = c; };
    const btn = Array.from(document.querySelectorAll('#page-plan-monitor button')).filter(b => (b.textContent || '').indexOf('导出CSV') >= 0)[0];
    const clickInfo = btn ? 'found' : 'not-found';
    if (btn) btn.click();
    return new Promise(res => setTimeout(() => {
      window.downloadFile = orig;
      res({ clickInfo, cap });
    }, 4000));
  });
  if (!csv.cap) { T('导出按钮点出 CSV', false, 'clickInfo=' + csv.clickInfo); }
  else {
    const L = csv.cap.split('\n').filter(l => l.startsWith('81014,'));
    const ne = L.filter(l => l.indexOf(',东北RDC,') >= 0)[0] || '';
    const c = ne.split(',');
    T('按钮导出 81014·东北RDC = 89820 / 59.3%', c[7] === '89820' && c[8] === '59.3',
      'clickInfo=' + csv.clickInfo + ' 计划=' + c[6] + ' 订单=' + c[7] + ' 完成率=' + c[8] + ' 总行数=' + (csv.cap.split('\n').length - 1));
  }

  // 页面值：以「渲染数据源」为准（buildPlanOptimAdvice 是页面与导出的同一入口；
  // 直接搜 DOM 文本不可靠 —— 分页/默认筛选下 81014 可能不在当前可见行）
  const pgv = await page.evaluate(() => {
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
  T('页面数据源 81014·东北 shipped = 89820 / 59.3%',
    pgv.rowShipped === 89820 && pgv.rowComp === 59.3,
    'cov月idx=' + pgv.planMonthIdx + ' 实际出货表SKU数=' + pgv.shipSkus + ' 计划=' + pgv.rowPlan + ' 订单=' + pgv.rowShipped + ' 完成率=' + pgv.rowComp);
  T('无「回退值」警示条（已就绪）', pgv.banner === false, 'banner=' + pgv.banner);

  // ---- H 根因回归：重建 dataStore.inventory 后 actualShipBySkuRdc 必须存活 ----
  //   L14798 是白名单对象字面量，未列出字段一律丢弃。demand.json 并入字段曾不在白名单 →
  //   重载 inventory-plan.json / inventory-extra.json 即静默清空 → 回退 38220（用户 9/20 报的问题）。
  const before = await page.evaluate(() => Object.keys((dataStore.inventory && dataStore.inventory.actualShipBySkuRdc) || {}).length);
  await page.evaluate(async () => {
    // 模拟「重新解析库存文件」——走同一白名单重建路径
    window._invPlanReady = false; window._invExtraReady = false;
    if (typeof ensureInventoryPlan === 'function') await ensureInventoryPlan();
    if (typeof ensureInventoryExtra === 'function') await ensureInventoryExtra();
  });
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => ({
    shipSkus: Object.keys((dataStore.inventory && dataStore.inventory.actualShipBySkuRdc) || {}).length,
    metaSkus: Object.keys((dataStore.inventory && dataStore.inventory.demandMeta) || {}).length,
    ready: _demandReady(),
    aShip: (typeof _actualShipOf === 'function') ? _actualShipOf('81014', '东北RDC', '2026-09') : 'NOFN'
  }));
  T('H 重建 inventory 后 实际出货表存活（根因回归）',
    after.shipSkus > 0 && Number(after.aShip) === 89820,
    '重建前=' + before + ' 重建后=' + after.shipSkus + ' SKU, demandMeta=' + after.metaSkus + ' SKU, _actualShipOf=' + after.aShip + ', _demandReady=' + after.ready);

  // 重建后再导出，仍必须是 89820
  const csv2 = await page.evaluate(() => {
    let cap = null; const orig = window.downloadFile;
    window.downloadFile = (n, c) => { cap = c; };
    return Promise.resolve().then(() => exportPlanAdvice()).then(() => { window.downloadFile = orig; return cap; }, e => { window.downloadFile = orig; return 'ERR:' + e.message; });
  });
  if (typeof csv2 !== 'string' || csv2.startsWith('ERR:')) T('H2 重建后导出仍 = 89820', false, String(csv2));
  else {
    const L = csv2.split('\n').filter(l => l.startsWith('81014,'));
    const ne = L.filter(l => l.indexOf(',东北RDC,') >= 0)[0] || '';
    const c = ne.split(',');
    T('H2 重建后导出仍 = 89820 / 59.3%', c[7] === '89820' && c[8] === '59.3', '计划=' + c[6] + ' 订单=' + c[7] + ' 完成率=' + c[8]);
  }
  T('无运行时错误', errs.length === 0, errs.length ? errs.slice(0, 4).join(' | ') : '0 条');

  console.log('\n===== 汇总 =====');
  const bad = results.filter(r => !r.ok);
  console.log(bad.length ? `❌ ${bad.length}/${results.length} 项失败` : `✅ ${results.length}/${results.length} 项全部通过`);
  await browser.close(); srv.close(); process.exit(bad.length ? 1 : 0);
})();
