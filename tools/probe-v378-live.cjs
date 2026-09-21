#!/usr/bin/env node
/**
 * v378 线上复核：直接打 https://rdc-dashboard.pages.dev/rdc-dashboard.html
 * 用途：部署后确认「线上跑的就是本地这套口径」（默认 CDN 缓存会先返回旧版，故带 ?t= 破缓存）。
 * 检查项：BUILD_VERSION=378 / plan-monitor KPI 与明细复算一致 / demand-history 4 点 / MTD 曲线 7 条 / 零运行时错误。
 */
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.RDC_BASE || 'https://rdc-dashboard.pages.dev';
function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  for (const d of fs.readdirSync(base)) for (const c of [['chrome-headless-shell-win64', 'chrome-headless-shell.exe'], ['chrome-win64', 'chrome.exe']]) {
    const p = path.join(base, d, c[0], c[1]); if (fs.existsSync(p)) return p;
  }
  throw new Error('no chromium');
}
(async () => {
  const chromium = require('playwright-core').chromium;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1560, height: 1000 } })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });

  const url = BASE + '/rdc-dashboard.html?t=' + Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin'); await page.fill('#login-pass', 'admin123');
  await page.click('#login-page button');
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true && window._bootLoading === false, { timeout: 180000 });
  await page.evaluate(() => { window._planTab = 'monitor'; navigateTo('plan-monitor'); });
  await page.waitForFunction(() => (typeof _demandReady === 'function' ? _demandReady() : false) && !!window._demandHistory, { timeout: 120000 });
  await page.waitForTimeout(2500);

  const r = await page.evaluate(() => {
    const rows = window._planMonitorRows || [];
    let tp = 0, ts = 0; rows.forEach(x => { tp += x.plan; ts += x.shipped; });
    const hd = (window._demandHistory && window._demandHistory.months['2026-09'] || {}).days || {};
    const dom = document.getElementById('pm-rdc-trend');
    const inst = window.echarts.getInstanceByDom(dom);
    const o = inst ? inst.getOption() : null;
    return {
      ver: typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : -1,
      title: document.title,
      rows: rows.length, plan: tp, ship: ts, rate: tp ? ts / tp * 100 : 0,
      days: Object.keys(hd).sort(),
      series: o ? o.series.map(s => s.name) : null,
      txt: (document.getElementById('page-plan-monitor') || {}).innerText || ''
    };
  });
  console.log('线上 ' + BASE);
  console.log('  BUILD_VERSION = ' + r.ver + ' ｜ title = ' + r.title);
  console.log('  明细 ' + r.rows + ' 行 ｜ 计划 ' + Math.round(r.plan).toLocaleString() + ' 支 ｜ 实际出货 ' + Math.round(r.ship).toLocaleString() + ' 支 ｜ 完成率 ' + r.rate.toFixed(2) + '%');
  console.log('  demand-history 快照日 = ' + JSON.stringify(r.days));
  console.log('  MTD 曲线 series = ' + JSON.stringify(r.series));
  console.log('  正文含「订单量」= ' + /订单量/.test(r.txt) + ' ｜ 含「实际出货进度」= ' + /实际出货进度/.test(r.txt));
  console.log('  运行时错误 ' + errs.length + ' 个' + (errs.length ? ' :: ' + errs.slice(0, 3).join(' | ') : ''));
  const ok = r.ver >= 378 && Math.abs(r.rate - 71.94) < 0.15 && r.days.length === 4 && r.series && r.series.length === 7 && errs.length === 0;
  console.log(ok ? '\n✅ 线上复核通过' : '\n❌ 线上复核未通过');
  const cache = path.join(ROOT, '.cache');
  if (!fs.existsSync(cache)) fs.mkdirSync(cache, { recursive: true });
  await page.screenshot({ path: path.join(cache, 'v378_live_kpi.png') });
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('异常:', e && e.message); process.exit(2); });
