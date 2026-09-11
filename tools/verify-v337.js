// v337 验证：导出 Excel 的 SKU 列是否已是文本 + 0 开头是否还原。
//   测两种状态：① plan 未就绪（走 cov7 回退，原 4 位码）② plan 就绪（稳态）
// 用法：node tools/verify-v337.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8987;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 8 分钟'); process.exit(3); }, 480000);

// 抓导出 workbook 并体检 SKU 列
const grab = `(() => {
  const out = { canonSize: Object.keys(window._skuCanonMap || {}).length };
  if (typeof XLSX === 'undefined') { out.err = 'XLSX 未加载'; return out; }
  const orig = XLSX.writeFile;
  let cap = null;
  XLSX.writeFile = function (wb, name) { cap = { wb: wb, name: name }; };
  try { if (typeof exportReplenishmentExcel === 'function') exportReplenishmentExcel(); }
  catch (e) { out.err = String(e).slice(0, 200); }
  finally { XLSX.writeFile = orig; }
  if (!cap) { out.err = out.err || '未捕获 writeFile'; return out; }
  out.file = cap.name;
  const rep = {};
  cap.wb.SheetNames.forEach(function (sn) {
    const ws = cap.wb.Sheets[sn];
    const R = XLSX.utils.decode_range(ws['!ref']);
    let col = -1;
    for (let c = R.s.c; c <= R.e.c; c++) {
      const h = ws[XLSX.utils.encode_cell({ r: R.s.r, c: c })];
      if (h && String(h.v) === 'SKU编码') { col = c; break; }
    }
    const vals = [], types = {}, zs = {};
    for (let r = R.s.r + 1; r <= R.e.r; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r: r, c: col })];
      if (!cell) continue;
      vals.push(String(cell.v));
      types[cell.t] = (types[cell.t] || 0) + 1;
      zs[String(cell.z)] = (zs[String(cell.z)] || 0) + 1;
    }
    rep[sn] = {
      colIdx: col, rows: vals.length, cellTypes: types, numFmt: zs,
      lenDist: vals.reduce(function (m, v) { const L = v.length; m[L] = (m[L] || 0) + 1; return m; }, {}),
      fourDigit: vals.filter(v => /^\\d{4}$/.test(v)).slice(0, 12),
      leadZero: vals.filter(v => /^0\\d+$/.test(v)).length,
      leadZeroSample: vals.filter(v => /^0\\d+$/.test(v)).slice(0, 6),
      first6: vals.slice(0, 6)
    };
  });
  out.report = rep;
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

  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 120; i++) {
    const ok = await p.evaluate(() => !!(typeof dataStore !== 'undefined' && dataStore.loaded && (dataStore.orderDetail || []).length > 100000)).catch(() => false);
    if (ok) { console.log('数据就绪 (' + i * 2 + 's)'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }

  await p.evaluate(() => navigateTo('replenishment')).catch(() => {});
  await new Promise(r => setTimeout(r, 4000));
  const s1 = await p.evaluate(() => ({
    planReady: !!window._invPlanReady,
    pbKeys: Object.keys((dataStore.inventory || {}).planBySkuRdc || {}).length,
    dwLen: (window._dwList || []).length
  }));
  console.log('\n===== 状态1（首屏后，plan 未就绪）=====', JSON.stringify(s1));
  console.log(JSON.stringify(await p.evaluate(grab).catch(e => ({ err: String(e).slice(0, 200) })), null, 2));

  for (let i = 0; i < 60; i++) {
    const ready = await p.evaluate(() => !!window._invPlanReady && Object.keys((dataStore.inventory || {}).planBySkuRdc || {}).length > 0).catch(() => false);
    if (ready) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  await p.evaluate(() => { try { renderReplenishment(); } catch (e) {} }).catch(() => {});
  await new Promise(r => setTimeout(r, 2500));
  const s2 = await p.evaluate(() => ({
    planReady: !!window._invPlanReady,
    pbKeys: Object.keys((dataStore.inventory || {}).planBySkuRdc || {}).length,
    dwLen: (window._dwList || []).length,
    dwLeadZero: (window._dwList || []).filter(r => String(r.sku).charAt(0) === '0').length
  }));
  console.log('\n===== 状态2（plan 就绪·稳态）=====', JSON.stringify(s2));
  console.log(JSON.stringify(await p.evaluate(grab).catch(e => ({ err: String(e).slice(0, 200) })), null, 2));

  console.log('\n页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('  └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
