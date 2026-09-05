// v206 线上验证：用户 9/5 晚报障的 4 个场景 + 转储页 extra 到位后重渲染存疑点复验。
// 用法：node tools/e2e-live-v206.js
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 15 分钟'); process.exit(3); }, 900000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function report(name, ok, detail) { results.push({ name, ok }); console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' —— ' + detail : '')); }

(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext()).newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0, 160)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

  const t0 = Date.now();
  await p.goto('https://rdc-dashboard.pages.dev/', { waitUntil: 'domcontentloaded' });
  let booted = false;
  for (let i = 0; i < 200; i++) {
    booted = await p.evaluate(() => !!(window.dataStore && dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(() => false);
    if (booted) break;
    await sleep(3000);
  }
  console.log('boot: ' + (booted ? '就绪' : '未就绪') + '，耗时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  report('冷启动 boot', booted);

  // P1 分仓计划监控
  console.log('\n[P1] 分仓计划监控');
  await p.evaluate(() => navigateTo('plan-monitor'));
  for (let i = 0; i < 40; i++) {
    const s = await p.evaluate(() => {
      const inv = dataStore.inventory || {};
      return { plan: Object.keys(inv.planBySkuRdc || {}).length, err: (document.getElementById('page-plan-monitor').textContent || '').indexOf('暂无数据') >= 0 };
    }).catch(() => ({}));
    if (s.plan > 0 && !s.err) break;
    await sleep(3000);
  }
  const p1 = await p.evaluate(() => {
    const inv = dataStore.inventory || {};
    const el = document.getElementById('page-plan-monitor');
    return {
      cov7: (inv.cov7 || []).length,
      plan: Object.keys(inv.planBySkuRdc || {}).length,
      pd08: getPlanDemand('09539', '华南RDC', 'cov08'),
      pd09: getPlanDemand('09539', '华南RDC', 'cov09'),
      tds: el ? el.querySelectorAll('.data-table td').length : 0,
      err: (el.textContent || '').indexOf('暂无数据') >= 0,
      ka: (el.textContent.match(/计划口径：[^｜]*｜/) || ['(未找到)'])[0].slice(0, 40),
    };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  if (p1.err) report('P1', false, p1.err);
  else {
    report('P1a cov7 满量', p1.cov7 === 2735, 'cov7=' + p1.cov7);
    report('P1b planBySkuRdc=417', p1.plan === 417, '实际=' + p1.plan);
    report('P1c 分仓需求真值(191/4034)', p1.pd08 === 191 && p1.pd09 === 4034, p1.pd08 + '/' + p1.pd09);
    report('P1d 主表渲染无错误页', p1.tds > 100 && !p1.err, 'tds=' + p1.tds);
    report('P1e 计划口径=分仓计划表', p1.ka.indexOf('分仓计划') >= 0, p1.ka);
  }

  // P2 库存结构分析
  console.log('\n[P2] 库存结构分析');
  await p.evaluate(() => navigateTo('inventory-structure'));
  await sleep(10000);
  const p2 = await p.evaluate(() => {
    const t = (document.getElementById('page-inventory-structure').textContent || '');
    return { bad: t.indexOf('未找到「库存金额」') >= 0, len: t.length };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  if (p2.err) report('P2', false, p2.err); else report('P2 库存结构正常', !p2.bad && p2.len > 500, 'len=' + p2.len);

  // P3 转储 + 重渲染复验（轮询「行数满 且 页面范围到 8 月」同时成立）
  console.log('\n[P3] 转储页（含重渲染复验）');
  await p.evaluate(() => navigateTo('transship'));
  let p3ok = false, p3 = {};
  for (let i = 0; i < 60; i++) {
    p3 = await p.evaluate(() => {
      const el = document.getElementById('page-transship');
      const t = el ? (el.textContent || '').replace(/\s+/g, ' ') : '';
      const m = t.match(/(\d[\d,]*)\s*条记录\s*·\s*(\d{4}-\d{2})\s*至\s*(\d{4}-\d{2})/);
      return { rows: (dataStore.transship || []).length, shown: m ? m[1] + '@' + m[2] + '~' + m[3] : '(未匹配)', extra: !!window._invExtraReady };
    }).catch(() => ({}));
    if (p3.rows === 23790 && /2026-08/.test(p3.shown)) { p3ok = true; break; }
    await sleep(5000);
  }
  report('P3 转储 23790 行且页面显示 1-8 月（数据与显示同步）', p3ok, 'rows=' + p3.rows + ' 显示=' + p3.shown + ' extraReady=' + p3.extra);

  // P4 库存周转
  console.log('\n[P4] 库存周转');
  await p.evaluate(() => navigateTo('inventory'));
  await sleep(8000);
  const p4 = await p.evaluate(() => {
    const t = (document.getElementById('page-inventory').textContent || '');
    return { len: t.length, hasTurn: t.indexOf('周转天数') >= 0 };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  if (p4.err) report('P4', false, p4.err); else report('P4 周转页渲染', p4.hasTurn && p4.len > 500, 'len=' + p4.len);

  console.log('\n═══ 总结 ═══');
  const fails = results.filter(r => !r.ok);
  console.log('  通过 ' + (results.length - fails.length) + '/' + results.length);
  console.log('  页面错误数: ' + errs.length);
  errs.slice(0, 6).forEach(e => console.log('    └ ' + e));
  clearTimeout(HARD);
  await b.close();
  process.exit(fails.length === 0 && errs.length === 0 ? 0 : 1);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
