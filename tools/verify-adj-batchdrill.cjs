#!/usr/bin/env node
/**
 * v393 验证：补货调整跟踪「按补货批次」图 —— 点击红色「窗口缺货(箱)」柱下钻该批次缺货明细
 *   （用户 2026-09-30 要求：「点击窗口缺货红色柱子后，能跳转到相对应的缺货数据（可在调整明细中显示）」）
 *
 * 断言清单：
 *   ⓪ 页面运行时零报错；稳定停在「补货调整跟踪」页
 *   ① 图形契约：两张 series 名称正确 + 红柱 series[1] 带 cursor:'pointer'（可点提示）而粉柱没有
 *   ① 可发现性：卡片标题含「点红色柱可下钻该批次缺货明细」（v244：功能存在 ≠ 可发现）
 *   ② 柱值正确性：红柱逐柱 == 页面同源复算 Math.round(Σ of cuts(date==b && status!=='未开始').shortBoxes)
 *      （v390 教训：只验「容器存在 + series>0」是假绿）
 *   ③ 真实鼠标点击红柱 → 该点击确实命中 seriesIndex=1/dataIndex 对应柱 + _adjState.batch 置位 +
 *      batchShort=true + 自动滚到「调整明细」
 *   ④ 🔴 逐字同源对拍（本需求核心）：
 *        · 红柱口径全集合计（cut>0 且已进窗口）== 红柱柱值
 *        · 明细额外滤掉的 shortBoxes=0 行**贡献恒为 0** → 滤掉不改合计（这是「明细合计 == 柱值」成立的条件）
 *        · 精确 ΣshortBoxes == 红柱柱值（|差| < 0.5，红柱为 Math.round）
 *        · 明细行数 == 同源集合中「真的缺了」的条数（读同一入口 _adjFiltered，探针不另算一套）
 *        · 明细「窗口缺货(箱)」列合计 ≈ 红柱柱值（容差 ⌈n/2⌉，因表格是逐行 round 后叠加）+ 非零格数 == 复算条数
 *        · 明细所有行都属该批次、状态≠未开始、扣减量≠0
 *        · 明细卡「窗口缺货 N 条 / X 箱」的 X 逐位 == 红柱柱值（同为 round(Σ)，可精确相等）
 *   ⑤ 上下文徽标：明细卡头部含批次号 + 「筛选后 N 条」（v347：下钻不给上下文用户以为表格坏了）
 *   ⑥ 可退（v354 红线）：点「仅看窗口缺货 ✕」→ batchShort=false 且行数恢复为该批次全部记录
 *   ⑦ 不误伤：点粉色「扣减量」柱无任何状态变化；换批次下拉自动复位 batchShort
 *
 * 实现要点（踩过的坑）：
 *   · ECharts 5 已把 seriesIndex/dataIndex 移出元素自有属性 → `t.seriesIndex` 恒 undefined；
 *     正确读法是元素上的 `__ec_inner_*` 内部槽（见 window._barGeom）。
 *   · `zr.handler.findHover` 在网格区实测命中不到柱体（只命中图例）→ 不用它定位。
 *   · 柱子 shape 用的是**图表绝对坐标**（可直接当容器内偏移用），但柱高在入场动画期间是中间值
 *     → 纵向点一律用 `convertToPixel` 算（坐标轴刻度是立即确定的），不读 shape.height。
 *
 * 用法（项目根执行）：
 *   NODE_PATH=<node/workspace/node_modules> node tools/verify-adj-batchdrill.cjs > tools/_out/adjbatchdrill.txt 2>&1
 *   直连线上：LIVE_URL=https://rdc-dashboard.pages.dev NODE_PATH=... node tools/verify-adj-batchdrill.cjs
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const cands = [];
  for (const d of fs.readdirSync(base)) {
    cands.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    cands.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  const hit = cands.find(p => fs.existsSync(p));
  if (!hit) throw new Error('ms-playwright 下未找到 chromium');
  return hit;
}
function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// 页面内注入：按 (seriesIndex, dataIndex) 取柱体几何（走 __ec_inner 内部槽）
const GEOM_FN = `window._barGeom = function(chartId, si, di, val) {
  const el = document.getElementById(chartId);
  if (!el || !el.isConnected) return { ok: false, reason: 'container-missing' };
  const inst = (window.echarts && echarts.getInstanceByDom(el));
  if (!inst) return { ok: false, reason: 'no-instance' };
  const zr = inst.getZr();
  const list = zr.storage.getDisplayList(true);
  let target = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (!t || t.type !== 'rect') continue;
    const k = Object.keys(t).find(function (x) { return x.indexOf('__ec_inner') === 0; });
    if (!k) continue;
    const ec = t[k];
    if (ec && ec.seriesIndex === si && ec.dataIndex === di) { target = t; break; }
  }
  if (!target) return { ok: false, reason: 'bar-el-not-found', si: si, di: di, listLen: list.length };
  const sh = target.shape;
  const rect = el.getBoundingClientRect();
  let ctpY = null;
  try { ctpY = inst.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [di, val / 2])[1]; } catch (e) {}
  const base = sh.y, top = sh.y + sh.height;               // height 为负 → top < base
  let ly = (ctpY != null && isFinite(ctpY)) ? ctpY : (top + base) / 2;
  const lo = Math.min(top, base), hi = Math.max(top, base);
  if (ly < lo + 1) ly = lo + 1;
  if (ly > hi - 1) ly = hi - 1;
  return { ok: true, lx: sh.x + sh.width / 2, ly: ly, shape: { x: sh.x, y: sh.y, w: sh.width, h: sh.height },
    top: top, base: base, ctpY: ctpY,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
};
window._normTxt = function (s) { return String(s || '').replace(/\\s+/g, ''); };
window._regClickLog = function (chartId) {
  const inst = echarts.getInstanceByDom(document.getElementById(chartId));
  window._barClickLog = [];
  if (inst) inst.on('click', function (p) { window._barClickLog.push({ si: p.seriesIndex, di: p.dataIndex, name: p.name }); });
  return !!inst;
};`;

const BUILD = (/const BUILD_VERSION = (\d+)/.exec(fs.readFileSync(path.join(ROOT, 'rdc-dashboard.html'), 'utf8')) || [])[1];
console.log('源码 BUILD_VERSION =', BUILD, '（本工具验 v393：红柱下钻）');

const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail.push(msg); };

(async () => {
  let chromium;
  try { chromium = require('playwright-core').chromium; }
  catch (e) { console.error('需要 playwright-core（设置 NODE_PATH）'); process.exit(2); }
  const liveUrl = process.env.LIVE_URL || '';
  const server = liveUrl ? null : await startServer();
  const baseUrl = liveUrl || ('http://127.0.0.1:' + server.address().port);
  const entry = liveUrl ? (liveUrl.replace(/\/+$/, '') + '/') : (baseUrl + '/rdc-dashboard.html');
  if (liveUrl) console.log('直连线上：', entry);
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e && e.message ? e.message : String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 300)); });

  await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  const loaded = await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 })
    .then(() => true).catch(() => false);
  console.log('数据装载:', loaded ? 'OK' : '超时');
  // 陷阱：handleLogin 收尾会强制 navigateTo('overview')，必须等 _bootLoading===false 再导航，否则被抢走
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.evaluate(GEOM_FN);
  await page.evaluate(() => navigateTo('adjust-track'));
  await page.waitForTimeout(3500);
  const onPage = await page.evaluate(() => (typeof currentPage !== 'undefined' ? currentPage : '?'));
  console.log('当前页 =', onPage);
  ok(onPage === 'adjust-track', '⓪ 已稳定停在「补货调整跟踪」页（未被登录收尾的 navigateTo 抢走）');

  const shotDir = path.join(ROOT, 'tools', '_out');
  fs.mkdirSync(shotDir, { recursive: true });

  // ---------- ① 图形契约 + 可发现性 ----------
  console.log('\n① 图形契约 / 可发现性');
  const contract = await page.evaluate(() => {
    const card = document.getElementById('adj-chart-batch');
    const inst = card ? echarts.getInstanceByDom(card) : null;
    const opt = inst ? inst.getOption() : null;
    return {
      chartExists: !!card,
      seriesNames: opt ? (opt.series || []).map(s => s.name) : [],
      seriesCursor: opt ? (opt.series || []).map(s => (s.cursor || null)) : [],
      headerText: card && card.closest('.card') ? window._normTxt(card.closest('.card').innerText).slice(0, 200) : '(无)'
    };
  });
  console.log('      系列 =', JSON.stringify(contract.seriesNames), '| cursor =', JSON.stringify(contract.seriesCursor));
  ok(contract.chartExists, '① #adj-chart-batch 容器存在');
  ok(contract.seriesNames.length === 2 && contract.seriesNames[0] === '扣减量(箱)' && contract.seriesNames[1] === '窗口缺货(箱)',
    '① 两张 series 顺序正确（0=扣减量 / 1=窗口缺货）');
  ok(contract.seriesCursor[1] === 'pointer' && contract.seriesCursor[0] !== 'pointer',
    '① 红柱 cursor=pointer（可点提示）、粉柱无（不擅自扩展可点范围）');
  ok(/点红色柱可下钻该批次缺货明细/.test(contract.headerText), '① 卡片标题含「点红色柱可下钻该批次缺货明细」提示（v244 可发现性）');

  // ---------- ② 柱值正确性 ----------
  console.log('\n② 红柱柱值同源复算');
  const barChk = await page.evaluate(() => {
    const c = window.buildAdjComputed();
    const inst = echarts.getInstanceByDom(document.getElementById('adj-chart-batch'));
    const opt = inst.getOption();
    const cats = (opt.xAxis[0].data || []).slice();
    const red = (opt.series[1].data || []).slice();
    const bad = [];
    let nonZero = 0;
    // 🔴 红柱源码：cuts.filter(date===b && status!=='未开始').sum(shortBoxes)，其中 cuts = list.filter(cut>0)
    //   —— 复算必须逐字带上 cut>0，漏掉会多算（首版探针就是漏了这个，报出 8 项假红）
    const wantOf = function (b, extra) {
      return Math.round(c.list.filter(function (r) {
        if (r.date !== b || !(r.cut > 0)) return false;
        return extra(r);
      }).reduce(function (s, r) { return s + r.shortBoxes; }, 0));
    };
    cats.forEach(function (b, i) {
      const want = wantOf(b, function (r) { return r.status !== '未开始'; });
      if (red[i] !== want) bad.push({ b: b, chart: red[i], calc: want });
      if (want > 0) nonZero++;
    });
    // 反向①：漏掉 cut>0（用 list 而非 cuts）→ 柱值应变 → 证明 cut>0 分支非死代码
    const noCut = cats.map(function (b) { return Math.round(c.list.filter(function (r) { return r.date === b && r.status !== '未开始'; }).reduce(function (s, r) { return s + r.shortBoxes; }, 0)); });
    const differsNoCut = noCut.filter(function (v, i) { return v !== red[i]; }).length;
    // 反向②：把 status!=='未开始' 换成 '已完成'（即归因表 _adjState.short 的口径）→ 证明「不复用 short」是必要的
    const asDone = cats.map(function (b) { return wantOf(b, function (r) { return r.status === '已完成'; }); });
    const differsDone = asDone.filter(function (v, i) { return v !== red[i]; }).length;
    const sumRed = red.reduce(function (s, v) { return s + v; }, 0);
    const sumDone = asDone.reduce(function (s, v) { return s + v; }, 0);
    let best = -1, bestV = -1;
    red.forEach(function (v, i) { if (v > bestV) { bestV = v; best = i; } });
    return { bad: bad, nonZero: nonZero, catN: cats.length, differsNoCut: differsNoCut,
      differsDone: differsDone, sumRed: sumRed, sumDone: sumDone,
      bestDi: best, bestVal: bestV, cats: cats, red: red };
  });
  console.log('      红柱非零批次数 =', barChk.nonZero, '/', barChk.catN, '| 最大柱 =', barChk.cats[barChk.bestDi], '=', barChk.bestVal, '箱');
  console.log('      反向① 漏掉 cut>0 的口径 → 有差异的柱数 =', barChk.differsNoCut, '（>0 证明 cut>0 分支非死代码）');
  console.log('      反向② 换成归因表「已完成」口径 → 有差异的柱数 =', barChk.differsDone,
    '｜合计 ' + barChk.sumDone + ' vs 红柱 ' + barChk.sumRed + '（少 ' + (barChk.sumRed - barChk.sumDone) + ' 箱）');
  if (barChk.bad.length) console.log('      不一致明细 =', JSON.stringify(barChk.bad.slice(0, 5)));
  ok(barChk.bad.length === 0, '② 红柱逐柱 == 页面同源复算（' + barChk.catN + ' 根全部对上）');
  ok(barChk.bestVal > 0, '② 存在非零红柱可点（最大 ' + barChk.bestVal + ' 箱）');
  ok(barChk.differsNoCut > 0, '② 反向①：「cut>0」分支非死代码（' + barChk.differsNoCut + ' 根柱值会变）');
  ok(barChk.sumRed >= barChk.sumDone, '② 反向②：红柱（含「进行中」）≥ 归因表「已完成」口径（+' + (barChk.sumRed - barChk.sumDone) + ' 箱）→ 复用 short 会漏算，独立 batchShort 分支必要');
  const TARGET_DI = barChk.bestDi, TARGET_BATCH = barChk.cats[barChk.bestDi], TARGET_VAL = barChk.bestVal;

  // ---------- 点击助手 ----------
  async function clickBar(si, di, val) {
    await page.evaluate(() => document.getElementById('adj-chart-batch').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    const g = await page.evaluate(([id, s, d, v]) => window._barGeom(id, s, d, v), ['adj-chart-batch', si, di, val]);
    if (!g.ok) return { clicked: false, reason: g.reason };
    const x = g.rect.left + g.lx, y = g.rect.top + g.ly;
    await page.evaluate(([id]) => window._regClickLog(id), ['adj-chart-batch']);
    await page.mouse.move(x, y);
    await page.waitForTimeout(80);
    await page.mouse.click(x, y);
    const log = await page.evaluate(() => window._barClickLog || []);
    return { clicked: true, x: Math.round(x), y: Math.round(y), lx: Math.round(g.lx), ly: Math.round(g.ly),
      shape: g.shape, top: Math.round(g.top), base: Math.round(g.base), clickLog: log };
  }

  // ---------- ③ 真实鼠标点击红柱 ----------
  console.log('\n③ 真实鼠标点击红柱：' + TARGET_BATCH + '（柱值 ' + TARGET_VAL + ' 箱，dataIndex=' + TARGET_DI + '）');
  const c1 = await clickBar(1, TARGET_DI, TARGET_VAL);
  console.log('      点击点 = 容器内 (' + c1.lx + ',' + c1.ly + ') → 视口 (' + c1.x + ',' + c1.y + ')');
  if (c1.clicked) console.log('      柱体 shape =', JSON.stringify(c1.shape), '| 顶/基线 y =', c1.top, '/', c1.base);
  console.log('      ECharts click 回调记录 =', JSON.stringify(c1.clickLog));
  ok(c1.clicked, '③ 红柱命中点可定位（__ec_inner 内部槽 + convertToPixel）');
  ok(c1.clicked && c1.clickLog.some(h => h.si === 1 && h.di === TARGET_DI),
    '③ ECharts click 回调确认为 seriesIndex=1 / dataIndex=' + TARGET_DI + '（点到的就是目标红柱）');
  const after1 = await page.evaluate(() => ({ batch: window._adjState.batch, batchShort: window._adjState.batchShort }));
  console.log('      _adjState.batch =', after1.batch, '| batchShort =', after1.batchShort);
  ok(after1.batch === TARGET_BATCH, '③ 点击红柱 → _adjState.batch 置为该柱批次「' + TARGET_BATCH + '」（用 p.dataIndex 回查 batchAsc，非 p.name）');
  ok(after1.batchShort === true, '③ 点击红柱 → batchShort=true（只看该批次缺货行）');
  const jumped = await page.waitForFunction(() => {
    const el = document.getElementById('adj-detail-card');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top >= -40 && r.top < 460;
  }, { timeout: 8000 }).then(() => true).catch(() => false);
  ok(jumped, '③ 已自动滚动到「调整明细」卡片（复用 v347 的 _adjJumpDetail 一次性标志）');

  // ---------- ④ 🔴 逐字同源对拍（本需求核心） ----------
  console.log('\n④ 🔴 逐字同源对拍：明细行集合 == 红柱口径，明细箱数合计 == 红柱柱值');
  const core = await page.evaluate(function (tb) {
    const list = window.buildAdjComputed().list;
    // 🔴 与红柱逐字同源：cut > 0 && status !== '未开始'（漏掉 cut>0 会多算 —— 首版探针即因此假红）
    const sameSource = list.filter(function (r) { return r.date === tb && r.cut > 0 && r.status !== '未开始'; });
    const ssShort = sameSource.filter(function (r) { return r.shortBoxes > 0; });
    const exactSum = ssShort.reduce(function (s, r) { return s + r.shortBoxes; }, 0);
    // 红柱口径「全集」合计 —— 与「只留 shortBoxes>0」的合计必须恒等（被滤掉的行贡献 0，不改合计）
    const sumAllSameSource = sameSource.reduce(function (s, r) { return s + r.shortBoxes; }, 0);
    const dropped = sameSource.filter(function (r) { return !(r.shortBoxes > 0); });
    const droppedSum = dropped.reduce(function (s, r) { return s + r.shortBoxes; }, 0);
    // 读同一入口 _adjFiltered（探针不另算一套口径）
    const filtered = (typeof _adjFiltered === 'function') ? _adjFiltered(window.buildAdjComputed()) : null;
    // 明细表实际渲染内容
    const t = document.querySelectorAll('#page-adjust-track table.data-table')[1];
    const trs = Array.from(t.querySelectorAll('tbody tr'));
    const num = function (s) { return parseFloat(String(s).replace(/[^0-9.\-]/g, '')) || 0; };
    let colSum = 0, colNonZero = 0, otherBatch = 0, statusNotStart = 0, badCut = 0;
    trs.forEach(function (tr) {
      const td = tr.children;
      const v = num(td[11].innerText);
      colSum += v; if (v > 0) colNonZero++;
      if (td[0].innerText.trim() !== tb) otherBatch++;
      if (td[10].innerText.trim() === '未开始') statusNotStart++;
      if (num(td[7].innerText) === 0) badCut++;
    });
    const card = document.getElementById('adj-detail-card');
    return {
      nSameSource: sameSource.length, exactSum: exactSum, nShort: ssShort.length,
      sumAllSameSource: sumAllSameSource, nDropped: dropped.length, droppedSum: droppedSum,
      nFiltered: filtered ? filtered.length : -1,
      filteredShortSum: filtered ? filtered.filter(function (r) { return r.shortBoxes > 0; }).reduce(function (s, r) { return s + r.shortBoxes; }, 0) : -1,
      tableRows: trs.length, colSum: colSum, colNonZero: colNonZero,
      otherBatch: otherBatch, statusNotStart: statusNotStart, badCut: badCut,
      headerNorm: window._normTxt(card ? card.innerText : ''),
      allBatchRows: list.filter(function (r) { return r.date === tb; }).length
    };
  }, TARGET_BATCH);
  console.log('      红柱口径全集 ' + core.nSameSource + ' 条（cut>0 且已进窗口）→ 合计 ' + core.sumAllSameSource.toFixed(3) + ' 箱');
  console.log('      其中缺货 ' + core.nShort + ' 条 → 合计 ' + core.exactSum.toFixed(3) + ' 箱；被滤掉 ' + core.nDropped + ' 条（缺货量为 0，贡献 ' + core.droppedSum.toFixed(3) + ' 箱，不改合计）');
  console.log('      红柱（Math.round）= ' + TARGET_VAL + ' → |差| = ' + Math.abs(core.exactSum - TARGET_VAL).toFixed(3));
  console.log('      页面 filtered ' + core.nFiltered + ' 条 | 表格渲染 ' + core.tableRows + ' 行 | 表格列合计 = ' + core.colSum.toFixed(3) + '（逐行 round 后叠加）｜非零格 ' + core.colNonZero + ' 个');
  console.log('      批次不符行 = ' + core.otherBatch + '｜状态=未开始行 = ' + core.statusNotStart + '｜扣减量=0 行 = ' + core.badCut);
  ok(Math.abs(core.sumAllSameSource - TARGET_VAL) < 0.5, '④ 🔴 红柱口径全集合计 == 红柱柱值（|差| < 0.5）');
  ok(core.droppedSum < 1e-9, '④ 被额外滤掉的 ' + core.nDropped + ' 条全部「缺口量=0」→ 滤掉不改变合计（这是「明细合计 == 柱值」的成立条件）');
  ok(Math.abs(core.exactSum - TARGET_VAL) < 0.5, '④ 精确 ΣshortBoxes == 红柱柱值（|差| < 0.5，红柱为 Math.round）');
  ok(core.nFiltered === core.nShort, '④ 页面筛选行数 ' + core.nFiltered + ' == 同源集合中「真的缺了」的条数 ' + core.nShort);
  ok(core.tableRows === core.nShort, '④ 表格实际渲染 ' + core.tableRows + ' 行 == 同源缺货条数');
  ok(Math.abs(core.filteredShortSum - core.exactSum) < 1e-9, '④ 页面 filtered 的缺货合计 == 同源复算（1e-9 对拍）');
  const tol = Math.ceil(core.tableRows / 2);
  ok(Math.abs(core.colSum - TARGET_VAL) <= tol, '④ 🔴 明细「窗口缺货(箱)」列合计 ' + core.colSum.toFixed(0) + ' ≈ 红柱柱值 ' + TARGET_VAL + '（容差 ' + tol + ' = 逐行 round 累积）');
  ok(core.colNonZero === core.nShort, '④ 明细中非零缺货格数 ' + core.colNonZero + ' == 复算缺货条数 ' + core.nShort);
  ok(core.otherBatch === 0, '④ 明细所有行都属于批次 ' + TARGET_BATCH + '（无混入其它批次）');
  ok(core.statusNotStart === 0, '④ 明细中无「未开始」行（与红柱 status!==未开始 口径一致）');
  ok(core.badCut === 0, '④ 明细中无「扣减量=0」行（与红柱 cut>0 口径一致）');

  // ---------- ⑤ 上下文徽标 ----------
  console.log('\n⑤ 上下文徽标（v347：下钻后必须告诉用户「现在筛的是什么」）');
  const badgeVal = String(Math.round(core.exactSum)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const hN = core.headerNorm;
  console.log('      期望（去空白）含：批次' + TARGET_BATCH + ' / 筛选后' + core.nShort + '条 / 窗口缺货' + core.nShort + '条/' + badgeVal + '箱');
  console.log('      实际徽标 =', hN.slice(0, 160));
  ok(hN.indexOf('批次' + TARGET_BATCH) >= 0, '⑤ 明细卡徽标写明当前批次号「' + TARGET_BATCH + '」');
  ok(hN.indexOf('筛选后' + core.nShort + '条') >= 0, '⑤ 徽标「筛选后 N 条」数字与同源缺货条数一致（' + core.nShort + ' 条）');
  ok(hN.indexOf('窗口缺货' + core.nShort + '条/' + badgeVal + '箱') >= 0,
    '⑤ 🔴 徽标「窗口缺货 ' + core.nShort + ' 条 / ' + badgeVal + ' 箱」逐位 == 红柱柱值（同为 round(Σ)，精确相等）');
  ok(/仅看窗口缺货/.test(hN), '⑤ 存在可退出的「仅看窗口缺货 ✕」徽标（v354 筛选态必须可见可退）');

  await page.screenshot({ path: path.join(shotDir, 'adjbatchdrill-drilled.png') }).then(() => console.log('      截图 tools/_out/adjbatchdrill-drilled.png')).catch(() => {});

  // ---------- ⑥ 可退 ----------
  console.log('\n⑥ 可退：点「仅看窗口缺货 ✕」→ 恢复该批次全部记录');
  const clickedX = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('#adj-detail-card span.badge'));
    const el = cands.find(s => /仅看窗口缺货/.test(s.textContent));
    if (!el) return false;
    el.click();
    return true;
  });
  await page.waitForTimeout(1500);
  const afterX = await page.evaluate(() => ({
    batch: window._adjState.batch, batchShort: window._adjState.batchShort,
    rows: document.querySelectorAll('#page-adjust-track table.data-table')[1].querySelectorAll('tbody tr').length,
    headerNorm: window._normTxt(document.getElementById('adj-detail-card').innerText)
  }));
  console.log('      ✕ 命中 =', clickedX, '| batch =', afterX.batch, '| batchShort =', afterX.batchShort, '| 行数 =', afterX.rows);
  console.log('      预期：批次保留 ' + TARGET_BATCH + '、行数恢复为 ' + core.allBatchRows + '（该批次全部记录，不限缺货）');
  ok(clickedX, '⑥ 找到并点击了「仅看窗口缺货 ✕」出口');
  ok(afterX.batchShort === false, '⑥ ✕ → batchShort 复位为 false');
  ok(afterX.batch === TARGET_BATCH, '⑥ ✕ → 只关这一层，保留批次筛选 ' + TARGET_BATCH);
  ok(afterX.rows === core.allBatchRows, '⑥ ✕ → 明细恢复该批次全部 ' + core.allBatchRows + ' 行');
  ok(!/仅看窗口缺货/.test(afterX.headerNorm), '⑥ ✕ 徽标已消失');

  // ---------- ⑦ 不误伤 ----------
  console.log('\n⑦ 不误伤：粉柱不可点 + 换批次下拉复位');
  await page.evaluate(() => { window._adjState.batch = 'all'; window._adjState.batchShort = false; renderAdjustTrack(); });
  await page.waitForTimeout(3000);
  const pinkVal = await page.evaluate(function (di) {
    const inst = echarts.getInstanceByDom(document.getElementById('adj-chart-batch'));
    return (inst.getOption().series[0].data || [])[di];
  }, TARGET_DI);
  const c2 = await clickBar(0, TARGET_DI, pinkVal);
  await page.waitForTimeout(1500);
  const after2 = await page.evaluate(() => ({ batch: window._adjState.batch, batchShort: window._adjState.batchShort }));
  console.log('      点粉色「扣减量」柱（值 ' + pinkVal + ' 箱，dataIndex=' + TARGET_DI + '）→ click 记录 =', JSON.stringify(c2.clickLog || []));
  console.log('      batch =', after2.batch, '| batchShort =', after2.batchShort, '（期望 all / false）');
  ok(c2.clicked && (c2.clickLog || []).some(h => h.si === 0 && h.di === TARGET_DI), '⑦ 确已点在 seriesIndex=0 的粉柱上');
  ok(after2.batch === 'all' && after2.batchShort === false, '⑦ 点击粉柱无任何状态变化（只在 seriesIndex===1 生效）');

  // 先造出「已下钻」状态，再用下拉换批次 → batchShort 必须自动复位
  await page.evaluate(function (tb) { window._adjState.batch = tb; window._adjState.batchShort = true; renderAdjustTrack(); }, TARGET_BATCH);
  await page.waitForTimeout(2000);
  const preSel = await page.evaluate(() => ({ b: window._adjState.batch, bs: window._adjState.batchShort }));
  const selIdx = await page.evaluate(() => Array.from(document.querySelectorAll('#page-adjust-track select'))
    .findIndex(s => Array.from(s.options).some(o => o.value === 'all' && /全部批次/.test(o.textContent))));
  console.log('      批次下拉索引 =', selIdx, '| 切换前 batch/batchShort =', preSel.b, '/', preSel.bs);
  ok(selIdx >= 0, '⑦ 找到批次下拉');
  if (selIdx >= 0) {
    await page.locator('#page-adjust-track select').nth(selIdx).selectOption('all');
    await page.waitForTimeout(2000);
    const afterSel = await page.evaluate(() => ({
      batch: window._adjState.batch, batchShort: window._adjState.batchShort,
      rows: document.querySelectorAll('#page-adjust-track table.data-table')[1].querySelectorAll('tbody tr').length,
      total: window.buildAdjComputed().list.length
    }));
    console.log('      切「全部批次」后 → batch =', afterSel.batch, '| batchShort =', afterSel.batchShort, '| 行数 =', afterSel.rows, '/ 全量', afterSel.total);
    ok(afterSel.batchShort === false, '⑦ 换批次下拉自动复位 batchShort（避免下钻态污染后续筛选）');
    ok(afterSel.batch === 'all' && afterSel.rows === afterSel.total, '⑦ 下拉切到「全部批次」→ 明细恢复全量 ' + afterSel.total + ' 行');
  }

  await browser.close();
  if (server) server.close();

  console.log('\n⑧ 页面运行时错误:', errs.length ? errs.slice(0, 3) : '无');
  ok(errs.length === 0, '⓪ 全程零 pageerror / console.error');
  console.log('\n' + (fail.length ? '❌ 未通过 ' + fail.length + ' 项：\n  - ' + fail.join('\n  - ') : '✅ v393 红柱下钻全部验证通过'));
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('工具异常:', e && e.message, e && e.stack ? e.stack.split('\n').slice(1, 3).join(' | ') : ''); process.exit(2); });
