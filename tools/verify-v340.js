// v340 回归验证：补货建议导出（上调建议/下调预警 双 Sheet）数字列 = 真数值 + 常规格式
//   判据：①每个「数字列」非空格子 t 全为 'n'，且 z 为空（常规）；②SKU 编码列仍为文本(t='s', z='@')；
//        ③满足率/完成率是百分数数值（95 = 95%）；④原 '—' 占位变为空白。
// 用法：node tools/verify-v340.js
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

( async () => {
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
  for (let i = 0; i < 90; i++) {
    const st = await p.evaluate(() => {
      const pb = (dataStore.inventory || {}).planBySkuRdc;
      return { keys: pb ? Object.keys(pb).length : 0, dw: (window._dwList || []).length, up: (window._replDisplayList || []).length };
    }).catch(() => ({ keys: 0, dw: 0, up: 0 }));
    if (st.keys > 100 && st.dw > 0 && st.up > 0) { console.log('  就绪 plan keys=' + st.keys + ' _dwList=' + st.dw + ' _replDisplayList=' + st.up + ' (' + (i * 2) + 's)'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  await p.evaluate(() => { window._replRdc = 'all'; renderReplenishment(); }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  // 端到端抓取导出 workbook：劫持 writeFile，转 base64 交回 node 落盘
  const R = await p.evaluate(() => {
    const out = {};
    if (typeof XLSX === 'undefined') { out.err = 'XLSX 未加载'; return out; }
    const orig = XLSX.writeFile;
    let cap = null;
    XLSX.writeFile = function (wb, name) { cap = { wb: wb, name: name }; };
    try { exportReplenishmentExcel(); } catch (e) { out.err = String(e).slice(0, 300); }
    finally { XLSX.writeFile = orig; }
    if (!cap) { out.err = out.err || '未捕获 writeFile'; return out; }
    out.fname = cap.name;
    out.sheets = cap.wb.SheetNames;
    const stat = {};
    cap.wb.SheetNames.forEach(sn => {
      const ws = cap.wb.Sheets[sn];
      const R2 = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      const per = [];
      for (let c = R2.s.c; c <= R2.e.c; c++) {
        const hc = ws[XLSX.utils.encode_cell({ r: R2.s.r, c: c })];
        if (!hc) continue;
        const col = { header: String(hc.v), n: 0, s: 0, blank: 0, zs: {}, samples: [] };
        for (let r = R2.s.r + 1; r <= R2.e.r; r++) {
          const cell = ws[XLSX.utils.encode_cell({ r: r, c: c })];
          if (!cell || cell.v === '') { col.blank++; continue; }
          if (cell.t === 'n') col.n++; else col.s++;
          const zk = cell.z == null ? '(常规)' : String(cell.z);
          col.zs[zk] = (col.zs[zk] || 0) + 1;
          if (col.samples.length < 3) col.samples.push((cell.t === 'n' ? 'NUM:' : 'STR:') + String(cell.v));
        }
        per.push(col);
      }
      stat[sn] = per;
    });
    out.stat = stat;
    out.b64 = XLSX.write(cap.wb, { bookType: 'xlsx', type: 'base64' });
    return out;
  }).catch(e => ({ err: String(e).slice(0, 300) }));

  if (R.err) { console.log('❌ 抓取失败: ' + R.err); }
  const outDir = path.join(__dirname, '_out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  if (R.b64) {
    const fp = path.join(outDir, 'v340-export.xlsx');
    fs.writeFileSync(fp, Buffer.from(R.b64, 'base64'));
    console.log('\n导出文件已落盘: ' + fp + '  (' + fs.statSync(fp).size + ' bytes)');
  }
  console.log('文件名: ' + R.fname);
  console.log('Sheet: ' + JSON.stringify(R.sheets));
  (R.stat ? Object.keys(R.stat) : []).forEach(sn => {
    console.log('\n===== Sheet「' + sn + '」列类型 =====');
    R.stat[sn].forEach(c => {
      console.log('  ' + c.header.padEnd(18, ' ') + ' 数字=' + String(c.n).padStart(4) + ' 文本=' + String(c.s).padStart(4) + ' 空=' + String(c.blank).padStart(4) + ' 格式=' + JSON.stringify(c.zs) + ' 例=' + JSON.stringify(c.samples));
    });
  });
  console.log('\n页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('  └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
