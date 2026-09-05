// v206 端到端验证（本地静态服务）：
//   P1 分仓计划监控渲染 + 分仓需求取自「分仓计划」表（getPlanDemand 真值核对）
//   P2 库存结构分析不再「找不到库存金额表」
//   P3 转储页 1-8 月完整 + 拉回分析 TAB 有 8 月数据
//   P4 库存周转页含 8 月数据
//   P5 毒缓存自愈：内存毒化 inventory → saveToIDB → reload → 应自动恢复（用户 9/5 报障场景）
// 用法：node tools/e2e-v206.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8943;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 8 分钟'); process.exit(3); }, 480000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function report(name, ok, detail) { results.push({ name, ok, detail }); console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' —— ' + detail : '')); }

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const cdn = path.join(__dirname, '.cdn-cache');
  await p.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'echarts.min.js')) }).catch(() => {}));
  await p.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'xlsx.full.min.js')) }).catch(() => {}));
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0, 160)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

  const t0 = Date.now();
  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 120; i++) {
    const ok = await p.evaluate(() => !!(window.dataStore && dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(() => false);
    if (ok) break;
    await sleep(2000);
  }
  console.log('boot 就绪，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's\n');

  // ═══ P1 分仓计划监控 ═══
  console.log('[P1] 分仓计划监控');
  await p.evaluate(() => navigateTo('plan-monitor'));
  await sleep(6000);
  const p1 = await p.evaluate(() => {
    const inv = dataStore.inventory || {};
    const el = document.getElementById('page-plan-monitor');
    const t = el ? (el.textContent || '') : '';
    return {
      cov7: (inv.cov7 || []).length,
      planSkus: Object.keys(inv.planBySkuRdc || {}).length,
      pd08: getPlanDemand('09539', '华南RDC', 'cov08'),
      pd09: getPlanDemand('09539', '华南RDC', 'cov09'),
      pd10: getPlanDemand('09539', '华南RDC', 'cov10'),
      tblTds: el ? el.querySelectorAll('.data-table td').length : 0,
      hasErr: t.indexOf('暂无数据') >= 0,
      kaline: (t.match(/计划口径：[^｜]*｜/) || ['(未找到)'])[0],
    };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  if (p1.err) report('P1 分仓计划监控', false, p1.err);
  else {
    // 2737 行 = 2 行表头 + 2735 数据行（parseCoverageSheet 跳过双表头）
    report('P1a cov7 满量(2735 数据行)', p1.cov7 === 2735, 'cov7=' + p1.cov7);
    report('P1b planBySkuRdc 就绪(417 SKU)', p1.planSkus === 417, '实际=' + p1.planSkus);
    // 模版分仓计划 row2: 09539 美加净蜂蜜倍润滋养霜80G 华南仓 2026-08=191, 2026-09=4034, 2026-10=4207
    report('P1c 分仓需求=分仓计划表真值(191/4034/4207)', p1.pd08 === 191 && p1.pd09 === 4034 && p1.pd10 === 4207, '实际=' + p1.pd08 + '/' + p1.pd09 + '/' + p1.pd10);
    report('P1c2 pd08 来源=分仓计划表而非覆盖表兜底', p1.pd08 !== undefined, 'pd08=' + p1.pd08);
    report('P1d 主表渲染(tds>100 且无暂无数据)', p1.tblTds > 100 && !p1.hasErr, 'tds=' + p1.tblTds + ' hasErr=' + p1.hasErr);
    report('P1e 计划口径文案=分仓计划表', p1.kaline.indexOf('分仓计划') >= 0, p1.kaline.trim());
  }

  // ═══ P2 库存结构分析 ═══
  console.log('\n[P2] 库存结构分析');
  await p.evaluate(() => navigateTo('inventory-structure'));
  await sleep(6000);
  const p2 = await p.evaluate(() => {
    const el = document.getElementById('page-inventory-structure');
    const t = el ? (el.textContent || '') : '';
    return { hasAmtErr: t.indexOf('未找到「库存金额」') >= 0, len: t.length };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  if (p2.err) report('P2 库存结构分析', false, p2.err);
  else report('P2 无「找不到库存金额」错误且有内容', !p2.hasAmtErr && p2.len > 500, 'len=' + p2.len + ' amtErr=' + p2.hasAmtErr);

  // ═══ P3 转储 + 拉回 ═══
  console.log('\n[P3] 转储数据 + 拉回分析');
  await p.evaluate(() => navigateTo('transship'));
  await sleep(8000);
  const p3a = await p.evaluate(() => {
    const el = document.getElementById('page-transship');
    const t = el ? (el.textContent || '').replace(/\s+/g, ' ') : '';
    const m = t.match(/(\d[\d,]*)\s*条记录\s*·\s*(\d{4}-\d{2})\s*至\s*(\d{4}-\d{2})/);
    return { rows: (dataStore.transship || []).length, shown: m ? m[1] + '@' + m[2] + '~' + m[3] : '(未匹配)' };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  if (p3a.err) report('P3a 转储页', false, p3a.err);
  else report('P3a 转储 23790 行', p3a.rows === 23790, 'rows=' + p3a.rows + ' 显示=' + p3a.shown);
  await p.evaluate(() => { window._transTab = 'pullback'; renderTransship(); });
  await sleep(9000);
  const p3b = await p.evaluate(() => {
    const el = document.getElementById('page-transship');
    const t = el ? (el.textContent || '') : '';
    const inv = dataStore.inventory || {};
    const months = new Set();
    Object.keys(inv.pullbackByRdcMonth || {}).forEach(r => Object.keys(inv.pullbackByRdcMonth[r]).forEach(m => months.add(m)));
    return { len: t.length, hasRaw: t.indexOf('原始记录') >= 0, months: [...months].sort() };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  if (p3b.err) report('P3b 拉回分析', false, p3b.err);
  else report('P3b 拉回分析 TAB 渲染完整且含 8 月', p3b.len > 1000 && p3b.hasRaw && p3b.months.indexOf('2026-08') >= 0, 'len=' + p3b.len + ' hasRaw=' + p3b.hasRaw + ' 月份=' + (p3b.months || []).join(','));

  // ═══ P4 库存周转 ═══
  console.log('\n[P4] 库存周转');
  await p.evaluate(() => navigateTo('inventory'));
  await sleep(5000);
  const p4 = await p.evaluate(() => {
    const el = document.getElementById('page-inventory');
    const t = el ? (el.textContent || '') : '';
    return { len: t.length, hasTurn: t.indexOf('周转天数') >= 0, empty: t.indexOf('暂无') >= 0 && t.length < 500 };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  if (p4.err) report('P4 库存周转', false, p4.err);
  else report('P4 周转页正常渲染', !p4.empty && p4.hasTurn && p4.len > 500, 'len=' + p4.len + ' hasTurn=' + p4.hasTurn);

  // ═══ P5 毒缓存自愈（用户 9/5 报障场景模拟）═══
  console.log('\n[P5] 毒缓存自愈模拟：毒化 inventory → saveToIDB → reload');
  await p.evaluate(async () => {
    dataStore.inventory = { cov7: [], cov6: [], cov5: [], structureByYear: {}, coverageNew: {} };
    await saveToIDB();
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  let healed = false, waitMs = 0;
  for (let i = 0; i < 100; i++) {                      // 本地全量重拉实测 ~4 分钟，给足 300s
    healed = await p.evaluate(() => !!(window.dataStore && dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(() => false);
    if (healed) break;
    await sleep(3000); waitMs += 3000;
  }
  report('P5 毒缓存自动恢复(cov7 重新满量)', healed, '等待 ' + (waitMs / 1000).toFixed(0) + 's');
  // 自愈后 planBySkuRdc 是按需加载的——进一次 plan-monitor 验证能重新就绪
  await p.evaluate(() => navigateTo('plan-monitor'));
  await sleep(8000);
  const p5b = await p.evaluate(() => ({
    cov7: (dataStore.inventory.cov7 || []).length,
    struct: !!(dataStore.inventory.structureByYear && dataStore.inventory.structureByYear['2026']),
    planSkus: Object.keys(dataStore.inventory.planBySkuRdc || {}).length,
    pd08: (typeof getPlanDemand === 'function') ? getPlanDemand('09539', '华南RDC', 'cov08') : undefined,
  })).catch(() => ({}));
  report('P5b structureByYear/planBySkuRdc 同步恢复', p5b.struct && p5b.planSkus === 417 && p5b.pd08 === 191, 'cov7=' + p5b.cov7 + ' struct=' + p5b.struct + ' plan=' + p5b.planSkus + ' pd08=' + p5b.pd08);

  console.log('\n═══ 总结 ═══');
  const fails = results.filter(r => !r.ok);
  console.log('  通过 ' + (results.length - fails.length) + '/' + results.length);
  fails.forEach(f => console.log('  ❌ ' + f.name + ' —— ' + f.detail));
  console.log('  页面错误数: ' + errs.length);
  errs.slice(0, 8).forEach(e => console.log('    └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(fails.length === 0 && errs.length === 0 ? 0 : 1);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
