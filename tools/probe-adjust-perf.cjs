// 补货调整跟踪页性能探针：定位「打开慢 / 筛选慢」的真实耗时构成
const fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.xlsx': 'application/octet-stream' };
function findC() { const b = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : 'C:/Users/zhangyufei1/AppData/Local/ms-playwright'; const c = []; for (const d of fs.readdirSync(b)) { c.push(path.join(b, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(b, d, 'chrome-win64', 'chrome.exe')); } return c.find(p => fs.existsSync(p)); }
function srv() { const s = http.createServer((q, r) => { const rel = decodeURIComponent(q.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html'; const f = path.join(ROOT, rel); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('nf'); return; } r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }); return new Promise(x => s.listen(0, '127.0.0.1', () => x(s))); }
(async () => {
  const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
  const s = await srv(); const port = s.address().port;
  const b = await chromium.launch({ headless: true, executablePath: findC(), args: ['--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e && e.message)));
  await p.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.fill('#login-user', 'admin').catch(() => {}); await p.fill('#login-pass', 'admin123').catch(() => {});
  await p.click('#login-page button').catch(() => {});
  await p.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).catch(() => {});
  await p.waitForTimeout(6000);
  await p.evaluate(() => { if (typeof ensureInventoryPlan === 'function') ensureInventoryPlan(); });
  await p.waitForFunction(() => window._invPlanReady === true, { timeout: 90000 }).catch(() => {});
  await p.waitForTimeout(1500);

  // 埋点：统计 renderAdjustTrack 调用次数与各段耗时
  await p.evaluate(() => {
    window.__perf = { renders: 0, t: [] };
    const wrap = (name) => {
      const f = window[name];
      window[name] = function () {
        const t0 = performance.now();
        const r = f.apply(this, arguments);
        const dt = performance.now() - t0;
        window.__perf.t.push([name, Math.round(dt * 10) / 10]);
        return r;
      };
    };
    wrap('buildAdjComputed'); wrap('_adjFiltered');
    const rf = window.renderAdjustTrack;
    window.renderAdjustTrack = function () {
      const t0 = performance.now();
      const r = rf.apply(this, arguments);
      const dt = performance.now() - t0;
      window.__perf.renders++;
      window.__perf['render' + window.__perf.renders] = Math.round(dt * 10) / 10;
      return r;
    };
  });
  await p.evaluate(() => { window.__perf.t = []; window.__perf.renders = 0; });

  // 1) 首次进入页面（缓存已可能在 onload 预热里建好 → 另测冷算）
  await p.evaluate(() => navigateTo('adjust-track'));
  await p.waitForTimeout(2500);
  const r1 = await p.evaluate(() => ({ p: JSON.parse(JSON.stringify(window.__perf)), rows: document.querySelectorAll('#adj-detail-card tbody tr').length, dom: document.getElementsByTagName('*').length }));

  // 2) 缓存态下切换筛选（选一个批次）
  await p.evaluate(() => { window.__perf = { renders: 0, t: [] }; window._adjState.batch = window._adjBatchList ? window._adjBatchList[0] : 'all'; });
  const batches = await p.evaluate(() => [...new Set((dataStore.adjustRecords || []).map(r => r.date))].sort().reverse());
  await p.evaluate((bs) => { window._adjState.batch = bs[0]; renderAdjustTrack(); }, batches);
  await p.waitForTimeout(1200);
  const r2 = await p.evaluate(() => ({ p: JSON.parse(JSON.stringify(window.__perf)), rows: document.querySelectorAll('#adj-detail-card tbody tr').length, dom: document.getElementsByTagName('*').length }));

  // 3) 复位全部 + 冷算一次（删缓存）
  await p.evaluate(() => { window._adjState.batch = 'all'; window._adjCache = null; window.__perf = { renders: 0, t: [] }; });
  const r3 = await p.evaluate(() => { const t0 = performance.now(); renderAdjustTrack(); const t = performance.now() - t0; return { total: Math.round(t * 10) / 10, p: JSON.parse(JSON.stringify(window.__perf)), rows: document.querySelectorAll('#adj-detail-card tbody tr').length }; });

  // 4) 单独量 buildAdjComputed 冷算耗时（拆到日需求折算）
  const r4 = await p.evaluate(() => {
    window._adjCache = null;
    const t0 = performance.now(); buildAdjComputed(); const t1 = performance.now();
    const list = window._adjCache.list;
    // 拆解：shortMap 冷建（遍历全部订单明细）+ 需求索引 各占多少
    const t2 = performance.now();
    let maxOrd = ''; const shortMap = {};
    (dataStore.orderDetail || []).forEach(function(d) {
      if (!d.dateStr) return;
      if (d.dateStr > maxOrd) maxOrd = d.dateStr;
      if (!isWorkday(d.dateStr)) return;
      const k = d.dateStr + '|' + d.skuCode + '|' + d.warehouse;
      if (d.firstDayShort) shortMap[k] = (shortMap[k] || 0) + d.firstDayShort;
    });
    const t3 = performance.now();
    _adjBuildDemandIndex((dataStore.inventory && dataStore.inventory.planBySkuRdc) || {});
    const t4 = performance.now();
    return { coldCompute: Math.round((t1 - t0) * 10) / 10, n: list.length, ordRows: (dataStore.orderDetail || []).length, shortMapMs: Math.round((t3 - t2) * 10) / 10, demandIdxMs: Math.round((t4 - t3) * 10) / 10, keys: Object.keys(shortMap).length };
  });

  // 5) 排序与分页断言：渲染出的行数、缺货列是否单调不增
  const r5 = await p.evaluate(() => {
    const trs = [...document.querySelectorAll('#adj-detail-card tbody tr')];
    const short = trs.map(tr => {
      const t = tr.children[11] ? tr.children[11].textContent.trim() : '';
      return t === '—' ? 0 : Number(t.replace(/,/g, '')) || 0;
    });
    let mono = true;
    for (let i = 1; i < short.length; i++) if (short[i] > short[i - 1] + 1e-9) { mono = false; break; }
    const bar = document.querySelector('#adj-detail-card').textContent.match(/共 (\d+) 条，已显示前 (\d+) 条/);
    return { rendered: trs.length, shortHead: short.slice(0, 8), mono, bar: bar ? bar[0] : '(无)', zeroTail: short.filter(x => x === 0).length };
  });

  console.log('=== 1) 首次进入 adjust-track ===');
  console.log('  renderAdjustTrack 耗时 =', r1.p.render1, 'ms（第2次触发 =', r1.p.render2, 'ms）');
  console.log('  内部调用 =', JSON.stringify(r1.p.t));
  console.log('  明细表渲染行数 =', r1.rows, ' 全页 DOM 节点 =', r1.dom);
  console.log('=== 2) 切批次筛选（缓存命中） ===');
  console.log('  renderAdjustTrack 耗时 =', r2.p.render1, 'ms');
  console.log('  内部调用 =', JSON.stringify(r2.p.t));
  console.log('  明细表渲染行数 =', r2.rows, ' 全页 DOM 节点 =', r2.dom);
  console.log('=== 3) 复位全部 + 缓存清空 ===');
  console.log('  renderAdjustTrack 耗时 =', r3.total, 'ms');
  console.log('  内部调用 =', JSON.stringify(r3.p.t));
  console.log('  明细表渲染行数 =', r3.rows);
  console.log('=== 4) buildAdjComputed 纯冷算 ===');
  console.log('  ' + r4.coldCompute + ' ms ｜ 记录数 ' + r4.n + ' ｜ 订单行 ' + r4.ordRows); console.log('  其中 shortMap 冷建 = ' + r4.shortMapMs + ' ms（' + r4.keys + ' 键）｜ 需求索引 = ' + r4.demandIdxMs + ' ms');
  console.log('=== 5) 排序 / 分页断言 ===');
  console.log('  渲染行数 =', r5.rendered, '｜ 控制条 =', r5.bar);
  console.log('  缺货列前 8 =', JSON.stringify(r5.shortHead), '｜ 单调不增 =', r5.mono ? '✅' : '❌', '｜ 其中 0 值行 =', r5.zeroTail);

  // 6) 图表复用后不能变空白：图1 series 长度 + canvas 尺寸
  // 7) 下钻（点四象限 B）+ 显示更多 各自的耗时
  const r67 = await p.evaluate(() => {
    const inst = id => { const el = document.getElementById(id); return el && window.echarts ? echarts.getInstanceByDom(el) : null; };
    const i1 = inst('adj-chart-type'), i3 = inst('adj-chart-batch');
    const cv = document.querySelector('#adj-chart-type canvas');
    const out = {
      typeSeries: i1 ? i1.getOption().series.map(s => (s.data || []).length) : null,
      batchSeries: i3 ? i3.getOption().series.map(s => (s.data || []).length) : null,
      canvasW: cv ? cv.width : 0, canvasH: cv ? cv.height : 0
    };
    // 下钻：点四象限 B 卡片
    window._adjState = { batch: 'all', rdc: 'all', type: 'all', hainan: 'all', quadrant: 'all', short: 'all', batchShort: false };
    renderAdjustTrack();
    let t0 = performance.now();
    window._adjState.quadrant = 'B'; renderAdjustTrack();
    out.drillMs = Math.round((performance.now() - t0) * 10) / 10;
    out.drillRows = document.querySelectorAll('#adj-detail-card tbody tr').length;
    out.drillBar = (document.getElementById('adj-detail-card').textContent.match(/共 (\d+) 条，已显示前 (\d+) 条/) || ['(无)'])[0];
    // 显示更多
    t0 = performance.now();
    window._adjReveal.n = 600; renderAdjustTrack();
    out.moreMs = Math.round((performance.now() - t0) * 10) / 10;
    out.moreRows = document.querySelectorAll('#adj-detail-card tbody tr').length;
    // 图表是否仍在（下钻/展开后不得空白）
    const i1b = inst('adj-chart-type');
    out.typeSeriesAfter = i1b ? i1b.getOption().series.map(s => (s.data || []).length) : null;
    out.canvasAfter = !!document.querySelector('#adj-chart-type canvas');
    return out;
  });
  console.log('=== 6) 图表复用校验 ===');
  console.log('  图1 series 长度 =', JSON.stringify(r67.typeSeries), '｜ 图3 series 长度 =', JSON.stringify(r67.batchSeries));
  console.log('  canvas 像素 =', r67.canvasW + 'x' + r67.canvasH);
  console.log('=== 7) 下钻 / 显示更多 耗时 ===');
  console.log('  点四象限 B 下钻 =', r67.drillMs, 'ms（明细 ' + r67.drillRows + ' 行 ｜ ' + r67.drillBar + '）');
  console.log('  显示更多 600 行 =', r67.moreMs, 'ms（明细 ' + r67.moreRows + ' 行）');
  console.log('  图表仍在 =', r67.canvasAfter ? '✅' : '❌', '｜ 图1 series =', JSON.stringify(r67.typeSeriesAfter));

  // 8) 口径等价性：shortMap 旧写法 vs v441 新写法（加先行过滤 + isWorkday 记忆化）必须逐键逐值一致
  const r8 = await p.evaluate(() => {
    const recs = dataStore.adjustRecords || [];
    // 旧写法（原样）
    const A = {}; let maxA = '';
    (dataStore.orderDetail || []).forEach(function(d) {
      if (!d.dateStr) return;
      if (d.dateStr > maxA) maxA = d.dateStr;
      if (!isWorkday(d.dateStr)) return;
      const k = d.dateStr + '|' + d.skuCode + '|' + d.warehouse;
      if (d.firstDayShort) A[k] = (A[k] || 0) + d.firstDayShort;
    });
    // 新写法（与看板实现逐行同一逻辑）
    const B = {}; let maxB = '';
    const needW = Object.create(null);
    recs.forEach(function(r) {
      const f = ADJ_RDC_FULL[r.rdc] || ((r.rdc || '') + 'RDC');
      if (!needW[r.sku]) needW[r.sku] = Object.create(null);
      needW[r.sku][f] = 1;
    });
    const wdc = Object.create(null);
    (dataStore.orderDetail || []).forEach(function(d) {
      if (!d.dateStr) return;
      if (d.dateStr > maxB) maxB = d.dateStr;
      if (!d.firstDayShort) return;
      const w = needW[d.skuCode];
      if (!w || !w[d.warehouse]) return;
      let wd = wdc[d.dateStr];
      if (wd === undefined) { wd = isWorkday(d.dateStr); wdc[d.dateStr] = wd; }
      if (!wd) return;
      const k = d.dateStr + '|' + d.skuCode + '|' + d.warehouse;
      B[k] = (B[k] || 0) + d.firstDayShort;
    });
    const ka = Object.keys(A), kb = Object.keys(B);
    let diff = 0;
    ka.forEach(k => { if (A[k] !== B[k]) diff++; });
    kb.forEach(k => { if (A[k] !== B[k]) diff++; });
    const sum = o => Object.keys(o).reduce((s, k) => s + o[k], 0);
    return { ka: ka.length, kb: kb.length, diff: diff, sumA: Math.round(sum(A) * 100) / 100, sumB: Math.round(sum(B) * 100) / 100, maxA: maxA, maxB: maxB };
  });
  console.log('=== 8) shortMap 口径等价性（旧 vs v441 新写法） ===');
  console.log('  键数 旧/新 =', r8.ka, '/', r8.kb, '｜ 值不一致键数 =', r8.diff, '｜ 合计 旧/新 =', r8.sumA, '/', r8.sumB);
  console.log('  数据覆盖边界 maxOrd 旧/新 =', r8.maxA, '/', r8.maxB, (r8.diff === 0 && r8.ka === r8.kb && r8.sumA === r8.sumB && r8.maxA === r8.maxB) ? '✅ 完全一致' : '❌ 有差异（键集不同）');

  // 9) 严格对拍：只比「代码真正会去查询的键」——shortMap 里查不到的键等于不存在
  const r9 = await p.evaluate(() => {
    const recs = dataStore.adjustRecords || [];
    const build = (useNeed) => {
      const M = {}; let max = '';
      const needW = Object.create(null);
      if (useNeed) recs.forEach(function(r) {
        const f = ADJ_RDC_FULL[r.rdc] || ((r.rdc || '') + 'RDC');
        if (!needW[r.sku]) needW[r.sku] = Object.create(null);
        needW[r.sku][f] = 1;
      });
      const wdc = Object.create(null);
      (dataStore.orderDetail || []).forEach(function(d) {
        if (!d.dateStr) return;
        if (d.dateStr > max) max = d.dateStr;
        if (!d.firstDayShort) return;
        if (useNeed) { const w = needW[d.skuCode]; if (!w || !w[d.warehouse]) return; }
        let wd = wdc[d.dateStr];
        if (wd === undefined) { wd = isWorkday(d.dateStr); wdc[d.dateStr] = wd; }
        if (!wd) return;
        const k = d.dateStr + '|' + d.skuCode + '|' + d.warehouse;
        M[k] = (M[k] || 0) + d.firstDayShort;
      });
      return { M: M, max: max };
    };
    const A = build(false), B = build(true);
    // 代码实际会查询的键集合：观察窗口 4 天 + 复现 7 天
    const q = new Set();
    recs.forEach(function(r) {
      const full = ADJ_RDC_FULL[r.rdc] || ((r.rdc || '') + 'RDC');
      const t = ADJ_TRANSPORT[r.rdc];
      if (t == null || !r.date) return;
      const arrival = _adjDateAdd(r.date, t);
      const winEnd = _adjDateAdd(arrival, ADJ_WINDOW_DAYS - 1);
      for (let i = 0; i < ADJ_WINDOW_DAYS; i++) q.add(_adjDateAdd(arrival, i) + '|' + r.sku + '|' + full);
      for (let i = 1; i <= 7; i++) q.add(_adjDateAdd(winEnd, i) + '|' + r.sku + '|' + full);
    });
    const diffKeys = [];
    let sumA = 0, sumB = 0, hitA = 0, hitB = 0;
    q.forEach(function(k) {
      const a = A.M[k] || 0, b = B.M[k] || 0;
      sumA += a; sumB += b;
      if (a) hitA++;
      if (b) hitB++;
      if (Math.abs(a - b) > 1e-9) diffKeys.push([k, a, b]);
    });
    return { queries: q.size, hitA: hitA, hitB: hitB, sumA: Math.round(sumA * 100) / 100, sumB: Math.round(sumB * 100) / 100, bad: diffKeys.length, sample: diffKeys.slice(0, 5) };
  });
  console.log('=== 9) 被查询键严格对拍（决定性） ===');
  console.log('  查询键总数 =', r9.queries, '｜ 命中 旧/新 =', r9.hitA, '/', r9.hitB);
  console.log('  查询键上的缺货合计 旧/新 =', r9.sumA, '/', r9.sumB);
  console.log('  不一致键数 =', r9.bad, r9.bad === 0 ? '✅ 口径完全一致' : '❌ 有真实差异: ' + JSON.stringify(r9.sample));

  // 10) 附带核查：新写法丢掉的 4,672 个键是「永不被查询」还是「前导零没对上」（后者的口径隐患需单独上报）
  const r10 = await p.evaluate(() => {
    const recs = dataStore.adjustRecords || [];
    const build = (useNeed) => {
      const M = {}; const needW = Object.create(null);
      if (useNeed) recs.forEach(function(r) {
        const f = ADJ_RDC_FULL[r.rdc] || ((r.rdc || '') + 'RDC');
        if (!needW[r.sku]) needW[r.sku] = Object.create(null);
        needW[r.sku][f] = 1;
      });
      const wdc = Object.create(null);
      (dataStore.orderDetail || []).forEach(function(d) {
        if (!d.dateStr || !d.firstDayShort) return;
        if (useNeed) { const w = needW[d.skuCode]; if (!w || !w[d.warehouse]) return; }
        let wd = wdc[d.dateStr]; if (wd === undefined) { wd = isWorkday(d.dateStr); wdc[d.dateStr] = wd; }
        if (!wd) return;
        const k = d.dateStr + '|' + d.skuCode + '|' + d.warehouse;
        M[k] = (M[k] || 0) + d.firstDayShort;
      });
      return M;
    };
    const A = build(false), B = build(true);
    // 记录侧：raw sku 与 norm sku 两套「是否被用到」的索引
    const rawSet = new Set(), normSet = new Set();
    const hasNorm = typeof normSkuCode === 'function';
    recs.forEach(function(r) {
      const f = ADJ_RDC_FULL[r.rdc] || ((r.rdc || '') + 'RDC');
      rawSet.add(r.sku + '|' + f);
      if (hasNorm) normSet.add(normSkuCode(r.sku) + '|' + f);
    });
    let dropped = 0, droppedAmt = 0, recoverable = 0, recoverableAmt = 0;
    const samples = [];
    Object.keys(A).forEach(function(k) {
      if (B[k] !== undefined) return;
      dropped++; droppedAmt += A[k];
      const p = k.split('|');
      const sku = p[1], wh = p[2];
      const nk = (hasNorm ? normSkuCode(sku) : sku) + '|' + wh;
      if (normSet.has(nk) && !rawSet.has(sku + '|' + wh)) {
        recoverable++; recoverableAmt += A[k];
        if (samples.length < 5) samples.push([k, A[k]]);
      }
    });
    return { dropped, droppedAmt: Math.round(droppedAmt), recoverable, recoverableAmt: Math.round(recoverableAmt), samples: samples, hasNorm: hasNorm };
  });
  console.log('=== 10) 被优化剔除的键是什么 ===');
  console.log('  剔除键数 =', r10.dropped, '｜ 含缺货量 =', r10.droppedAmt, '支');
  console.log('  其中「归一化后能对上某条调整记录」的 =', r10.recoverable, '个 /', r10.recoverableAmt, '支');
  if (r10.recoverable) console.log('  样例 =', JSON.stringify(r10.samples));
  console.log('\n运行时错误 ' + errs.length + (errs.length ? ': ' + errs.slice(0, 2).join(' || ') : ''));
  await b.close(); s.close(); process.exit(0);
})().catch(e => { console.error('异常', e && e.message); process.exit(2); });
