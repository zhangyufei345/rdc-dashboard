// v340 线上实测：直接打开 https://rdc-dashboard.pages.dev 的真实部署，走完整数据加载 +
//   点导出 → 抓 workbook → 逐列打印 t / z，回答「线上跑的就是 v340 吗？H 列到底是不是数值？」
//   用法：node tools/verify-live-export.js
const fs = require('fs'), path = require('path'), https = require('https');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const LIVE = 'https://rdc-dashboard.pages.dev';
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 9 分钟'); process.exit(3); }, 540000);

function fetchText(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache', 'User-Agent': 'Mozilla/5.0' } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: d }));
    }).on('error', rej);
  });
}

(async () => {
  // ① 先裸抓一次线上 HTML，确认服务端给的就是 v340
  const f = await fetchText(LIVE + '/?cb=' + Date.now());
  const body = f.body || '';
  const bv = (body.match(/const BUILD_VERSION = (\d+)/) || [])[1] || '?';
  console.log('① 线上 HTML: status=' + f.status + ' BUILD_VERSION=' + bv +
    ' _forceNumericColumns=' + body.includes('_forceNumericColumns') +
    ' fulfillRate*1000=' + body.includes('d.fulfillRate * 1000') +
    ' 旧toFixed%=' + /fulfillRate\s*\|\|\s*0\)\s*\*\s*100\)\.toFixed/.test(body));
  console.log('   cache-control=' + f.headers['cache-control'] + '  date=' + f.headers['date']);

  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext({ bypassCSP: true });
  await ctx.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message.slice(0, 200)));

  console.log('\n② 用浏览器打开线上站点（真实网络，直连 CDN）...');
  await p.goto(LIVE + '/?cb=' + Date.now(), { waitUntil: 'domcontentloaded' });
  const shown = await p.evaluate(() => (document.title || '')).catch(() => '');
  const inPage = await p.evaluate(() => (typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : 'n/a')).catch(() => 'n/a');
  console.log('   页面实际执行 BUILD_VERSION=' + inPage + '  title="' + shown + '"');

  for (let i = 0; i < 150; i++) {
    const ok = await p.evaluate(() => !!(typeof dataStore !== 'undefined' && dataStore.loaded && (dataStore.orderDetail || []).length > 100000)).catch(() => false);
    if (ok) { console.log('   基础数据就绪 (' + (i * 3) + 's)'); break; }
    await new Promise(r => setTimeout(r, 3000));
  }
  await p.evaluate(() => navigateTo('replenishment')).catch(() => {});
  for (let i = 0; i < 90; i++) {
    const st = await p.evaluate(() => {
      const pb = (dataStore.inventory || {}).planBySkuRdc;
      return { keys: pb ? Object.keys(pb).length : 0, dw: (window._dwList || []).length, up: (window._replDisplayList || []).length };
    }).catch(() => ({ keys: 0, dw: 0, up: 0 }));
    if (st.keys > 100 && st.dw > 0 && st.up > 0) { console.log('   补货页就绪 plan keys=' + st.keys + ' _dwList=' + st.dw + ' _replDisplayList=' + st.up + ' (' + (i * 3) + 's)'); break; }
    await new Promise(r => setTimeout(r, 3000));
  }
  await p.evaluate(() => { window._replRdc = 'all'; renderReplenishment(); }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

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

  if (R.err) console.log('❌ 抓取失败: ' + R.err);
  const outDir = path.join(__dirname, '_out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  if (R.b64) {
    const fp = path.join(outDir, 'live-export.xlsx');
    fs.writeFileSync(fp, Buffer.from(R.b64, 'base64'));
    console.log('\n③ 线上导出文件已落盘: ' + fp + '  (' + fs.statSync(fp).size + ' bytes)');
  }
  console.log('   文件名: ' + R.fname + '   Sheet: ' + JSON.stringify(R.sheets));
  (R.stat ? Object.keys(R.stat) : []).forEach(sn => {
    console.log('\n===== Sheet「' + sn + '」列类型（线上实测）=====');
    R.stat[sn].forEach(c => {
      console.log('  ' + c.header.padEnd(16, ' ') + ' 数字=' + String(c.n).padStart(4) + ' 文本=' + String(c.s).padStart(4) + ' 空=' + String(c.blank).padStart(4) + ' 格式=' + JSON.stringify(c.zs) + ' 例=' + JSON.stringify(c.samples));
    });
  });
  console.log('\n页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('  └ ' + e));
  clearTimeout(HARD);
  await b.close();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
