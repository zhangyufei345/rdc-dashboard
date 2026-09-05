// 线上真实站点（https://rdc-dashboard.pages.dev）端到端验证 v205 的四项改动
// 用法：node tools/e2e-live-v205.js
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const URL = 'https://rdc-dashboard.pages.dev/index.html';
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 10 分钟'); process.exit(3); }, 600000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const P = [];
const chk = (name, ok, detail) => { P.push({ name, ok }); console.log('  ' + (ok ? '✅' : '❌') + ' ' + name + (detail ? '  → ' + detail : '')); };

(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext()).newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 160)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 160)); });

  console.log('打开线上站点（DB_VERSION 变更会触发一次全量重拉）...');
  const t0 = Date.now();
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    ready = await p.evaluate(() => !!(dataStore && dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(() => false);
    if (ready) break;
    await sleep(2000);
  }
  const bootSec = Math.round((Date.now() - t0) / 1000);
  console.log('  冷启动就绪: ' + ready + '  耗时 ' + bootSec + 's');
  const ver = await p.evaluate(() => DB_VERSION).catch(() => '?');
  console.log('  线上 DB_VERSION = ' + ver);
  if (!ready) { console.log('❌ 首屏未就绪，中止'); clearTimeout(HARD); await b.close(); process.exit(1); }

  // ── P1 优化建议：图形在前 + 明细折叠在后 ──
  console.log('\n[P1] 分仓计划监控 · 优化建议（用户要求：图形&对比优先，明细放最后）');
  await p.evaluate(() => { window._planTab = 'advice'; window._planMonitorRetry = 0; renderPlanAdvice(); });
  await sleep(5000);
  const adv = await p.evaluate(() => {
    const g = (id) => { const el = document.getElementById(id); return !!el && el.querySelector('canvas') !== null; };
    const dt = document.querySelector('#page-plan-monitor details');
    const first = document.querySelector('#page-plan-monitor').children[0];
    return {
      type: g('pa-chart-type'), rdc: g('pa-chart-rdc'), top: g('pa-chart-top'),
      detailsExists: !!dt, detailsOpen: dt ? dt.open : null,
      summary: dt && dt.querySelector('summary') ? dt.querySelector('summary').textContent.trim().slice(0, 40) : null,
      items: dt ? dt.querySelectorAll('[onclick*="jumpToAdviceTarget"]').length : 0,
      // 注意：优化建议页的明细是「卡片列表」不是 .data-table（所以 P2 里 plan-monitor 的 td=0）。
      //   要判的是「明细面板排在图表之后」，不是「表格排在图表之后」。
      //   位含义：2 = 参数节点(图表) 在 当前节点(明细) 之前(PRECEDING)，4 = 在其之后(FOLLOWING)。
      //   「图表在前、明细在后」→ 图表 PRECEDING 明细 → 判位 2（之前写成 4，方向反了）。
      chartsBeforeDetails: (function () {
        const dt = document.querySelector('#page-plan-monitor details');
        const ch = document.getElementById('pa-chart-top');
        if (!dt || !ch) return null;
        return (dt.compareDocumentPosition(ch) & 2) > 0;
      })(),
    };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  console.log('  ' + JSON.stringify(adv));
  chk('三张图全部渲染', !!(adv.type && adv.rdc && adv.top));
  chk('明细折叠面板在最后且默认收起', adv.detailsExists && adv.detailsOpen === false, adv.summary + ' / ' + adv.items + ' 项');
  chk('图表在明细之前（图形优先）', adv.chartsBeforeDetails === true);

  // ── P2 表格单元格 2 行封顶 ──
  console.log('\n[P2] 全看板表格单元格 ≤2 行');
  const pages = ['plan-monitor', 'transship', 'inventory-structure', 'slow-moving', 'shortage'];
  let worst = 0;
  for (const pg of pages) {
    await p.evaluate((x) => navigateTo(x), pg);
    await sleep(3500);
    const r = await p.evaluate(() => {
      const tds = Array.prototype.slice.call(document.querySelectorAll('.data-table td'));
      let maxVisual = 0, wrapped = 0, sample = '';
      tds.forEach(td => {
        if (!(td.textContent || '').trim()) return;
        const cl = td.querySelector('.td-clamp');
        if (!cl) return;
        wrapped++;
        const cs = getComputedStyle(cl);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 17;
        const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const v = Math.round(Math.max(0, cl.clientHeight - padV) / lh);
        if (v > maxVisual) { maxVisual = v; sample = (td.textContent || '').trim().slice(0, 30); }
      });
      return { tds: tds.length, wrapped, maxVisual, sample };
    }).catch(e => ({ err: e.message.slice(0, 120) }));
    console.log('    ' + (r.maxVisual <= 2 ? '✅' : '❌') + ' ' + pg.padEnd(22) + ' td=' + String(r.tds).padEnd(6) + ' 已封顶=' + String(r.wrapped).padEnd(6) + ' 视觉最大=' + r.maxVisual + '行');
    if (r.maxVisual > worst) worst = r.maxVisual;
  }
  chk('所有受检页面单元格 ≤2 行', worst <= 2, '最大 ' + worst + ' 行');

  // ── P3 转储页有数据 ──
  console.log('\n[P3] 转储数据');
  await p.evaluate(() => navigateTo('transship'));
  for (let i = 0; i < 40; i++) {
    const n = await p.evaluate(() => (dataStore.transship || []).length).catch(() => 0);
    if (n > 1000) break;
    await sleep(2000);
  }
  await sleep(4000);
  const ts = await p.evaluate(() => {
    const el = document.getElementById('page-transship');
    const t = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return { rows: (dataStore.transship || []).length, len: t.length, head: t.slice(0, 100) };
  }).catch(e => ({ err: e.message.slice(0, 120) }));
  console.log('  ' + JSON.stringify(ts));
  chk('转储数据已加载', ts.rows > 1000, ts.rows + ' 行');
  chk('转储页已渲染', ts.len > 200);

  // ── P4 plan-monitor 不再出现 cov7=0 死错误页 ──
  console.log('\n[P4] 分仓计划监控（曾报「读取三次数据后仍报错 cov7=0」）');
  await p.evaluate(() => { window._planTab = 'monitor'; window._planMonitorRetry = 0; renderPlanMonitor(); });
  await sleep(5000);
  const pm = await p.evaluate(() => {
    const el = document.getElementById('page-plan-monitor');
    const t = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return { len: t.length, dead: /cov7=0行|暂无数据/.test(t.slice(0, 600)), head: t.slice(0, 90) };
  }).catch(e => ({ err: e.message.slice(0, 120) }));
  console.log('  ' + JSON.stringify(pm));
  chk('未停在死错误页', !pm.dead);
  chk('页面正常渲染', pm.len > 500);

  console.log('\n═══════════ 线上结论 ═══════════');
  console.log('  冷启动耗时: ' + bootSec + 's');
  console.log('  页面错误数: ' + errs.length);
  errs.slice(0, 6).forEach(e => console.log('    └ ' + e));
  const failed = P.filter(x => !x.ok);
  console.log(failed.length ? ('  ❌ 失败项: ' + failed.map(x => x.name).join(' | ')) : '  ✅ 全部通过');
  clearTimeout(HARD);
  await b.close();
  process.exit(failed.length === 0 && errs.length === 0 ? 0 : 1);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
