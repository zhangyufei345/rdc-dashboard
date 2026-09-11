// v338 附加探针：记录 renderReplenishment 每次被调用的**调用栈 + 时刻**，
//   用于区分「plan 就绪前的周期性/其它调用」与「ensureInventoryPlan 就绪回调触发的那次」。
// 用法：node tools/probe-v338-callers.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8995;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 5 分钟'); process.exit(3); }, 300000);

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext()).newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const cdn = path.join(__dirname, '.cdn-cache');
  await p.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'echarts.min.js')) }).catch(() => {}));
  await p.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'xlsx.full.min.js')) }).catch(() => {}));
  await p.route('**/inventory-plan.json', async r => {
    await new Promise(x => setTimeout(x, 12000));
    r.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: fs.readFileSync(path.join(ROOT, 'inventory-plan.json')) }).catch(() => {});
  });

  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 120; i++) {
    const ok = await p.evaluate(() => !!(typeof dataStore !== 'undefined' && dataStore.loaded && (dataStore.orderDetail || []).length > 100000)).catch(() => false);
    if (ok) break;
    await new Promise(r => setTimeout(r, 2000));
  }

  await p.evaluate(() => {
    window.__log = [];
    const _o = window.renderReplenishment;
    window.renderReplenishment = function () {
      let st = '';
      try { st = (new Error().stack || '').split('\n').slice(1, 4).map(x => x.trim().replace(/https?:\/\/[^ )]*\//g, '')).join(' << '); } catch (e) {}
      window.__log.push({ ms: Math.round(performance.now()), planReady: !!window._invPlanReady, dwLen: (window._dwList || []).length, st: st.slice(0, 220) });
      return _o.apply(this, arguments);
    };
  }).catch(() => {});

  await p.evaluate(() => navigateTo('replenishment')).catch(() => {});
  await new Promise(r => setTimeout(r, 22000));
  const log = await p.evaluate(() => window.__log || []);
  console.log('renderReplenishment 调用记录（共 ' + log.length + ' 次）：');
  log.forEach((r, i) => console.log('\n[' + (i + 1) + '] t=' + r.ms + 'ms  planReady=' + r.planReady + '  dwLen=' + r.dwLen + '\n    ' + r.st));
  const fin = await p.evaluate(() => ({ planReady: !!window._invPlanReady, dwLen: (window._dwList || []).length, select: (document.querySelector('#page-replenishment select') || {}).value }));
  console.log('\n最终: ' + JSON.stringify(fin));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
