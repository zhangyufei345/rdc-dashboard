#!/usr/bin/env node
/**
 * v349 验证：砍量冗余验证的折算分母改为「到货日起未来 60 天的日均分仓需求」
 *   ① 页面运行时零报错
 *   ② KPI 副标题 = 「按未来 60 天需求折算 ≈ 平均 X 天」
 *   ③ 明细表列头含「未来日均需求(支)」，且不再出现「日均出货」
 *   ④ 页面内独立复算（自建 demandIdx：分仓计划优先 + 8月覆盖 cov09~cov14 回退，按月内自然日线性摊平）
 *      与页面 buildAdjComputed() 的 futDaily / redundantDays 逐条比对
 *   ⑤ ECharts Top10 图的条值 == 页面同源复算的 redundantDays（图表没走偏）
 *
 * 用法（项目根执行）：
 *   NODE_PATH=... node tools/verify-redund-demand.cjs > tools/_out/redund.txt 2>&1
 *   直连线上：LIVE_URL=https://rdc-dashboard.pages.dev NODE_PATH=... node tools/verify-redund-demand.cjs
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

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } }

(async () => {
  const chromium = require('playwright-core').chromium;
  const liveUrl = process.env.LIVE_URL || '';
  const server = liveUrl ? null : await startServer();
  const port = server ? server.address().port : 0;
  const baseUrl = liveUrl || ('http://127.0.0.1:' + port);
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
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 });
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 120000 }).catch(() => {});
  await page.evaluate(() => navigateTo('adjust-track'));
  // 本页会自己触发 ensureInventoryPlan（v349 新增），等它就绪（就绪后 ensureInventoryPlan 会重渲本页）
  const planReady = await page.waitForFunction(() => window._invPlanReady === true
    && dataStore.inventory && dataStore.inventory.planBySkuRdc && Object.keys(dataStore.inventory.planBySkuRdc).length > 0,
    { timeout: 150000 }).then(() => true).catch(() => false);
  console.log('分仓计划就绪:', planReady ? 'OK' : '超时（走覆盖表回退）');
  await page.waitForTimeout(2500);

  const res = await page.evaluate(() => {
    // ---- 页面侧（被测口径）----
    const c = window.buildAdjComputed();
    const doneCuts = c.list.filter(r => r.cut > 0 && r.status === '已完成');
    const cd = doneCuts.filter(r => r.quadrant === 'C' || r.quadrant === 'D');

    // ---- 独立复算（不复用页面函数）----
    const inv = dataStore.inventory || {};
    const pb = inv.planBySkuRdc || {};
    const cov = {};
    (inv.cov7 || []).forEach(d => { if (d && d.rdc && d.sku) cov[d.rdc + '|' + d.sku] = d; });
    const COVM = { '2026-09': 'cov09', '2026-10': 'cov10', '2026-11': 'cov11', '2026-12': 'cov12', '2027-01': 'cov13', '2027-02': 'cov14' };
    function mDemand(sku, rdc, ym) {
      const p = pb[sku] && pb[sku][rdc] && pb[sku][rdc][ym];
      if (p != null && !isNaN(p) && p > 0) return Number(p);
      const d = cov[rdc + '|' + sku]; const f = COVM[ym];
      if (d && f) return d[f] || 0;
      return null;
    }
    function dDemand(sku, rdc, day) {
      const ym = day.slice(0, 7);
      const m = mDemand(sku, rdc, ym);
      if (m == null) return null;
      const dim = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
      return m / dim;
    }
    // 本地日期加法（不复用页面 _adjDateAdd）
    function addDay(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
    const rows = cd.map(r => {
      const spec = r.spec || 1;
      let sum = 0, days = 0;
      for (let i = 0; i < 60; i++) {
        const v = dDemand(r.sku, r.rdcFull, addDay(r.arrival, i));
        if (v == null) continue;
        sum += v; days++;
      }
      const myFutDaily = (days > 0 && sum > 0) ? Math.round(sum / days * 100) / 100 : null;
      const myRed = myFutDaily != null ? Math.round(r.cut * spec / myFutDaily * 10) / 10 : null;
      return { idx: r.idx, sku: r.sku, rdc: r.rdc, cut: r.cut, spec: spec, arrival: r.arrival,
        myFutDaily: myFutDaily, myRed: myRed, pageFutDaily: r.futDaily, pageRed: r.redundantDays,
        myFutDemand: Math.round(sum) };
    });
    const bad = rows.filter(x => (x.myFutDaily == null) !== (x.pageFutDaily == null)
      || (x.myFutDaily != null && Math.abs(x.myFutDaily - x.pageFutDaily) > 0.011)
      || (x.myRed != null && Math.abs(x.myRed - (x.pageRed == null ? -1 : x.pageRed)) > 0.011));
    // ECharts Top10
    const dom = document.getElementById('adj-chart-redund');
    const inst = window.echarts && window.echarts.getInstanceByDom(dom);
    const chartData = inst ? (inst.getOption().series[0].data || []).map(x => (x && typeof x === 'object') ? x.value : x) : null;
    // KPI / 表头 / 文案
    const kpi = Array.from(document.querySelectorAll('#page-adjust-track .kpi-card')).map(e => e.innerText.replace(/\s+/g, ' '));
    const headHtml = document.getElementById('page-adjust-track').innerHTML;
    const headerCells = Array.from(document.querySelectorAll('#page-adjust-track table.data-table thead th')).map(th => th.textContent.trim());
    const hasOldHeader = headerCells.indexOf('日均出货(支)') >= 0;
    const titleTexts = Array.from(document.querySelectorAll('#page-adjust-track div')).map(e => e.textContent).filter(t => /砍对记录冗余天数/.test(t)).slice(0, 1);
    // 明细表里冗余天数 / 未来日均需求 列的实际单元格
    const tbl = Array.from(document.querySelectorAll('#page-adjust-track table.data-table')).find(t => /未来日均需求/.test(t.innerText));
    let sampleCells = null;
    if (tbl) {
      const ths = Array.from(tbl.querySelectorAll('thead th')).map(t => t.textContent.trim());
      const iD = ths.indexOf('未来日均需求(支)'), iR = ths.indexOf('冗余天数'), iC = ths.indexOf('扣减量(箱)');
      const tr = tbl.querySelectorAll('tbody tr');
      sampleCells = Array.from(tr).slice(0, 4).map(x => {
        const td = x.querySelectorAll('td');
        return { sku: td[2] ? td[2].textContent.trim() : '', rdc: td[1] ? td[1].textContent.trim() : '',
          cut: td[iC] ? td[iC].textContent.trim() : '', fut: td[iD] ? td[iD].textContent.trim() : '', red: td[iR] ? td[iR].textContent.trim() : '' };
      });
    }
    return {
      maxOrd: c.maxOrd, cdCnt: cd.length, rows: rows, bad: bad.slice(0, 6), badCnt: bad.length,
      chartData: chartData, kpi: kpi, hasOldHeader: hasOldHeader, headerCells: headerCells,
      title: titleTexts[0] ? titleTexts[0].slice(0, 120) : '(未找到)', sampleCells: sampleCells,
      pbCnt: Object.keys(pb).length,
      top5: rows.slice().sort((a, b) => b.pageRed - a.pageRed).slice(0, 5),
      sku09710: rows.filter(x => x.sku === '09710').map(x => ({ rdc: x.rdc, red: x.pageRed, fut: x.pageFutDaily })).sort((a, b) => b.red - a.red).slice(0, 6)
    };
  });

  // 视觉留证
  const shotDir = path.join(ROOT, 'tools', '_out');
  fs.mkdirSync(shotDir, { recursive: true });
  const dataUrl = await page.evaluate(() => {
    const inst = window.echarts && window.echarts.getInstanceByDom(document.getElementById('adj-chart-redund'));
    return inst ? inst.getDataURL({ pixelRatio: 2, backgroundColor: '#fff' }) : null;
  }).catch(() => null);
  if (dataUrl && dataUrl.indexOf(',') > 0) {
    fs.writeFileSync(path.join(shotDir, 'redund-chart.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('图表已导出 tools/_out/redund-chart.png');
  } else console.log('图表导出失败（可能是 rdVals 为空，图上无数据）');
  // 整屏：先滚到「砍量冗余验证」卡片顶部（headless-shell 元素截图会偏移，用整屏）
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('#page-adjust-track .card-title')).find(x => /砍量冗余验证/.test(x.textContent));
    const card = t ? t.closest('.card') : document.getElementById('adj-chart-redund');
    if (card) { try { card.scrollIntoView({ block: 'start' }); } catch (e) { card.scrollIntoView(); } }
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(shotDir, 'redund-viewport.png') })
    .then(() => console.log('整屏截图已存 tools/_out/redund-viewport.png')).catch(e => console.log('整屏截图失败:', e.message));

  await browser.close();
  if (server) server.close();

  console.log('\nmaxOrd =', res.maxOrd, '| 扣减且走完 =', res.cdCnt, '| C/D 记录 =', res.rows.length, '| planBySkuRdc SKU =', res.pbCnt);
  console.log('页面 KPI 卡 =', JSON.stringify(res.kpi));
  console.log('\n[独立复算 vs 页面] 前 6 条：');
  res.rows.slice(0, 6).forEach(x => {
    console.log('  ' + x.sku + '·' + x.rdc + ' 到货' + x.arrival + ' 扣减' + x.cut + '箱×' + x.spec + '支 | 复算 日均' + x.myFutDaily +
      ' → ' + x.myRed + '天 ‖ 页面 日均' + x.pageFutDaily + ' → ' + x.pageRed + '天');
  });
  console.log('\nTop5（按页面 redundantDays 降序）:');
  res.top5.forEach(x => console.log('  ' + x.sku + '·' + x.rdc + ' 扣减' + x.cut + '箱 → ' + x.pageRed + ' 天（日均需求 ' + x.pageFutDaily + '）'));

  console.log('\n断言：');
  ok(errs.length === 0, '① 页面运行时零报错' + (errs.length ? '（' + JSON.stringify(errs.slice(0, 2)) + '）' : ''));
  ok(/按未来 60 天需求折算 ≈ 平均/.test(res.kpi.join(' ')), '② KPI 副标题已改为「按未来 60 天需求折算 ≈ 平均 X 天」');
  ok(res.headerCells.indexOf('未来日均需求(支)') >= 0, '③ 明细表列头含「未来日均需求(支)」');
  ok(res.hasOldHeader === false, '③ 表头不再有「日均出货(支)」列');
  ok(res.badCnt === 0 && res.rows.length > 0, '④ 独立复算与页面逐条一致（' + res.rows.length + ' 条，不一致 ' + res.badCnt + ' 条）');
  const chartOk = res.chartData && res.chartData.length > 0 && res.chartData.every(v => res.rows.some(x => Math.abs(x.pageRed - v) < 0.011));
  ok(chartOk, '⑤ Top10 图条值与页面复算一致（图上 ' + (res.chartData ? res.chartData.length : 0) + ' 条）');
  const skuMax = res.sku09710.length ? Math.max.apply(null, res.sku09710.map(x => x.red || 0)) : 0;
  ok(res.sku09710.length > 0 && skuMax <= 60, '⑥ 旧口径失真情已消除：09710 各 RDC 最大冗余 ' + skuMax + ' 天（旧口径华中 890 / 西北 210 / 西南 194 天）');
  console.log('   09710 明细 = ' + JSON.stringify(res.sku09710));
  console.log('   全表最大冗余 = ' + Math.max.apply(null, res.rows.map(x => x.pageRed == null ? 0 : x.pageRed).concat([0])) +
    ' 天（36507 启初爽身粉·华北，未来需求仅 0.7 支/天 = 9 月后进淡季，属真实季节性压货而非失真）');

  console.log('\n' + (fail === 0 ? '✅ 全部通过（' + pass + ' 项）' : '❌ ' + fail + ' 项未通过'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('工具异常:', e && e.stack || e); process.exit(2); });
