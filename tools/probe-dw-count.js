// v336 排查：补货建议「下调预警」卡片为什么只有 10 条？
// 目标：用真实数据统计 buildPlanOptimAdvice() 输出的下调候选池规模，区分「池子小」和「被截断」。
// 用法：node tools/probe-dw-count.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8977;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 8 分钟'); process.exit(3); }, 480000);

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext()).newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const cdn = path.join(__dirname, '.cdn-cache');
  await p.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'echarts.min.js')) }).catch(() => {}));
  await p.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'xlsx.full.min.js')) }).catch(() => {}));
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0, 160)));

  console.log('加载页面（本地）...');
  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });

  for (let i = 0; i < 120; i++) {
    const ok = await p.evaluate(() => !!(typeof dataStore !== 'undefined' && dataStore.loaded && (dataStore.orderDetail || []).length > 100000)).catch(() => false);
    if (ok) { console.log('  数据就绪 (等待 ' + (i * 2) + 's)'); break; }
    if (i === 119) { console.log('  ❌ 数据未就绪'); }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('进入补货建议页（触发 renderReplenishment + ensureInventoryPlan ~22s）...');
  await p.evaluate(() => navigateTo('replenishment')).catch(() => {});
  let ready = false;
  for (let i = 0; i < 90; i++) {
    const n = await p.evaluate(() => (window._dwList || []).length).catch(() => 0);
    const planReady = await p.evaluate(() => !!window._invPlanReady).catch(() => false);
    if (n > 0 && planReady) { ready = true; console.log('  _dwList 就绪: ' + n + ' 条 (等待 ' + (i * 2) + 's)'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!ready) console.log('  ⚠️ 未在时限内拿到 _dwList，继续读取当前状态');

  const res = await p.evaluate(() => {
    const out = {};
    out.buildOk = (typeof buildPlanOptimAdvice === 'function');
    out.rdcFilter = (typeof rdcFilter !== 'undefined') ? rdcFilter : '(?)';
    out.month = (typeof filters !== 'undefined') ? filters.dataMonth : '(?)';
    out.planMonthIdx = window._planMonthIdx;
    out.planRdc = window._planRdc || '(unset)';
    out.invPlanReady = !!window._invPlanReady;
    out.planSkuKeys = ((dataStore.inventory || {}).planBySkuRdc) ? Object.keys(dataStore.inventory.planBySkuRdc).length : 0;
    const all = (typeof buildPlanOptimAdvice === 'function') ? (buildPlanOptimAdvice() || []) : [];
    out.total = all.length;
    const down = all.filter(r => r.direction === '下调分仓计划');
    const warnOnly = all.filter(r => r.direction !== '下调分仓计划' && r.downScore != null && r.downScore >= 0.45);
    out.downCount = down.length;
    out.warnOnlyCount = warnOnly.length;
    out.unionCount = down.length + warnOnly.length;
    // 淘汰品过滤
    const _pm = (dataStore.inventory && dataStore.inventory.productMaster) || {};
    const keep = (down.concat(warnOnly)).filter(function (r) {
      const _skuN = (typeof normSkuCode === 'function') ? normSkuCode(r.sku) : r.sku;
      const _sm = window._skuMasterMap && (window._skuMasterMap[r.sku] || window._skuMasterMap[_skuN]);
      if (_sm && _sm.obsolete) return false;
      if ((_pm[r.sku] && _pm[r.sku].obsolete) || (_pm[_skuN] && _pm[_skuN].obsolete)) return false;
      return true;
    });
    out.afterObsoleteFilter = keep.length;
    // 按 RDC 分布
    const byRdc = {};
    keep.forEach(r => { byRdc[r.rdc] = (byRdc[r.rdc] || 0) + 1; });
    out.byRdc = byRdc;
    out.dwListLen = (window._dwList || []).length;
    out.dwFirst3 = (window._dwList || []).slice(0, 3).map(r => r.sku + '@' + r.rdc + ' plan=' + r.plan + ' decay=' + r.demandDecay);
    // 保持态但 downScore 高（未达 0.45 的不计）
    out.keepWithHighDown = all.filter(r => r.direction !== '下调分仓计划' && r.downScore != null && r.downScore >= 0.45).length;
    // v336: 渲染层校验——下调预警卡片实际渲染了多少行
    const card = Array.from(document.querySelectorAll('.card')).find(c => (c.textContent || '').includes('下调预警'));
    out.cardHeader = card ? (card.querySelector('.card-header') || {}).textContent.replace(/\s+/g, ' ').trim() : '(未找到卡片)';
    out.cardRows = card ? card.querySelectorAll('tbody tr').length : 0;
    return out;
  }).catch(e => ({ err: String(e).slice(0, 300) }));

  console.log('\n===== 结果 =====');
  console.log(JSON.stringify(res, null, 2));
  console.log('\n页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('  └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
