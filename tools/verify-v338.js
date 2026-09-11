// v338 验证（A/B 对照）：分仓计划就绪后，「每日补货建议」卡片是否**自动**重算。
//   做法：用 playwright 把 inventory-plan.json 的响应人为延迟 12s，拉长「未就绪窗口」，
//         全程不手动调用 renderReplenishment（除了刻意选 RDC 的那一次），观察：
//           plan 就绪瞬间 renderCalls 是否 +1、下调条数是否从 cov7 回退(266) 变稳态(262)、RDC 筛选是否保留。
//   对照：对旧版（v337，无 replenishment 分支）跑同一探针，应看到 renderCalls 不变、条数停在 266。
// 用法：node tools/verify-v338.js [页面文件名]
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8992;
const PAGE = process.argv[2] || 'rdc-dashboard.html';
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 9 分钟'); process.exit(3); }, 540000);

const snap = `(() => {
  const out = {};
  out.planReady = !!window._invPlanReady;
  out.pbKeys = Object.keys((dataStore.inventory || {}).planBySkuRdc || {}).length;
  out.dwLen = (window._dwList || []).length;
  out.replRdc = window._replRdc || '(unset)';
  out.renderCalls = window.__replCalls || 0;
  const cards = Array.from(document.querySelectorAll('#page-replenishment .card'));
  const dw = cards.find(c => { const t = c.querySelector('.card-title'); return t && t.textContent.indexOf('\\u4e0b\\u8c03\\u9884\\u8b66') >= 0; });
  out.domRows = dw ? dw.querySelectorAll('tbody tr').length : -1;
  const hdr = dw ? dw.querySelector('.card-header span:last-child') : null;
  out.cardNote = hdr ? hdr.textContent.trim().replace(/\\s+/g, ' ').slice(0, 46) : '';
  const sel = document.querySelector('#page-replenishment select');
  out.selectVal = sel ? sel.value : '(no select)';
  return out;
})()`;

const grab = `(() => {
  const out = {};
  const orig = XLSX.writeFile;
  let cap = null;
  XLSX.writeFile = function (wb, name) { cap = { wb: wb, name: name }; };
  try { exportReplenishmentExcel(); } catch (e) { out.err = String(e).slice(0, 200); }
  finally { XLSX.writeFile = orig; }
  if (!cap) { out.err = out.err || '\\u672a\\u6355\\u83b7 writeFile'; return out; }
  cap.wb.SheetNames.forEach(function (sn) {
    const ws = cap.wb.Sheets[sn];
    const R = XLSX.utils.decode_range(ws['!ref']);
    let col = -1;
    for (let c = R.s.c; c <= R.e.c; c++) {
      const h = ws[XLSX.utils.encode_cell({ r: R.s.r, c: c })];
      if (h && String(h.v) === 'SKU\\u7f16\\u7801') { col = c; break; }
    }
    const vals = [], types = {};
    for (let r = R.s.r + 1; r <= R.e.r; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r: r, c: col })];
      if (!cell) continue;
      vals.push(String(cell.v));
      types[cell.t] = (types[cell.t] || 0) + 1;
    }
    out[sn] = { rows: vals.length, cellTypes: types, fourDigit: vals.filter(v => /^\\d{4}$/.test(v)).slice(0, 8), leadZero: vals.filter(v => /^0\\d+$/.test(v)).length };
  });
  return out;
})()`;

(async () => {
  console.log('### 探针目标页: ' + PAGE);
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext()).newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const cdn = path.join(__dirname, '.cdn-cache');
  await p.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'echarts.min.js')) }).catch(() => {}));
  await p.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'xlsx.full.min.js')) }).catch(() => {}));
  // 关键：人为延迟 inventory-plan.json 12s，制造稳定的「未就绪窗口」
  await p.route('**/inventory-plan.json', async r => {
    await new Promise(x => setTimeout(x, 12000));
    r.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: fs.readFileSync(path.join(ROOT, 'inventory-plan.json')) }).catch(() => {});
  });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0, 160)));

  await p.goto(`http://127.0.0.1:${PORT}/${PAGE}`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 120; i++) {
    const ok = await p.evaluate(() => !!(typeof dataStore !== 'undefined' && dataStore.loaded && (dataStore.orderDetail || []).length > 100000)).catch(() => false);
    if (ok) { console.log('数据就绪 (' + i * 2 + 's)'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }

  await p.evaluate(() => {
    window.__replCalls = 0;
    const _o = window.renderReplenishment;
    window.renderReplenishment = function () { window.__replCalls++; return _o.apply(this, arguments); };
  }).catch(e => console.log('装计数器失败: ' + e.message));

  await p.evaluate(() => navigateTo('replenishment')).catch(() => {});
  await new Promise(r => setTimeout(r, 3500));
  console.log('\n--- 阶段A：首屏（plan 已被延迟，未就绪）---');
  const A = await p.evaluate(snap).catch(e => ({ err: String(e).slice(0, 200) }));
  console.log(JSON.stringify(A, null, 2));

  await p.evaluate(() => { window._replRdc = '华中RDC'; renderReplenishment(); }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));
  const A1 = await p.evaluate(snap).catch(e => ({ err: String(e).slice(0, 200) }));
  console.log('\n--- 阶段A1：手动选 RDC=华中RDC 后（plan 仍未就绪）---');
  console.log(JSON.stringify(A1, null, 2));

  console.log('\n--- 阶段B：等 plan 就绪（不手动触发任何渲染）---');
  let waited = 0;
  for (let i = 0; i < 90; i++) {
    const ready = await p.evaluate(() => !!window._invPlanReady && Object.keys((dataStore.inventory || {}).planBySkuRdc || {}).length > 0).catch(() => false);
    waited = Math.round(i * 0.5);
    if (ready) { console.log('  plan 就绪（等待 ' + waited + 's）'); break; }
    await new Promise(r => setTimeout(r, 500));
  }
  await new Promise(r => setTimeout(r, 4000));
  const B = await p.evaluate(snap).catch(e => ({ err: String(e).slice(0, 200) }));
  console.log(JSON.stringify(B, null, 2));

  const autoFired = B.renderCalls > A1.renderCalls;
  console.log('\n===== 判定 =====');
  console.log('  renderCalls  A=' + A.renderCalls + '  A1=' + A1.renderCalls + '  B=' + B.renderCalls +
    '  → plan 就绪后自动重算：' + (autoFired ? '✅ 发生 (+' + (B.renderCalls - A1.renderCalls) + ')' : '❌ 未发生'));
  console.log('  下调条数     A=' + A.dwLen + '(DOM ' + A.domRows + ')  → B=' + B.dwLen + '(DOM ' + B.domRows + ')');
  console.log('  RDC 筛选     A1=' + A1.selectVal + ' → B=' + B.selectVal + '  → ' + (A1.selectVal === B.selectVal ? '✅ 保留' : '❌ 丢失'));
  console.log('  卡片文案     B="' + B.cardNote + '"');

  console.log('\n--- 阶段C：恢复全部 RDC 后导出 ---');
  await p.evaluate(() => { window._replRdc = 'all'; renderReplenishment(); }).catch(() => {});
  await new Promise(r => setTimeout(r, 2500));
  console.log(JSON.stringify(await p.evaluate(grab).catch(e => ({ err: String(e).slice(0, 200) })), null, 2));
  const C = await p.evaluate(snap).catch(() => ({}));
  console.log('导出时 _dwList=' + C.dwLen + '  DOM 行数=' + C.domRows);

  console.log('\n页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('  └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
