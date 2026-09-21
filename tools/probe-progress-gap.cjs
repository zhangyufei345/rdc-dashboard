// 探针：为什么「图1 总体订单进度 71.9%」高于「图2 各 RDC MTD 累计完成率」的所有线？
// 目的：把两张图各自的分子/分母从页面真实数据里挖出来对账（不估算）。
// 用法：cd ROOT && NODE_PATH=... node tools/probe-progress-gap.cjs
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript' };

function serve() {
  return new Promise(res => {
    const s = http.createServer((req, rq) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rq.writeHead(404); rq.end('nf'); return; }
      rq.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rq);
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}

(async () => {
  const srv = await serve();
  const port = srv.address().port;
  const exe = (() => {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    const cands = [];
    for (const d of fs.readdirSync(base)) {
      cands.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
      cands.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
    }
    return cands.find(p => fs.existsSync(p));
  })();
  if (!exe) throw new Error('ms-playwright 下未找到 chromium');
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  await page.goto(`http://127.0.0.1:${port}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 120000 });
  await page.evaluate(async () => { if (typeof ensureDemandMerged === 'function') await ensureDemandMerged(); });
  await page.evaluate(() => { if (typeof ensureInventoryPlan === 'function') return ensureInventoryPlan(); });
  await page.waitForTimeout(2000);
  await page.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('plan-monitor'); });
  await page.waitForTimeout(3000);

  const out = await page.evaluate(() => {
    const RDC6 = ['东北RDC', '华北RDC', '华南RDC', '华中RDC', '西北RDC', '西南RDC'];
    const M = '2026-09', DAY = 20;
    const inv = (typeof dataStore !== 'undefined' && dataStore && dataStore.inventory) || {};
    const pb = inv.planBySkuRdc || {}, sb = inv.actualShipBySkuRdc || {};
    const planR = {}, shipR = {};
    for (const s in pb) for (const r in pb[s]) planR[r] = (planR[r] || 0) + ((pb[s][r] || {})[M] || 0);
    for (const s in sb) for (const r in sb[s]) shipR[r] = (shipR[r] || 0) + ((sb[s][r] || {})[M] || 0);
    const od = (dataStore.orderDetail || []).filter(d => d.dateStr && d.dateStr.indexOf(M) === 0);
    const odAll = {}, od20 = {};
    od.forEach(d => {
      const rdc = (typeof normalizeRdcName === 'function') ? normalizeRdcName(d.warehouse) : d.warehouse;
      const q = d.orderQty || 0, day = Number(String(d.dateStr).slice(8, 10));
      odAll[rdc] = (odAll[rdc] || 0) + q;
      if (day >= 1 && day <= DAY) od20[rdc] = (od20[rdc] || 0) + q;
    });
    const unrel = (dataStore.unreleasedOrders || []).filter(d => d.dateStr && d.dateStr.indexOf(M) === 0);
    const unAll = {}, un20 = {};
    unrel.forEach(d => {
      const rdc = (typeof normalizeRdcName === 'function') ? normalizeRdcName(d.warehouse) : d.warehouse;
      const q = d.orderQty || 0, day = Number(String(d.dateStr).slice(8, 10));
      unAll[rdc] = (unAll[rdc] || 0) + q;
      if (day >= 1 && day <= DAY) un20[rdc] = (un20[rdc] || 0) + q;
    });
    // 图2 曲线终值（页面 ECharts 实例里直接读，最权威）
    let series = null;
    try {
      const dom = document.getElementById('pm-rdc-trend');
      const ec = window.echarts && window.echarts.getInstanceByDom(dom);
      if (ec) series = ec.getOption().series.map(s => ({ name: s.name, points: (s.data || []).length, last: (s.data || []).slice(-1)[0] }));
    } catch (e) { series = 'ERR:' + e.message; }
    // 图1 对比卡文本
    const cardTxt = (function () {
      const el = document.querySelector('.page.active');
      if (!el) return '';
      const t = el.innerText || '';
      const i = t.indexOf('时间进度 vs 订单进度');
      return i >= 0 ? t.slice(i, i + 320).replace(/\n+/g, ' | ') : '(未找到对比卡)';
    })();
    const kpiOverall = (function () {
      const el = document.querySelector('.page.active .kpi-card');
      return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
    })();
    return { planR, shipR, odAll, od20, unrelN: unrel.length, unAll, un20, series, cardTxt, kpiOverall,
             dsStat: (function () { const s = window._planMonitorDsStat || null; return s ? { rows: s.rows, qty: Math.round(s.qty), byRdc: s.byRdc } : null; })(),
             odRows: od.length, odAllRows: (dataStore.orderDetail || []).length,
             directShipN: (dataStore.directShip || []).length,
             dayOfMonth: (typeof window._planMonthIdx !== 'undefined') ? 'planIdx=' + window._planMonthIdx : '?' };
  });

  console.log('=== 订单明细行数(9月/全部):', out.odRows, '/', out.odAllRows, '| 未放行(9月):', out.unrelN, '| 大仓直发行:', out.directShipN);
  console.log('\n=== 图1 对比卡原文 ===\n' + out.cardTxt);
  console.log('\n=== KPI 卡0 ===\n' + out.kpiOverall);
  console.log('\n=== 图2 ECharts 各线终值 ===');
  if (Array.isArray(out.series)) out.series.forEach(s => console.log('  ' + s.name + ' 点数=' + s.points + ' 终值=' + s.last));
  else console.log('  ' + JSON.stringify(out.series));

  const RDC6 = ['东北RDC', '华北RDC', '华南RDC', '华中RDC', '西北RDC', '西南RDC'];
  const DS = (out.dsStat && out.dsStat.byRdc) || {};
  console.log('\n=== 大仓直发并入统计（页面 _planMonitorDsStat）===');
  console.log('  行数=' + (out.dsStat ? out.dsStat.rows : '-') + ' 折算支数合计=' + (out.dsStat ? out.dsStat.qty.toLocaleString() : '-'));
  RDC6.forEach(r => console.log('   ' + r + ': ' + Math.round(DS[r] || 0).toLocaleString()));
  // 图2 终值反推分子：终值% × 计划
  const serMap = {};
  if (Array.isArray(out.series)) out.series.forEach(s => { serMap[s.name] = s.last; });
  console.log('\n=== 逐仓对账（M=2026-09，截止 20 日）===');
  console.log('%s %11s %11s %7s %11s %7s %9s %9s %7s %11s' ,
    'RDC', '计划', '实际出货', '出/计', '订单MTD', '单/计', '未放行MTD', '大仓直发', '合/计', '图2终值%');
  const T = { p: 0, s: 0, o: 0, u: 0, d: 0 };
  RDC6.forEach(r => {
    const p = out.planR[r] || 0, s = out.shipR[r] || 0, o = out.od20[r] || 0, u = out.un20[r] || 0, dv = DS[r] || 0;
    T.p += p; T.s += s; T.o += o; T.u += u; T.d += dv;
    console.log('%s %11s %11s %7s %11s %7s %9s %9s %7s %11s',
      r.padEnd(6), Math.round(p).toLocaleString(), Math.round(s).toLocaleString(),
      (p ? (s / p * 100).toFixed(1) + '%' : '-'),
      Math.round(o).toLocaleString(), (p ? (o / p * 100).toFixed(1) + '%' : '-'),
      Math.round(u).toLocaleString(), Math.round(dv).toLocaleString(),
      (p ? ((o + u + dv) / p * 100).toFixed(1) + '%' : '-'),
      (serMap[r] != null ? serMap[r].toFixed(1) + '%' : '-'));
  });
  console.log('%s %11s %11s %7s %11s %7s %9s %9s %7s',
    '合计'.padEnd(6), Math.round(T.p).toLocaleString(), Math.round(T.s).toLocaleString(), (T.s / T.p * 100).toFixed(1) + '%',
    Math.round(T.o).toLocaleString(), (T.o / T.p * 100).toFixed(1) + '%',
    Math.round(T.u).toLocaleString(), Math.round(T.d).toLocaleString(), ((T.o + T.u + T.d) / T.p * 100).toFixed(1) + '%');
  console.log('\n运行时错误:', errs.length ? errs.slice(0, 5) : 0);
  await browser.close();
  srv.close();
})();
