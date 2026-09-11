// v336 排查：下调预警候选池在不同时刻是否一致？
// 背景：probe-dw-count.js 两次运行分别得到 262 / 604 条，需确认是否 buildPlanOptimAdvice() 依赖
//       dataStore.inventory.planBySkuRdc（分仓计划表）是否已加载——未加载会走 legacy 分支，口径不同。
// 用法：node tools/probe-dw-stages.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8978;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 9 分钟'); process.exit(3); }, 540000);

const snap = () => {
  const _pb = (dataStore.inventory || {}).planBySkuRdc;
  const o = {
    loaded: !!(typeof dataStore !== 'undefined' && dataStore.loaded),
    invPlanReady: !!window._invPlanReady,
    planSkuKeys: _pb ? Object.keys(_pb).length : 0,
    planRdc: window._planRdc || '(unset)',
    dwLen: (window._dwList || []).length,
    dwFirst3: (window._dwList || []).slice(0, 3).map(r => r.sku + '@' + r.rdc),
  };
  try {
    const all = buildPlanOptimAdvice() || [];
    o.adviceLen = all.length;
    o.down = all.filter(r => r.direction === '下调分仓计划').length;
    o.warn = all.filter(r => r.direction !== '下调分仓计划' && r.downScore != null && r.downScore >= 0.45).length;
    o.eligible = o.down + o.warn;
    // 第一条下调候选（排序前）
    const d0 = all.filter(r => r.direction === '下调分仓计划' || (r.downScore != null && r.downScore >= 0.45))[0];
    o.firstRaw = d0 ? (d0.sku + '@' + d0.rdc + ' plan=' + d0.plan + ' decay=' + d0.demandDecay + ' down=' + d0.downScore) : '';
  } catch (e) { o.adviceErr = String(e).slice(0, 120); }
  return o;
};

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext();          // 全新 context = 冷 IndexedDB
  const p = await ctx.newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const cdn = path.join(__dirname, '.cdn-cache');
  await p.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'echarts.min.js')) }).catch(() => {}));
  await p.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'xlsx.full.min.js')) }).catch(() => {}));
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0, 200)));

  console.log('冷加载页面...');
  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 150; i++) {
    const ok = await p.evaluate(() => !!(typeof dataStore !== 'undefined' && dataStore.loaded && (dataStore.orderDetail || []).length > 100000)).catch(() => false);
    if (ok) { console.log('  基础数据就绪 (' + (i * 2) + 's)'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }

  const show = (tag, s) => {
    console.log('\n--- ' + tag + ' ---');
    console.log('  _invPlanReady=' + s.invPlanReady + '  planBySkuRdc keys=' + s.planSkuKeys + '  window._planRdc=' + s.planRdc);
    console.log('  advice 总条数=' + s.adviceLen + '  下调=' + s.down + '  预警=' + s.warn + '  合计=' + s.eligible);
    console.log('  window._dwList 长度=' + s.dwLen + '  前3=' + JSON.stringify(s.dwFirst3));
    if (s.adviceErr) console.log('  advice 调用异常: ' + s.adviceErr);
  };

  console.log('\n[阶段1] 刚进页面（不等 plan 加载）...');
  await p.evaluate(() => navigateTo('replenishment')).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
  show('阶段1 · 进入补货建议页 3s 后', await p.evaluate(snap));

  console.log('\n[阶段2] 等待 planBySkuRdc 加载完（最多 90s）...');
  for (let i = 0; i < 45; i++) {
    const n = await p.evaluate(() => { const _pb = (dataStore.inventory || {}).planBySkuRdc; return _pb ? Object.keys(_pb).length : 0; }).catch(() => 0);
    if (n > 100) { console.log('  planBySkuRdc 就绪 keys=' + n + ' (' + (i * 2) + 's)'); break; }
    if (i === 44) console.log('  ❌ 90s 内 planBySkuRdc 仍未就绪');
    await new Promise(r => setTimeout(r, 2000));
  }
  show('阶段2 · plan 就绪但未重渲染', await p.evaluate(snap));

  console.log('\n[阶段3] 手动重渲染 renderReplenishment() 后...');
  await p.evaluate(() => renderReplenishment()).catch(e => console.log('  渲染异常 ' + String(e).slice(0, 120)));
  await new Promise(r => setTimeout(r, 3000));
  show('阶段3 · 重渲染后', await p.evaluate(snap));

  const rows = await p.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.card')).find(c => (c.textContent || '').includes('下调预警'));
    return card ? card.querySelectorAll('tbody tr').length : -1;
  });
  console.log('\n  下调预警卡片实际渲染行数=' + rows);
  console.log('  页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('    └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
