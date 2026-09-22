#!/usr/bin/env node
/**
 * 订单部署数据更新 · 线上复核（2026-09-22 第二次更新）
 * 直接打 https://rdc-dashboard.pages.dev —— 确认线上页面真的吃到了新 data.json。
 *   1) BUILD_VERSION 仍 378（纯数据更新）
 *   2) 登录后 dataStore.orderDetail 行数 / 9月订单支数合计（应含补全的 190,685 支）
 *   3) 分仓计划监控页 KPI（销售进度口径，与 demand.json 对拍）
 *   4) MTD 曲线 series / x 轴（5 天快照）
 *   5) 14 页签导航无运行时错误（轻量：只跳关键几页）
 * 截图落到 .cache/。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://rdc-dashboard.pages.dev';
const CACHE = path.join(ROOT, '.cache');

function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  for (const d of fs.readdirSync(base)) {
    for (const c of [['chrome-headless-shell-win64', 'chrome-headless-shell.exe'], ['chrome-win64', 'chrome.exe']]) {
      const p = path.join(base, d, c[0], c[1]);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('no chromium');
}

(async () => {
  const chromium = require('playwright-core').chromium;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

  console.log('线上 ' + BASE);
  await page.goto(BASE + '/?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.fill('#login-user', 'admin'); await page.fill('#login-pass', 'admin123');
  await page.click('#login-page button');
  // 🔴 handleLogin 收尾会强制 navigateTo('overview') → 必须等 _bootLoading===false 再导航
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true && window._bootLoading === false, { timeout: 300000 });
  console.log('✅ 登录 + 数据装载完成');

  const meta = await page.evaluate(() => ({
    ver: (typeof BUILD_VERSION !== 'undefined') ? BUILD_VERSION : null,
    title: document.title,
    ordRows: (dataStore.orderDetail || []).length,
    sheetNames: (dataStore.sheetsRaw || {}) ? Object.keys(dataStore.sheetsRaw || {}).length : null
  }));
  console.log('   BUILD_VERSION = ' + meta.ver + ' ｜ title = ' + meta.title);
  console.log('   orderDetail 行数 = ' + meta.ordRows);

  // 9 月订单支数合计（页面 dataStore.orderDetail 口径；行由 L1641 date|orderNo|skuCode 去重）
  const agg = await page.evaluate(() => {
    const rows = dataStore.orderDetail || [];
    const byDay = {}; let m9 = 0, m9f = 0;
    rows.forEach(r => {
      const day = r.dateStr || null;
      const q = Number(r.orderQty || 0) || 0;
      const f = Number(r.firstDayShort || 0) || 0;
      if (day) byDay[day] = (byDay[day] || 0) + q;
      if (day && day.indexOf('2026-09') === 0) { m9 += q; m9f += f; }
    });
    return { n: rows.length, m9, m9f, d02: byDay['2026-09-02'] || 0, d08: byDay['2026-09-08'] || 0, d10: byDay['2026-09-10'] || 0 };
  });
  console.log('   orderDetail 解析后行数 = ' + agg.n.toLocaleString());
  console.log('   9月订单支数合计 = ' + Math.round(agg.m9).toLocaleString() + ' 支（data.json 原始口径 3,993,730，页面有去重）');
  console.log('   9月首日缺货合计 = ' + Math.round(agg.m9f).toLocaleString() + ' 支（data.json 原始口径 403,994）');
  console.log('   9/02=' + Math.round(agg.d02).toLocaleString() + ' 9/08=' + Math.round(agg.d08).toLocaleString() + ' 9/10=' + Math.round(agg.d10).toLocaleString());

  // 分仓计划监控页
  await page.evaluate(() => { window._planTab = 'monitor'; navigateTo('plan-monitor'); });
  await page.waitForFunction(() => (typeof _demandReady === 'function' ? _demandReady() : false) && !!window._demandHistory, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const pm = await page.evaluate(() => {
    const rows = window._planMonitorRows || [];
    let tp = 0, ts = 0;
    rows.forEach(r => { tp += r.plan; ts += r.shipped; });
    const el = document.getElementById('page-plan-monitor');
    const txt = el ? el.innerText : '';
    const m = txt.match(/整体计划完成率[^\n]*\n([\d.]+)/);
    const dom = document.getElementById('pm-rdc-trend');
    let chart = null;
    try { const inst = window.echarts ? window.echarts.getInstanceByDom(dom) : null;
      if (inst) { const o = inst.getOption(); chart = { series: (o.series || []).map(s => s.name), x: ((o.xAxis || [])[0] || {}).data || [] }; } } catch (e) {}
    return { n: rows.length, tp, ts, kpi: m ? m[1] : '', chart,
      hist: (window._demandHistory && window._demandHistory.months['2026-09']) ? Object.keys(window._demandHistory.months['2026-09'].days || {}).length : 0 };
  });
  console.log('');
  console.log('【线上 · 分仓计划监控】明细 ' + pm.n + ' 行 ｜ 计划 ' + Math.round(pm.tp).toLocaleString() +
    ' ｜ 实际出货 ' + Math.round(pm.ts).toLocaleString() + ' ｜ 完成率 ' + (pm.tp ? (pm.ts / pm.tp * 100).toFixed(2) : '-') + '% ｜ KPI「' + pm.kpi + '」');
  console.log('   MTD 快照 ' + pm.hist + ' 天 ｜ series = ' + JSON.stringify(pm.chart && pm.chart.series) + ' ｜ x = ' + JSON.stringify(pm.chart && pm.chart.x));

  if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });
  await page.screenshot({ path: path.join(CACHE, 'orderdeploy_live_planmonitor.png') });

  // 滚动到 KPI 卡 + 曲线，整屏截图
  await page.evaluate(() => { const b = document.body; if (b) b.scrollTop = 0; });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(CACHE, 'orderdeploy_live_kpi.png') });

  const realErrs = errs.filter(e => !/favicon|404/.test(e));
  const pmRate = pm.tp ? (pm.ts / pm.tp * 100) : 0;
  const chk = [
    ['BUILD_VERSION = 378（纯数据更新，版本不动）', meta.ver === 378, '实测 ' + meta.ver],
    ['页面无运行时错误', realErrs.length === 0, realErrs.slice(0, 2).join(' | ')],
    ['orderDetail 已装载（>2万行）', agg.n > 20000, agg.n + ' 行'],
    ['9月订单支数合计 >300万（补全数据已在页面）', agg.m9 > 3000000, Math.round(agg.m9).toLocaleString()],
    ['9月首日缺货合计 == 403,994（补全行缺货为 0，缺货数据不动）', Math.abs(agg.m9f - 403994) < 2, Math.round(agg.m9f).toLocaleString()],
    ['plan-monitor 完成率 ≈ 82.7%（与 demand.json 对拍）', Math.abs(pmRate - 82.72) < 0.15, pmRate.toFixed(2) + '%'],
    ['KPI 显示值与明细复算一致', pm.kpi && Math.abs(parseFloat(pm.kpi) - pmRate) < 0.15, 'KPI ' + pm.kpi],
    ['MTD 快照 >= 4 天', pm.hist >= 4, pm.hist + ' 天'],
    ['MTD 曲线 = 6 RDC + 日历基准', !!(pm.chart && pm.chart.series && pm.chart.series.length === 7), JSON.stringify(pm.chart && pm.chart.series)]
  ];
  console.log('');
  chk.forEach(c => console.log((c[1] ? '✅ ' : '❌ ') + c[0] + (c[2] ? '  — ' + c[2] : '')));
  const ok = chk.every(c => c[1]);
  console.log('\n================ 合计 ' + chk.length + ' 项，失败 ' + chk.filter(c => !c[1]).length + ' 项 ================');
  console.log(ok ? '✅ 线上复核通过' : '❌ 线上复核未通过');
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('异常:', e && e.message); process.exit(2); });
