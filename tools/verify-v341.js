// v341 端到端 A/B 验证（真浏览器 + 真实数据）
//
// 目的（证明三件事，缺一不可）：
//   T1 零回归：无上升信号的 SKU，v341 与 v340 判定完全一致（方向/upScore 都不能变）
//   T2 生效性：有上升信号（ratio>2 且 cur>=100）的 SKU，upScore 上升 0.05/0.10
//   T3 隔离性：下调侧 downScore 完全不变（riseSig 只进 deviation，不进 downScore）
//
// 用法：node tools/verify-v341.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8796;
const MIME = { '.html':'text/html; charset=utf-8', '.json':'application/json; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n硬超时 20 分钟'); process.exit(3); }, 1200000);

async function grab(b, file) {
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 300)));
  p.on('console', m => { if (m.type() === 'error') errs.push('[c] ' + m.text().slice(0, 200)); });
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const cdn = path.join(__dirname, '.cdn-cache');
  for (const lib of ['echarts.min.js', 'xlsx.full.min.js']) {
    const f2 = path.join(cdn, lib);
    if (fs.existsSync(f2)) {
      await p.route('**/' + lib, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(f2) }).catch(() => {}));
    }
  }

  await p.goto(`http://127.0.0.1:${PORT}/${file}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    ready = await p.evaluate(() => !!(typeof dataStore !== 'undefined' && dataStore.loaded && (dataStore.orderDetail || []).length > 100000)).catch(() => false);
    if (ready) { console.log(`  基础数据就绪 (${i * 2}s)`); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!ready) { console.log('  !! 基础数据未就绪'); }

  // 进分仓计划监控页，触发 buildPlanOptimAdvice 渲染
  await p.evaluate(() => navigateTo('plan-monitor')).catch(() => {});
  let ok = false;
  for (let i = 0; i < 90; i++) {
    const st = await p.evaluate(() => {
      const pb = (dataStore.inventory || {}).planBySkuRdc;
      return { keys: pb ? Object.keys(pb).length : 0, inv: !!(window._invPlanReady) };
    }).catch(() => ({ keys: 0, inv: false }));
    if (st.keys > 100) { console.log(`  planBySkuRdc 就绪 keys=${st.keys} _invPlanReady=${st.inv} (${i * 2}s)`); ok = true; break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!ok) console.log('  !! planBySkuRdc 未就绪');
  await new Promise(r => setTimeout(r, 8000));   // 等渲染完成

  const out = await p.evaluate(async () => {
    if (!window._invPlanReady && typeof ensureInventoryPlan === 'function') {
      try { await ensureInventoryPlan(); } catch (e) {}
    }
    const ver = (typeof BUILD_VERSION !== 'undefined') ? BUILD_VERSION : null;
    let rows = [];
    try { rows = buildPlanOptimAdvice() || []; } catch (e) { return { ver, err: String(e), n: 0, rows: [] }; }
    return {
      ver, n: rows.length,
      rows: rows.map(r => ({
        k: r.sku + '|' + r.rdc,
        dir: r.direction,
        up: r.upScore == null ? null : Math.round(r.upScore * 10000) / 10000,
        dn: r.downScore == null ? null : Math.round(r.downScore * 10000) / 10000,
        dev: (r.dims && r.dims.deviation != null) ? Math.round(r.dims.deviation * 10000) / 10000 : null,
        rise: r.riseSig == null ? null : Math.round(r.riseSig * 10000) / 10000,
        decay: r.demandDecay == null ? null : r.demandDecay
      }))
    };
  });
  await ctx.close();
  return { file, ...out, errs: errs.slice(0, 8) };
}

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const b = await chromium.launch({ channel: 'chrome' });
  console.log('=== 抓取中（每页约 120-200s） ===');

  const A = await grab(b, '__ctrl.html');
  console.log(`CTRL  ver=${A.ver} rows=${A.n} errs=${A.errs.length}${A.err ? ' ERR=' + A.err : ''}`);
  const B = await grab(b, 'rdc-dashboard.html');
  console.log(`TEST  ver=${B.ver} rows=${B.n} errs=${B.errs.length}${B.err ? ' ERR=' + B.err : ''}`);
  if (A.errs.length) console.log('CTRL errs:', A.errs.slice(0, 4));
  if (B.errs.length) console.log('TEST errs:', B.errs.slice(0, 4));

  const mapA = new Map(A.rows.map(r => [r.k, r]));
  const dirChanged = [], upNoRise = [], upRise = [], dnChanged = [], devChanged = [];
  const fmt = x => x == null ? 'null' : x.toFixed(4);
  for (const [k, bb] of new Map(B.rows.map(r => [r.k, r]))) {
    const a = mapA.get(k);
    if (!a) continue;
    if (a.dir !== bb.dir) dirChanged.push({ k, from: a.dir, to: bb.dir, aUp: fmt(a.up), bUp: fmt(bb.up), rise: bb.rise });
    if (Math.abs((a.up ?? 0) - (bb.up ?? 0)) > 1e-6) {
      ((bb.rise || 0) > 0 ? upRise : upNoRise).push({ k, aUp: fmt(a.up), bUp: fmt(bb.up), rise: bb.rise });
    }
    if (Math.abs((a.dn ?? 0) - (bb.dn ?? 0)) > 1e-6) dnChanged.push({ k, a: fmt(a.dn), b: fmt(bb.dn) });
    if (Math.abs((a.dev ?? 0) - (bb.dev ?? 0)) > 1e-6) devChanged.push({ k, a: fmt(a.dev), b: fmt(bb.dev), rise: bb.rise });
  }
  const cnt = rows => { const c = {}; rows.forEach(r => c[r.dir] = (c[r.dir] || 0) + 1); return c; };
  console.log('\n=== 方向分布 ===');
  console.log('  v340:', JSON.stringify(cnt(A.rows)));
  console.log('  v341:', JSON.stringify(cnt(B.rows)));

  console.log('\n=== T1 零回归 ===');
  console.log('  方向变化条数:', dirChanged.length);
  dirChanged.slice(0, 20).forEach(r => console.log(`   ${r.k}  ${r.from} -> ${r.to}  up ${r.aUp}->${r.bUp} rise=${r.rise}`));
  console.log('  **无上升信号却 upScore 变化（必须=0）**:', upNoRise.length);
  upNoRise.slice(0, 10).forEach(r => console.log('   !!', r.k, r.aUp, '->', r.bUp));

  console.log('\n=== T2 生效性 ===');
  console.log('  有上升信号且 upScore 变化条数:', upRise.length);
  upRise.slice(0, 12).forEach(r => console.log(`   ${r.k}  ${r.aUp} -> ${r.bUp}  (+${(r.bUp - r.aUp).toFixed(4)}) riseSig=${r.rise}`));

  console.log('\n=== T3 隔离性 ===');
  console.log('  **downScore 变化条数（必须=0）**:', dnChanged.length);
  dnChanged.slice(0, 10).forEach(r => console.log('   !!', r.k, r.a, '->', r.b));

  console.log('\n=== 其他 ===');
  const r341 = B.rows.filter(r => (r.rise || 0) > 0).length;
  const r340 = A.rows.filter(r => (r.rise || 0) > 0).length;
  console.log('  deviation 变化条数:', devChanged.length, '｜其中带 riseSig:', devChanged.filter(x => (x.rise || 0) > 0).length);
  console.log(`  riseSig>0 条数: v340=${r340} (应=0) / v341=${r341}`);

  if (!fs.existsSync(path.join(ROOT, 'tools', '_out'))) fs.mkdirSync(path.join(ROOT, 'tools', '_out'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tools', '_out', 'v341-ab.json'), JSON.stringify({ A, B }, null, 1));
  await b.close(); server.close(); clearTimeout(HARD);
  console.log('\nDONE');
})().catch(e => { console.error('FATAL', e); process.exit(2); });
