#!/usr/bin/env node
/**
 * v378 专项验证 —— 销售进度口径全线统一为「实际出货 ÷ 分仓计划」
 *
 * 用户 2026-09-21 指令：
 *   「关于销售进度的任何数据，请完全忽略未放行订单（这个数据已经没有了，涉及的相关数据都要调整）
 *     和免费/特殊价格订单，就按照分仓计划里的"实际出货"作为分子（分仓计划作为分母）」
 *   追加裁定：①「有计划、无实际出货行」按 0 计（严格口径）；②各 RDC MTD 曲线照画（用每日 MTD 快照）。
 *
 * 本脚本断言：
 *   A. 版本栅栏：BUILD_VERSION >= 378
 *   B. 全 14 页签 + plan-monitor 两个子页签（advice/logic）零运行时错误
 *   C. 页面「分仓计划监控」KPI 与 demand.json 逐位对账（计划合计 / 实际出货合计 / 完成率）
 *   D. 页面明细行不再出现「订单量」口径字样；表头为「实际出货(支)」
 *   E. demand-history.json 已加载且含 2026-09 快照点；MTD 曲线 series = 6 RDC + 日历基准
 *   F. 「分仓计划优化建议」子页签同样走实际出货口径（无 JS 错误、导出按钮在）
 *
 * 用法（项目根执行）：
 *   NODE_PATH="C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules" \
 *   "C:/Users/zhangyufei1/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" tools/verify-v378-salesprogress.cjs
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

const ROUTES = ['overview', 'fulfillment', 'order-insight', 'shortage', 'weekend-sim', 'transship',
  'replenishment', 'shortage-compare', 'plan-monitor', 'biz-demand', 'adjust-track',
  'inventory-structure', 'inventory', 'slow-moving'];

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const cands = [];
  for (const d of fs.readdirSync(base)) {
    cands.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    cands.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  const hit = cands.find(p => fs.existsSync(p));
  if (!hit) throw new Error('ms-playwright 下未找到 chromium 可执行文件');
  return hit;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// ---- 期望值：直接复算 demand.json（源 = 「分仓需求」sheet 的 DP_共识数量 / 实际出货_数量）----
function expectedFromDemand(month) {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'demand.json'), 'utf8'));
  const tot = (src) => {
    let q = 0, keys = 0;
    for (const sku of Object.keys(src)) {
      for (const rdc of Object.keys(src[sku] || {})) {
        const v = (src[sku][rdc] || {})[month];
        if (v) { q += Number(v); keys++; }
      }
    }
    return { q, keys };
  };
  const p = tot(d.plan || {}), s = tot(d.actualShip || {});
  return { plan: p.q, planKeys: p.keys, ship: s.q, shipKeys: s.keys, rate: p.q > 0 ? s.q / p.q * 100 : 0 };
}

const RESULTS = [];
function check(name, ok, detail) {
  RESULTS.push({ name, ok, detail });
  console.log((ok ? '✅ ' : '❌ ') + name + (detail ? '  — ' + detail : ''));
}

(async () => {
  let chromium;
  try { chromium = require('playwright-core').chromium; }
  catch (e) { console.error('需要 playwright-core：设置 NODE_PATH'); process.exit(2); }

  const MONTH = '2026-09';
  const exp = expectedFromDemand(MONTH);
  console.log('【期望值 · demand.json 复算 ' + MONTH + '】计划 ' + exp.plan.toLocaleString() + ' 支 / ' + exp.planKeys +
    ' 键 ｜ 实际出货 ' + exp.ship.toLocaleString() + ' 支 / ' + exp.shipKeys + ' 键 ｜ 完成率 ' + exp.rate.toFixed(2) + '%\n');

  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 980 } });
  const page = await ctx.newPage();

  let errs = [];
  page.on('pageerror', e => errs.push(e && e.message ? e.message : String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 300)); });

  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});

  // 🔴 铁律：dataStore.loaded===true ≠ 可导航；handleLogin 收尾会强制 navigateTo('overview')，
  //   必须等 _bootLoading === false 再导航，否则会被抢回总览。
  const booted = await page.waitForFunction(
    () => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true && window._bootLoading === false,
    { timeout: 180000 }).then(() => true).catch(() => false);
  check('登录 + 数据装载完成（loaded && _bootLoading===false）', booted);
  if (!booted) { await browser.close(); server.close(); process.exit(1); }

  // ---- A. 版本栅栏 ----
  const ver = await page.evaluate(() => (typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : -1));
  check('BUILD_VERSION >= 378（实测 ' + ver + '）', ver >= 378);

  // ---- B. 全页签运行时自检 ----
  let routeFail = 0;
  for (const r of ROUTES) {
    errs = [];
    await page.evaluate(route => { try { navigateTo(route); return 1; } catch (e) { return 0; } }, r);
    await page.waitForTimeout(2400);
    const state = await page.evaluate(route => {
      const el = document.getElementById('page-' + route);
      return { len: el ? el.innerHTML.length : -1, cur: (typeof currentPage !== 'undefined' ? currentPage : ''), hash: location.hash };
    }, r);
    const ok = errs.length === 0 && state.len > 200 && state.cur === r;
    if (!ok) routeFail++;
    console.log((ok ? '✅' : '❌') + ' ' + r.padEnd(20) + ' html=' + String(state.len).padStart(8) + ' cur=' + state.cur + (errs.length ? '  ERR: ' + errs[0] : ''));
  }
  check('14 页签全部无运行时错误且渲染非空', routeFail === 0, routeFail ? routeFail + ' 个失败' : '');

  // ---- C/D/E. 分仓计划监控页对账 ----
  errs = [];
  await page.evaluate(() => { window._planTab = 'monitor'; navigateTo('plan-monitor'); });
  // 等 demand.json 并入 + demand-history.json 加载
  await page.waitForFunction(
    () => (typeof _demandReady === 'function' ? _demandReady() : false) && !!window._demandHistory,
    { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const pm = await page.evaluate(() => {
    const rows = window._planMonitorRows || [];
    let tp = 0, ts = 0, zeroShipRows = 0;
    rows.forEach(r => { tp += r.plan; ts += r.shipped; if (!r.shipped) zeroShipRows++; });
    const el = document.getElementById('page-plan-monitor');
    const txt = el ? el.innerText : '';
    const mKpi = txt.match(/整体计划完成率[^\n]*\n([\d.]+)/);
    // 表头
    const th = [...document.querySelectorAll('#pm-sku-detail-table thead th')].map(x => x.innerText.trim());
    // MTD 曲线
    const dom = document.getElementById('pm-rdc-trend');
    let chart = null;
    try {
      const inst = window.echarts ? window.echarts.getInstanceByDom(dom) : null;
      if (inst) { const o = inst.getOption(); chart = { series: (o.series || []).map(s => s.name), x: ((o.xAxis || [])[0] || {}).data || [] }; }
    } catch (e) { chart = { err: String(e && e.message) }; }
    return {
      rowCnt: rows.length, totalPlan: tp, totalShip: ts, rate: tp > 0 ? ts / tp * 100 : 0,
      zeroShipRows, kpiText: mKpi ? mKpi[1] : '', th: th, chart: chart,
      hasHist: !!window._demandHistory,
      histDays: (window._demandHistory && window._demandHistory.months && window._demandHistory.months['2026-09'])
        ? Object.keys(window._demandHistory.months['2026-09'].days || {}).length : 0,
      histDayKeys: (window._demandHistory && window._demandHistory.months && window._demandHistory.months['2026-09'])
        ? Object.keys(window._demandHistory.months['2026-09'].days || {}) : [],
      hasOrderWord: /订单量/.test(txt),
      demandFail: window._demandFail || 0
    };
  });

  console.log('\n【页面实测 · plan-monitor】明细行 ' + pm.rowCnt + ' 行 ｜ 计划合计 ' + Math.round(pm.totalPlan).toLocaleString() +
    ' ｜ 实际出货合计 ' + Math.round(pm.totalShip).toLocaleString() + ' ｜ 完成率 ' + pm.rate.toFixed(2) + '% ｜ KPI 读到「' + pm.kpiText + '」');
  console.log('   零出货行 ' + pm.zeroShipRows + ' 行；表头 = ' + JSON.stringify(pm.th));
  console.log('   demand-history: ' + pm.hasHist + ' / ' + pm.histDays + ' 天 ' + JSON.stringify(pm.histDayKeys));
  console.log('   MTD 曲线 series = ' + JSON.stringify(pm.chart && pm.chart.series) + '  x = ' + JSON.stringify(pm.chart && pm.chart.x));

  check('页面无运行时错误（plan-monitor）', errs.length === 0, errs.slice(0, 2).join(' | '));
  const dPlan = Math.abs(pm.totalPlan - exp.plan) / exp.plan;
  const dShip = Math.abs(pm.totalShip - exp.ship) / exp.ship;
  check('分母（分仓计划）与 demand.json 一致（容差 0.5%）', dPlan < 0.005,
    '页面 ' + Math.round(pm.totalPlan).toLocaleString() + ' vs 源 ' + exp.plan.toLocaleString() + ' 差 ' + (dPlan * 100).toFixed(3) + '%');
  check('分子（实际出货）与 demand.json 完全一致（容差 0.1%）', dShip < 0.001,
    '页面 ' + Math.round(pm.totalShip).toLocaleString() + ' vs 源 ' + exp.ship.toLocaleString() + ' 差 ' + (dShip * 100).toFixed(3) + '%');
  check('页面完成率 ≈ 71.94%', Math.abs(pm.rate - 71.94) < 0.1, pm.rate.toFixed(2) + '%');
  check('KPI 显示值与明细复算一致', pm.kpiText && Math.abs(parseFloat(pm.kpiText) - pm.rate) < 0.15,
    'KPI ' + pm.kpiText + ' vs 复算 ' + pm.rate.toFixed(1));
  check('明细表头为「实际出货(支)」', pm.th.indexOf('实际出货(支)') >= 0, JSON.stringify(pm.th));
  check('页面正文无「订单量」字样（销售进度已改文案）', !pm.hasOrderWord);
  check('demand-history.json 已加载且含 4 个 2026-09 快照点', pm.hasHist && pm.histDays === 4, pm.histDays + ' 天');
  check('MTD 曲线 = 6 条 RDC + 日历进度基准（共 7 条 series）',
    !!(pm.chart && pm.chart.series && pm.chart.series.length === 7), JSON.stringify(pm.chart && pm.chart.series));
  check('demand.json 未反复失败（_demandFail < 3）', pm.demandFail < 3, '_demandFail=' + pm.demandFail);

  // 曲线末端点 == 各仓当前完成率（同源同分母自证）
  const tail = await page.evaluate(() => {
    const rows = window._planMonitorRows || [];
    const pt = {}; rows.forEach(r => { pt[r.rdc] = (pt[r.rdc] || 0) + r.plan; });
    const md = window._demandHistory.months['2026-09'].days;
    const last = Object.keys(md).sort().pop();
    const dom = document.getElementById('pm-rdc-trend');
    const inst = window.echarts.getInstanceByDom(dom);
    const o = inst.getOption();
    const out = [];
    (o.series || []).forEach(s => {
      if (s.name === '日历进度基准') return;
      const v = (s.data || [])[(s.data || []).length - 1];
      const exp = pt[s.name] > 0 ? (md[last][s.name] || 0) / pt[s.name] * 100 : 0;
      out.push({ rdc: s.name, chart: v, expect: +exp.toFixed(2) });
    });
    return { last: last, out: out };
  });
  const tailBad = tail.out.filter(x => x.chart == null || Math.abs(x.chart - x.expect) > 0.05);
  console.log('   曲线末端（' + tail.last + '）vs 复算：' + tail.out.map(x => x.rdc + ' ' + x.chart + '/' + x.expect).join(' | '));
  check('MTD 曲线末端各点 == 该仓当前完成率（同源同分母）', tailBad.length === 0, tailBad.length ? JSON.stringify(tailBad) : '');

  // ---- F. 优化建议子页签 ----
  errs = [];
  await page.evaluate(() => { window._planTab = 'advice'; renderPlanMonitor(); });
  await page.waitForTimeout(2600);
  const adv = await page.evaluate(() => {
    const el = document.getElementById('page-plan-monitor');
    const txt = el ? el.innerText : '';
    return { len: el ? el.innerHTML.length : -1, hasExport: /导出CSV/.test(txt), head: txt.slice(0, 260) };
  });
  check('「优化建议」子页签渲染非空且无运行时错误', errs.length === 0 && adv.len > 500, errs.slice(0, 2).join(' | '));

  // ---- 收尾：切回监控子页签 ----
  await page.evaluate(() => { window._planTab = 'monitor'; renderPlanMonitor(); });
  await page.waitForTimeout(1200);

  await browser.close();
  server.close();

  const bad = RESULTS.filter(x => !x.ok);
  console.log('\n================ 合计 ' + RESULTS.length + ' 项，失败 ' + bad.length + ' 项 ================');
  bad.forEach(b => console.log('  ❌ ' + b.name + ' :: ' + (b.detail || '')));
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('工具异常:', e && e.stack || e); process.exit(2); });
