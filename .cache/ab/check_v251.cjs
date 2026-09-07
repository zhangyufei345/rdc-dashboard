// v251 数据部署线上复核：确认 9 月订单已补入 09-04/09-05，且关键指标无异常
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const URL = 'https://rdc-dashboard.pages.dev/index.html';
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 6 分钟'); process.exit(3); }, 360000);

(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext()).newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 180)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 180)); });

  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    ready = await p.evaluate(() => !!(dataStore && dataStore.loaded && dataStore.orderDetail && dataStore.orderDetail.length > 200000)).catch(() => false);
    if (ready) break;
    await p.waitForTimeout(2000);
  }
  if (!ready) { console.log('❌ 数据未就绪'); process.exit(1); }

  const r = await p.evaluate(() => {
    let maxD = '';
    const byMonth = {};
    dataStore.orderDetail.forEach((d) => {
      const s = String(d.dateStr || '').slice(0, 7);
      if (s) byMonth[s] = (byMonth[s] || 0) + 1;
      if ((d.dateStr || '') > maxD) maxD = d.dateStr;
    });
    const sep = {};
    dataStore.orderDetail.forEach((d) => {
      if (String(d.dateStr || '').slice(0, 7) === '2026-09') sep[d.dateStr] = (sep[d.dateStr] || 0) + 1;
    });
    return {
      build: (typeof BUILD_VERSION !== 'undefined') ? BUILD_VERSION : null,
      db: (typeof DB_VERSION !== 'undefined') ? DB_VERSION : null,
      title: document.title,
      orderDetail: dataStore.orderDetail.length,
      shortage: (dataStore.shortage || []).length,
      maxDate: maxD,
      sepByDay: sep,
      months: byMonth,
      overviewDate: (typeof window._overviewDate !== 'undefined') ? window._overviewDate : (window.overviewDate || null),
      unreleased: (dataStore.unreleasedOrders || []).length,
      other: (dataStore.otherOrders || []).length,
      shipCond: Object.keys(dataStore.shipCondRdcMap || {}).length
    };
  });

  console.log(JSON.stringify(r, null, 1));
  console.log('页面错误数:', errs.length);
  errs.slice(0, 8).forEach((e) => console.log('  └ ' + e));

  const ok = r.build === 251 && r.orderDetail > 239000 && r.maxDate === '2026-09-05' &&
    r.shortage > 8300 && errs.length === 0;
  console.log(ok ? '\n✅ v251 线上数据核对通过（9 月已补入 09-05）' : '\n❌ 核对未通过，见上');

  clearTimeout(HARD);
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
