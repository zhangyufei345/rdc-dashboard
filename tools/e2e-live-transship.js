// 线上验证 v205.1：直接进转储页（不经过任何其他页面）应拿到完整 1-8 月数据。
// 修复前线上表现：直接进 = 16523 条（1-6 月）；先进分仓计划监控再回来 = 23790 条（1-8 月）。
// 用法：node tools/e2e-live-transship.js
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 8 分钟'); process.exit(3); }, 480000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const URL = 'https://rdc-dashboard.pages.dev/';

(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext()).newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0, 160)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

  const t0 = Date.now();
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 120; i++) {
    const ok = await p.evaluate(() => !!(window.dataStore && dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(() => false);
    if (ok) break;
    await sleep(2000);
  }
  console.log('boot 就绪，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  // ── 路径 A：boot 后直接导航到转储页（模拟用户点侧边栏「转储数据」）──
  console.log('\n[路径A] boot 完成后直接 navigateTo("transship")');
  await p.evaluate(() => navigateTo('transship'));
  let prev = -1, stable = 0, rows = 0;
  for (let i = 0; i < 60; i++) {                       // 等 inventory-extra 异步回来，连续 3 次一致才算稳
    rows = await p.evaluate(() => (dataStore.transship || []).length).catch(() => 0);
    if (rows === prev) { stable++; if (stable >= 3) break; } else stable = 0;
    prev = rows;
    await sleep(2000);
  }
  const a = await p.evaluate(() => {
    const el = document.getElementById('page-transship');
    const t = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const m = t.match(/(\d+)条记录\s*·\s*(\d{4}-\d{2})\s*至\s*(\d{4}-\d{2})/);
    return { rows: (dataStore.transship || []).length, range: m ? (m[2] + ' 至 ' + m[3]) : '(未解析到)', extraReady: !!window._invExtraReady };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  console.log('  转储行数 = ' + a.rows + '   页面显示范围 = ' + a.range + '   _invExtraReady = ' + a.extraReady);

  // ── 路径 B：plan-monitor → 转储，应与 A 一致 ──
  console.log('\n[路径B] plan-monitor → transship');
  await p.evaluate(() => navigateTo('plan-monitor'));
  await sleep(8000);
  await p.evaluate(() => navigateTo('transship'));
  await sleep(8000);
  const bb = await p.evaluate(() => {
    const el = document.getElementById('page-transship');
    const t = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const m = t.match(/(\d+)条记录\s*·\s*(\d{4}-\d{2})\s*至\s*(\d{4}-\d{2})/);
    return { rows: (dataStore.transship || []).length, range: m ? (m[2] + ' 至 ' + m[3]) : '(未解析到)' };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  console.log('  转储行数 = ' + bb.rows + '   页面显示范围 = ' + bb.range);

  console.log('\n═══ 结论 ═══');
  const same = a.rows === bb.rows && a.range === bb.range;
  const full = a.rows > 23000 && /至\s*2026-08/.test(a.range);
  console.log('  ① 两条路径结果一致  : ' + (same ? '✅' : '❌ A=' + a.rows + '/' + a.range + '  B=' + bb.rows + '/' + bb.range));
  console.log('  ② 直接进即完整1-8月 : ' + (full ? '✅ ' + a.rows + ' 条' : '❌ 仅 ' + a.rows + ' 条（' + a.range + '）'));
  console.log('  页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('    └ ' + e));
  clearTimeout(HARD);
  await b.close();
  process.exit(same && full && errs.length === 0 ? 0 : 1);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
