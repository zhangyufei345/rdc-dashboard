// v339 回归验证：下调预警入选口径 = ①demandDecay>0 硬条件 ②阈值 0.50
// 用法：node tools/verify-v339.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8981;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 9 分钟'); process.exit(3); }, 540000);

const check = () => {
  const dw = window._dwList || [];
  const valDist = {}; dw.forEach(r => { const k = String(r.demandDecay); valDist[k] = (valDist[k] || 0) + 1; });
  const noDecay = dw.filter(r => !(r.demandDecay > 0));
  const downs = dw.filter(r => r.direction === '下调分仓计划');
  const warns = dw.filter(r => r.direction !== '下调分仓计划');
  const warnMin = warns.length ? Math.min(...warns.map(r => r.downScore || 0)) : null;
  const warnBad = warns.filter(r => !((r.downScore || 0) >= 0.50));
  const downNoDecay = downs.filter(r => !(r.demandDecay > 0));
  // 旧口径对比（用同一份全量重算）
  const all = (typeof buildPlanOptimAdvice === 'function') ? (buildPlanOptimAdvice() || []) : [];
  const oldElig = all.filter(r => r.direction === '下调分仓计划' || (r.downScore != null && r.downScore >= 0.45));
  const newElig = all.filter(r => (r.demandDecay > 0) && (r.direction === '下调分仓计划' || (r.downScore != null && r.downScore >= 0.50)));
  // 被砍掉的条目：0.45~0.50 区间的预警态
  const cutByThreshold = oldElig.filter(r => (r.demandDecay > 0) && r.direction !== '下调分仓计划' && r.downScore != null && r.downScore >= 0.45 && r.downScore < 0.50);
  const cutByDecay = oldElig.filter(r => !(r.demandDecay > 0));
  return {
    dwLen: dw.length, valDist, noDecayCnt: noDecay.length,
    downCnt: downs.length, warnCnt: warns.length,
    warnMin: warnMin == null ? null : +warnMin.toFixed(3), warnBadCnt: warnBad.length,
    downNoDecayCnt: downNoDecay.length,
    adviceTotal: all.length,
    oldEligCnt: oldElig.length, newEligCnt: newElig.length,
    cutByThresholdCnt: cutByThreshold.length,
    cutByThresholdTop: cutByThreshold.slice(0, 6).map(r => r.sku + '@' + r.rdc + ' down=' + (r.downScore || 0).toFixed(3) + ' decay=' + r.demandDecay),
    cutByDecayCnt: cutByDecay.length,
    dwRdcDist: (() => { const m = {}; dw.forEach(r => { m[r.rdc] = (m[r.rdc] || 0) + 1; }); return m; })(),
  };
};

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const cdn = path.join(__dirname, '.cdn-cache');
  await p.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'echarts.min.js')) }).catch(() => {}));
  await p.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'xlsx.full.min.js')) }).catch(() => {}));
  const errs = []; p.on('pageerror', e => errs.push(e.message.slice(0, 200)));

  console.log('冷加载页面...');
  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 150; i++) {
    const ok = await p.evaluate(() => !!(typeof dataStore !== 'undefined' && dataStore.loaded && (dataStore.orderDetail || []).length > 100000)).catch(() => false);
    if (ok) { console.log('  基础数据就绪 (' + (i * 2) + 's)'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  await p.evaluate(() => navigateTo('replenishment')).catch(() => {});
  for (let i = 0; i < 60; i++) {
    const n = await p.evaluate(() => { const _pb = (dataStore.inventory || {}).planBySkuRdc; return _pb ? Object.keys(_pb).length : 0; }).catch(() => 0);
    if (n > 100) { console.log('  planBySkuRdc keys=' + n + ' (' + (i * 2) + 's)'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  await p.evaluate(() => { window._replRdc = 'all'; renderReplenishment(); }).catch(e => console.log('渲染异常 ' + String(e).slice(0, 150)));
  await new Promise(r => setTimeout(r, 3000));

  const v = await p.evaluate(check);
  const rows = await p.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.card')).find(c => (c.textContent || '').includes('下调预警'));
    return card ? card.querySelectorAll('tbody tr').length : -1;
  });
  const ver = await p.evaluate(() => (document.title || ''));

  console.log('\n================ v339 新口径验证 ================');
  console.log('  BUILD/title        : ' + ver);
  console.log('  _dwList 条数        : ' + v.dwLen + '   (v338 旧口径 262)');
  console.log('  卡片 DOM 渲染行数    : ' + rows);
  console.log('  demandDecay 去重分布 : ' + JSON.stringify(v.valDist));
  console.log('  其中无衰减(<=0)条数  : ' + v.noDecayCnt + '   ← 必须为 0');
  console.log('  direction=下调分仓计划: ' + v.downCnt + ' 条');
  console.log('  预警态(非下调)       : ' + v.warnCnt + ' 条，最低 downScore = ' + v.warnMin + '   ← 必须 >= 0.5');
  console.log('  预警态低于 0.50 的   : ' + v.warnBadCnt + '   ← 必须为 0');
  console.log('  已下调但无衰减的     : ' + v.downNoDecayCnt + '   ← 必须为 0');
  console.log('  RDC 分布            : ' + JSON.stringify(v.dwRdcDist));
  console.log('\n  ---- 全量口径对比（buildPlanOptimAdvice ' + v.adviceTotal + ' 条）----');
  console.log('  旧口径(0.45, 无衰减要求) 入选 : ' + v.oldEligCnt);
  console.log('  新口径(须衰减, 0.50)     入选 : ' + v.newEligCnt);
  console.log('  因阈值 0.45→0.50 被剔除      : ' + v.cutByThresholdCnt + ' 条');
  v.cutByThresholdTop.forEach(s => console.log('      └ ' + s));
  console.log('  因「无衰减」被剔除           : ' + v.cutByDecayCnt + ' 条');
  console.log('\n  页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('    └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
