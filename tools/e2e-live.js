// 线上真实站点端到端验证（不是本地静态文件）
// 用法：node tools/e2e-live.js
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const URL = 'https://rdc-dashboard.pages.dev/index.html';
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 8 分钟'); process.exit(3); }, 480000);

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));

(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext()).newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 180)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 180)); });

  console.log('打开线上站点（DB_VERSION 变更会触发一次全量重拉）...');
  const t0 = Date.now();
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    ready = await p.evaluate(() => !!(dataStore && dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(() => false);
    if (ready) break;
    await p.waitForTimeout(2000);
  }
  console.log('首屏就绪: ' + ready + '  耗时 ' + Math.round((Date.now() - t0) / 1000) + 's');
  if (!ready) { console.log('❌ 首屏未就绪，中止'); process.exit(1); }

  const v = await p.evaluate(() => DB_VERSION);
  console.log('线上 DB_VERSION = ' + v);

  console.log('\n触发三个按需加载器（v204 修复点）...');
  const before = errs.length;
  const r = await p.evaluate(async () => {
    await ensureTransship();
    await ensureInventoryExtra();
    await ensureInventoryPlan();
    return {
      transship: (dataStore.transship || []).length,
      pullback: (dataStore.inventory.pullbackRows || []).length,
      planSku: Object.keys(dataStore.inventory.planBySkuRdc || {}).length
    };
  });
  console.log('  ' + JSON.stringify(r));
  const newErrs = errs.slice(before);
  console.log('  加载期间错误: ' + newErrs.length);
  newErrs.forEach((e) => console.log('    └ ' + e));

  console.log('\n逐页渲染检查...');
  const PAGES = ['transship', 'slow-moving', 'plan-monitor', 'inventory-structure'];
  let pageFail = 0;
  for (const pg of PAGES) {
    const be = errs.length;
    await p.evaluate((x) => navigateTo(x), pg);
    await p.waitForTimeout(5000);
    const t = await p.evaluate((x) => {
      const el = document.getElementById('page-' + x);
      const s = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
      return { len: s.length, fail: /加载失败|请导入数据/.test(s.slice(0, 500)), head: s.slice(0, 90) };
    }, pg);
    const ne = errs.length - be;
    if (t.fail || ne) pageFail++;
    console.log('  ' + ((t.fail || ne) ? '❌' : '✅') + ' ' + pad(pg, 20) + ' 文本' + pad(t.len, 6) + ' 错误' + ne);
    if (t.fail) console.log('     ⚠️ 空态: ' + t.head);
  }

  console.log('\n═══════════ 线上结论 ═══════════');
  const ok = r.transship > 10000 && r.pullback > 10000 && r.planSku > 100 && errs.length === 0 && pageFail === 0;
  console.log('  总错误数: ' + errs.length + ' | 异常页面: ' + pageFail);
  errs.slice(0, 6).forEach((e) => console.log('    └ ' + e));
  console.log(ok ? '  ✅ 线上 v204 修复生效，按需数据正常加载，页面无报错'
    : '  ❌ 线上存在异常，见上');
  clearTimeout(HARD);
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
