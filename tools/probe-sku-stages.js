// v337 二阶段探针：确认 _dwList 的 4 位 SKU 是「早渲染遗留」还是「当前 buildPlanOptimAdvice 也去零」
// 用法：node tools/probe-sku-stages.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8983;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 8 分钟'); process.exit(3); }, 480000);

const snap = `(() => {
  const out = {};
  const pb = (dataStore.inventory || {}).planBySkuRdc || {};
  const ks = Object.keys(pb);
  out.pbKeys = ks.length; out.pbHas09539 = ks.indexOf('09539') >= 0; out.pbHas9539 = ks.indexOf('9539') >= 0;
  out.invPlanReady = !!window._invPlanReady;
  out.dwLen = (window._dwList || []).length;
  out.dwLeadZero = (window._dwList || []).filter(r => String(r.sku).charAt(0) === '0').length;
  out.dwFourDigit = Array.from(new Set((window._dwList || []).filter(r => /^\\d{4}$/.test(String(r.sku))).map(r => String(r.sku)))).sort();
  // 当前 buildPlanOptimAdvice 产出（fresh）
  let all = [];
  try { all = (typeof buildPlanOptimAdvice === 'function') ? (buildPlanOptimAdvice() || []) : []; } catch (e) { out.buildErr = String(e).slice(0, 160); }
  out.buildTotal = all.length;
  out.buildLeadZero = all.filter(r => String(r.sku).charAt(0) === '0').length;
  out.buildHasPlan2 = (function(){ try { const pb2 = (dataStore.inventory || {}).planBySkuRdc; return !!(pb2 && Object.keys(pb2).length); } catch(e){ return null; } })();
  out.buildFourDigitSample = Array.from(new Set(all.filter(r => /^\\d{4}$/.test(String(r.sku))).map(r => String(r.sku)))).sort().slice(0, 20);
  out.buildMJ = all.filter(r => r.brand === '美加净').slice(0, 6).map(r => r.sku);
  return out;
})()`;

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
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('进入补货建议页...');
  await p.evaluate(() => navigateTo('replenishment')).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
  console.log('\n--- 阶段1：首次渲染后立即快照 ---');
  console.log(JSON.stringify(await p.evaluate(snap).catch(e => ({ err: String(e).slice(0, 200) })), null, 2));

  console.log('\n--- 阶段2：等 _invPlanReady 后强制重渲染 ---');
  for (let i = 0; i < 60; i++) {
    const ready = await p.evaluate(() => !!window._invPlanReady && Object.keys((dataStore.inventory || {}).planBySkuRdc || {}).length > 0).catch(() => false);
    if (ready) { console.log('  plan 就绪 (等待 ' + (i * 2) + 's)'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  await p.evaluate(() => { try { renderReplenishment(); } catch (e) {} }).catch(() => {});
  await new Promise(r => setTimeout(r, 2500));
  console.log(JSON.stringify(await p.evaluate(snap).catch(e => ({ err: String(e).slice(0, 200) })), null, 2));

  console.log('\n页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('  └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
