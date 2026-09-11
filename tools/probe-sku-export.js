// v337 排查：导出 Excel 的 SKU 编码前导零在哪里丢的？
//   目标：① 确认运行时各结构里 0 开头 SKU（美加净 '09539'）是原始还是去零；② 端到端抓取导出 workbook，看单元格类型与值。
// 用法：node tools/probe-sku-export.js
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
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('进入补货建议页（触发 renderReplenishment + ensureInventoryPlan）...');
  await p.evaluate(() => navigateTo('replenishment')).catch(() => {});
  for (let i = 0; i < 90; i++) {
    const n = await p.evaluate(() => (window._dwList || []).length).catch(() => 0);
    const planReady = await p.evaluate(() => !!window._invPlanReady).catch(() => false);
    if (n > 0 && planReady) { console.log('  _dwList 就绪: ' + n + ' 条 (等待 ' + (i * 2) + 's)'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }

  // ---- A. 运行时各结构的 SKU 形态 ----
  const A = await p.evaluate(() => {
    const out = {};
    const pb = (dataStore.inventory || {}).planBySkuRdc || {};
    const pbKeys = Object.keys(pb);
    out.pb_totalKeys = pbKeys.length;
    out.pb_leadZeroKeys = pbKeys.filter(k => k.charAt(0) === '0').slice(0, 8);
    out.pb_leadZeroCount = pbKeys.filter(k => k.charAt(0) === '0').length;
    out.pb_has9539 = pbKeys.indexOf('9539') >= 0;
    out.pb_has09539 = pbKeys.indexOf('09539') >= 0;

    // 下调列表里的美加净
    out.dw_mjRows = (window._dwList || []).filter(r => r.brand === '美加净').slice(0, 8)
      .map(r => ({ sku: r.sku, t: typeof r.sku, len: String(r.sku).length, name: (r.skuName || '').slice(0, 18) }));
    out.dw_allMJSkus = Array.from(new Set((window._dwList || []).filter(r => r.brand === '美加净').map(r => String(r.sku)))).sort();
    out.dw_leadZeroCount = (window._dwList || []).filter(r => String(r.sku).charAt(0) === '0').length;

    // 上调展示列表
    out.up_mjRows = (window._replDisplayList || []).filter(r => r.brand === '美加净').slice(0, 8)
      .map(r => ({ code: r.materialCode, t: typeof r.materialCode, len: String(r.materialCode).length }));

    // 订单明细
    const od = dataStore.orderDetail || [];
    out.od_mjSkus = Array.from(new Set(od.filter(d => d.brand === '美加净').map(d => String(d.skuCode)))).sort().slice(0, 12);
    out.od_leadZeroCount = od.filter(d => String(d.skuCode || '').charAt(0) === '0').length;

    // 分仓计划原始行
    const raw = (dataStore.inventory && dataStore.inventory._rawSheets && dataStore.inventory._rawSheets['分仓计划']) || null;
    out.rawPlan_exists = !!raw;
    if (raw && raw.length > 1) {
      const hdr = raw[0] || [];
      out.rawPlan_hdr = hdr.slice(0, 9);
      const skus = [];
      for (let i = 1; i < raw.length && skus.length < 8; i++) {
        const v = raw[i] && raw[i][0];
        if (v != null && String(v).charAt(0) === '0') skus.push({ v: String(v), t: typeof v });
      }
      out.rawPlan_leadZeroSample = skus;
    }

    // 基础数据原始行（权威主数据）
    const bs = (dataStore.inventory && dataStore.inventory._rawSheets && dataStore.inventory._rawSheets['基础数据']) || null;
    out.rawBase_exists = !!bs;
    if (bs && bs.length > 1) {
      const skus = [];
      for (let i = 1; i < bs.length && skus.length < 6; i++) {
        const v = bs[i] && bs[i][0];
        if (v != null && String(v).charAt(0) === '0') skus.push({ v: String(v), t: typeof v });
      }
      out.rawBase_leadZeroSample = skus;
      out.rawBase_allLeadZeroCount = bs.filter(r => r && r[0] != null && String(r[0]).charAt(0) === '0').length;
    }
    return out;
  }).catch(e => ({ err: String(e).slice(0, 300) }));

  console.log('\n===== A. 运行时 SKU 形态 =====');
  console.log(JSON.stringify(A, null, 2));

  // ---- B. 端到端抓取导出 workbook（劫持 XLSX.writeFile） ----
  const B = await p.evaluate(() => {
    const out = {};
    if (typeof XLSX === 'undefined') { out.err = 'XLSX 未加载'; return out; }
    const origWriteFile = XLSX.writeFile;
    let captured = null;
    XLSX.writeFile = function (wb, name) { captured = { wb: wb, name: name }; };
    try {
      if (typeof exportReplenishmentExcel === 'function') exportReplenishmentExcel();
    } catch (e) {
      out.err = String(e).slice(0, 200);
    } finally {
      XLSX.writeFile = origWriteFile;
    }
    if (!captured) { out.err = out.err || '未捕获到 writeFile 调用'; return out; }
    out.fname = captured.name;
    out.sheets = captured.wb.SheetNames;
    const report = {};
    captured.wb.SheetNames.forEach(function (sn) {
      const ws = captured.wb.Sheets[sn];
      const ref = ws['!ref'] || '';
      // 找 SKU 列
      const range = XLSX.utils.decode_range(ref);
      let skuCol = -1, hdrRow = 0;
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: 0, c: c })];
        if (cell && cell.v === 'SKU编码') { skuCol = c; break; }
      }
      const items = [];
      if (skuCol >= 0) {
        for (let r = 1; r <= Math.min(range.e.r, 400); r++) {
          const cell = ws[XLSX.utils.encode_cell({ r: r, c: skuCol })];
          if (!cell) continue;
          items.push({ v: cell.v, t: cell.t, z: cell.z || null, w: cell.w || null });
        }
      }
      report[sn] = {
        ref: ref,
        skuCol: skuCol,
        totalCells: items.length,
        types: items.reduce(function (m, x) { m[x.t] = (m[x.t] || 0) + 1; return m; }, {}),
        numLikeStrings: items.filter(x => x.t === 's' && /^\d+$/.test(String(x.v))).length,
        fourDigit: items.filter(x => /^\d{4}$/.test(String(x.v))).slice(0, 10),
        leadZero: items.filter(x => /^0\d+$/.test(String(x.v))).slice(0, 10),
        first5: items.slice(0, 5)
      };
    });
    out.report = report;
    return out;
  }).catch(e => ({ err: String(e).slice(0, 300) }));

  console.log('\n===== B. 导出 workbook 实抓 =====');
  console.log(JSON.stringify(B, null, 2));

  console.log('\n页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('  └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
