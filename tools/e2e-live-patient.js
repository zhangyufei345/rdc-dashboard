// 耐心线上验证：从零加载 rdc-dashboard.pages.dev，等待全量 boot 完成后再逐页核验。
// 目的：定论「用户看到空页面」到底是代码/数据问题，还是纯浏览器缓存。
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const URL = 'https://rdc-dashboard.pages.dev/rdc-dashboard.html';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext();
  await ctx.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  p.on('pageerror', e => errs.push('[PAGEERROR] ' + e.message.slice(0, 200)));

  console.log('① 打开线上站…');
  await p.goto(URL, { waitUntil: 'domcontentloaded' });

  // 等待全量 boot：dataStore.loaded 且 cov7 满量
  let loaded = false, cov7 = 0, ord = 0, booting = true, waited = 0;
  const MAX = 12 * 60; // 12 分钟
  for (let i = 0; i < MAX / 15; i++) {
    const s = await p.evaluate(() => ({
      loaded: !!(window.dataStore && dataStore.loaded),
      cov7: (window.dataStore && dataStore.inventory && dataStore.inventory.cov7 || []).length,
      ord: (window.dataStore && dataStore.orderDetail || []).length,
      booting: !!window._bootLoading,
      ver: (typeof DB_VERSION !== 'undefined') ? DB_VERSION : 'UNDEF',
    })).catch(() => ({ loaded: false, cov7: 0, ord: 0, booting: true, ver: '?' }));
    cov7 = s.cov7; ord = s.ord; booting = s.booting; loaded = s.loaded;
    if ((i % 2) === 0) console.log(`  t=${(waited/60).toFixed(1)}min ver=${s.ver} loaded=${s.loaded} cov7=${s.cov7} ord=${s.ord} booting=${s.booting}`);
    if (loaded && s.cov7 > 100) { console.log(`✅ boot 完成 @ ${(waited/60).toFixed(1)}min | cov7=${s.cov7} ord=${s.ord}`); break; }
    await sleep(15000); waited += 15;
  }
  if (!(loaded && cov7 > 100)) {
    console.log(`❌ boot 未在 ${MAX/60}min 内完成：loaded=${loaded} cov7=${cov7} ord=${ord} booting=${booting}`);
    console.log('早期错误:', errs.slice(0, 10).join('\n  '));
    await b.close(); process.exit(1);
  }

  // 逐页核验
  const check = async (page, label, expectText) => {
    await p.evaluate((pg) => { if (typeof navigateTo === 'function') navigateTo(pg); }, page);
    await sleep(6000);
    const r = await p.evaluate((pg) => {
      const el = document.getElementById('page-' + pg);
      const t = el ? (el.textContent || '') : '';
      return { len: t.length, empty: t.indexOf('暂无') >= 0 && t.length < 600, hasErr: t.indexOf('找不到') >= 0 || t.indexOf('未找到') >= 0 };
    }, page).catch(e => ({ err: e.message }));
    const ok = r.err ? false : (!r.empty && !r.hasErr && r.len > 400);
    console.log(`  [${label}] ${ok ? '✅' : '❌'} len=${r.len} empty=${r.empty} hasErr=${r.hasErr} ${r.err?('err='+r.err):''}`);
    return ok;
  };

  console.log('② 逐页核验：');
  const r1 = await check('plan-monitor', '分仓计划监控');
  const r2 = await check('inventory-structure', '库存结构分析');
  const r3 = await check('inventory-turnover', '库存周转');
  const r4 = await check('transship', '转储数据');

  // 分仓计划监控真值核对
  const truth = await p.evaluate(() => {
    const pd = (window.dataStore && dataStore.inventory && dataStore.inventory.planBySkuRdc) || {};
    const skus = Object.keys(pd).length;
    const cell = pd['09539'] && pd['09539']['华南RDC'];
    return { skus, hn: cell ? cell : null };
  }).catch(() => ({}));
  console.log(`  分仓需求真值：planBySkuRdc SKU=${truth.skus} 09539/华南RDC=${JSON.stringify(truth.hn)}`);

  console.log('页面错误数(log):', errs.length);
  const allOk = r1 && r2 && r3 && r4 && truth.skus > 100;
  console.log(allOk ? '\n✅ 全部通过：线上站从零加载后所有页面均有数据' : '\n❌ 存在失败项，需进一步排查');
  await b.close();
  process.exit(allOk ? 0 : 2);
})().catch(e => { console.error('FATAL', e.message); process.exit(3); });
