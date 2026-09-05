// 验证转储页数据一致性：直接进转储页（不经过任何其他页面）应拿到完整 1-8 月数据。
// 修复前：直接进 = 16523 条（只有 1-6 月）；先进分仓计划监控再回来 = 23790 条（1-8 月）。
// 根因：renderTransship 只触发 ensureTransship，没触发 ensureInventoryExtra。
// 用法：node tools/probe-transship-consistency.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8937;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 5 分钟'); process.exit(3); }, 300000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 90; i++) {
    const ok = await p.evaluate(() => !!(dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(() => false);
    if (ok) break;
    await sleep(2000);
  }
  console.log('boot 就绪\n');

  // ── 路径 A：直接进转储页，不经过任何别的页面 ──
  console.log('[路径A] 直接 navigateTo("transship")（不先访问 plan-monitor / inventory-structure）');
  await p.evaluate(() => navigateTo('transship'));
  let prev = -1, stable = 0, rows = 0;
  for (let i = 0; i < 45; i++) {                       // 等 extra 异步回来，读数连续 3 次一致才算稳
    rows = await p.evaluate(() => (dataStore.transship || []).length).catch(() => 0);
    if (rows === prev) { stable++; if (stable >= 3) break; } else stable = 0;
    prev = rows;
    await sleep(2000);
  }
  const a = await p.evaluate(() => {
    const el = document.getElementById('page-transship');
    const t = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const m = t.match(/(\d+)条记录\s*·\s*(\d{4}-\d{2})\s*至\s*(\d{4}-\d{2})/);
    return { rows: (dataStore.transship || []).length, range: m ? (m[2] + ' 至 ' + m[3]) : '(未解析到)', extraReady: !!window._invExtraReady };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  console.log('  转储行数 = ' + a.rows + '   页面显示范围 = ' + a.range + '   _invExtraReady = ' + a.extraReady);

  // ── 路径 B：换个顺序（先进 plan-monitor，再回转储页），应与 A 完全一致 ──
  console.log('\n[路径B] 先 plan-monitor → 再回 transship（验证两条路径结果一致）');
  await p.evaluate(() => navigateTo('plan-monitor'));
  await sleep(6000);
  await p.evaluate(() => navigateTo('transship'));
  await sleep(6000);
  const bb = await p.evaluate(() => {
    const el = document.getElementById('page-transship');
    const t = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const m = t.match(/(\d+)条记录\s*·\s*(\d{4}-\d{2})\s*至\s*(\d{4}-\d{2})/);
    return { rows: (dataStore.transship || []).length, range: m ? (m[2] + ' 至 ' + m[3]) : '(未解析到)' };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  console.log('  转储行数 = ' + bb.rows + '   页面显示范围 = ' + bb.range);

  console.log('\n═══ 结论 ═══');
  const same = a.rows === bb.rows && a.range === bb.range;
  const full = a.rows > 23000 && /至\s*2026-08/.test(a.range);
  console.log('  ① 两条路径结果一致 : ' + (same ? '✅' : '❌ A=' + a.rows + '/' + a.range + '  B=' + bb.rows + '/' + bb.range));
  console.log('  ② 直接进即完整1-8月 : ' + (full ? '✅ ' + a.rows + ' 条' : '❌ 仅 ' + a.rows + ' 条（' + a.range + '）'));
  console.log('  页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('    └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(same && full && errs.length === 0 ? 0 : 1);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
