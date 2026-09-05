// 核对冷加载后各月订单是否齐全（慢网 E2E 里出现过 orders=166447，需确认是否有月份丢失）
// 同时验证转储数据能否加载出来
// 用法：node tools/probe-counts.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8933;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 6 分钟'); process.exit(3); }, 360000);

// 期望值（源数据里 订单明细 sheet 的行数，未经「订单放行」筛选）
const EXPECT_RAW = { '2026-01': 29734, '2026-02': 18174, '2026-03': 41604, '2026-04': 30320, '2026-05': 41629, '2026-06': 41629, '2026-07': 41629, '2026-08': 24115, '2026-09': 23385 };

const snap = () => ({
  loaded: !!(typeof dataStore !== 'undefined' && dataStore.loaded),
  cov7: (window.dataStore && dataStore.inventory && dataStore.inventory.cov7) ? dataStore.inventory.cov7.length : 0,
  orders: (dataStore.orderDetail || []).length,
  transship: (dataStore.transship || []).length,
  hist: (function () {
    const h = {};
    (dataStore.orderDetail || []).forEach(r => { const m = String(r.dateStr || '').slice(0, 7) || '?'; h[m] = (h[m] || 0) + 1; });
    return h;
  })(),
});

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

  console.log('冷加载（本地，不限速）...');
  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });

  let prev = -1, stable = 0, s = null;
  for (let i = 0; i < 120; i++) {
    s = await p.evaluate(snap).catch(() => null);
    if (s && s.loaded) {
      if (s.orders === prev) { stable++; if (stable >= 3) break; } else { stable = 0; }
      prev = s.orders;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('\n稳定后状态: loaded=' + s.loaded + '  cov7=' + s.cov7 + '  orders=' + s.orders + '  transship=' + s.transship);
  console.log('（等待 3 次读数一致才认定稳定，避免把「还在加载」误判为「加载完了」）\n');

  console.log('月份      实际行数   源数据行数   差异');
  let totalActual = 0, totalRaw = 0;
  Object.keys(EXPECT_RAW).sort().forEach(m => {
    const a = s.hist[m] || 0, e = EXPECT_RAW[m];
    totalActual += a; totalRaw += e;
    const ok = a > 0 ? '✅' : '❌';
    console.log('  ' + ok + ' ' + m + '   ' + String(a).padEnd(9) + ' ' + String(e).padEnd(11) + ' ' + (a - e));
  });
  Object.keys(s.hist).filter(m => !EXPECT_RAW[m]).forEach(m => console.log('  ❓ ' + m + '   ' + s.hist[m] + '（源数据里没有的月份）'));
  console.log('  合计      ' + String(totalActual).padEnd(9) + ' ' + String(totalRaw).padEnd(11) + ' ' + (totalActual - totalRaw));
  console.log('\n  说明：实际行数 < 源数据行数是正常的 —— 前端默认按「订单放行：仅已放行」筛选，');
  console.log('        关键是「每个月都必须有数据」，某月为 0 才是真丢失。\n');

  const missing = Object.keys(EXPECT_RAW).filter(m => !s.hist[m]);
  console.log(missing.length ? ('❌ 缺失月份: ' + missing.join(', ')) : '✅ 9 个月份全部有数据');

  // 转储数据
  console.log('\n进入转储页（触发 ensureTransship）...');
  await p.evaluate(() => navigateTo('transship'));
  for (let i = 0; i < 45; i++) {
    const n = await p.evaluate(() => (dataStore.transship || []).length).catch(() => 0);
    if (n > 1000) { console.log('  ✅ 转储数据就绪: ' + n + ' 行 (等待' + (i * 2) + 's)'); break; }
    if (i === 44) console.log('  ❌ 90s 内转储数据未就绪，当前=' + n);
    await new Promise(r => setTimeout(r, 2000));
  }
  const txt = await p.evaluate(() => { const el = document.getElementById('page-transship'); return el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '(无)'; });
  console.log('  转储页文本: ' + txt);
  console.log('\n页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('  └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(missing.length === 0 && errs.length === 0 ? 0 : 1);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
