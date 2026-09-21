#!/usr/bin/env node
/**
 * 线上复核：「更新RDC补货调整记录」（2026-09-21，纯数据更新）
 * 直接打 https://rdc-dashboard.pages.dev（带 ?t= 破 CDN 缓存），确认线上跑的就是新数据。
 * 检查：BUILD_VERSION 仍 378（数据更新不 bump）/ adjustRecords=1658 / KPI 1658 条 /
 *       类型下拉含「超销预警」/ 归因表 7 行 / 零运行时错误 + 截图留证。
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

  await page.goto(BASE + '/rdc-dashboard.html?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin'); await page.fill('#login-pass', 'admin123');
  await page.click('#login-page button');
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true && window._bootLoading === false, { timeout: 180000 });
  // 🔴 铁律：dataStore.loaded===true ≠ 可导航；必须等 _bootLoading===false 再 navigateTo，
  //   否则 handleLogin 收尾会把我抢回总览（用 hash 跳转更危险：title 变了但可见页还是总览）。
  await page.evaluate(() => { navigateTo('adjust-track'); });
  await page.waitForTimeout(600);
  // 等 adjustments.json 异步补拉完成（handleLogin 内）
  await page.waitForFunction(() => (dataStore.adjustRecords || []).length > 0, { timeout: 120000 }).catch(() => {});
  await page.evaluate(() => { if (typeof renderAdjustTrack === 'function') renderAdjustTrack(); });
  await page.waitForTimeout(1500);
  // 三口径判定：currentPage + hash + .page.active
  // 🔴 currentPage 是顶层 let，不挂 window → 必须**裸写变量名**才读得到（window.currentPage 恒 undefined）
  const nav = await page.evaluate(() => ({
    currentPage: (typeof currentPage !== 'undefined' ? currentPage : null),
    hash: location.hash,
    active: (document.querySelector('.page.active') || {}).id
  }));

  const r = await page.evaluate(() => {
    const out = { kpi: {}, select: null, rows: 0, computedLen: null, loaded: null };
    out.loaded = (dataStore.adjustRecords || []).length;
    out.computedLen = (typeof buildAdjComputed === 'function') ? buildAdjComputed().list.length : null;
    document.querySelectorAll('.kpi-card').forEach(c => {
      const l = c.querySelector('.kpi-label'), v = c.querySelector('.kpi-value');
      if (l) out.kpi[l.textContent.trim()] = v ? v.textContent.trim() : '';
    });
    document.querySelectorAll('select').forEach(s => {
      const opts = [...s.options].map(o => o.textContent.trim());
      if (opts.indexOf('全部调整类型') >= 0) out.select = opts;
    });
    const tbl = [...document.querySelectorAll('table')].find(t => t.textContent.indexOf('调整类型') >= 0 && t.textContent.indexOf('B象限') >= 0);
    if (tbl) out.rows = tbl.querySelectorAll('tbody tr').length;
    return { ...out, ver: typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : -1, title: document.title };
  });

  console.log('线上 ' + BASE);
  console.log('  导航三口径 = ' + JSON.stringify(nav));
  console.log('  BUILD_VERSION = ' + r.ver + ' ｜ title = ' + r.title);
  console.log('  adjustRecords = ' + r.loaded + ' 条 ｜ buildAdjComputed = ' + r.computedLen + ' 条');
  console.log('  KPI = ' + JSON.stringify(r.kpi));
  console.log('  类型下拉 = ' + JSON.stringify(r.select));
  console.log('  归因表行数 = ' + r.rows);
  console.log('  运行时错误 ' + errs.length + ' 个' + (errs.length ? ' :: ' + errs.slice(0, 3).join(' | ') : ''));

  const ok = r.ver === 378 && r.loaded === 1658 && r.kpi['调整记录'] === '1658条' &&
    r.select && r.select.indexOf('超销预警') >= 0 && r.rows === 7 && errs.length === 0 &&
    nav.active === 'page-adjust-track' && nav.currentPage === 'adjust-track';
  console.log(ok ? '\n✅ 线上复核通过' : '\n❌ 线上复核未通过');

  const cache = path.join(ROOT, '.cache');
  if (!fs.existsSync(cache)) fs.mkdirSync(cache, { recursive: true });
  await page.screenshot({ path: path.join(cache, 'adjupdate_live_full.png') });
  // 滚动到「按调整类型归因」表截图（canvas/DOM 元素截图在 headless-shell 下不可靠 → 最近可滚动祖先 + 整屏截图）
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('#page-adjust-track .card-header')].find(h => h.textContent.indexOf('按调整类型归因') >= 0);
    if (!el) return;
    let sc = null, p = el.parentElement;
    while (p) { if (p.scrollHeight > p.clientHeight + 50) { sc = p; break; } p = p.parentElement; }
    const box = el.getBoundingClientRect();
    if (sc && sc.scrollTop !== undefined) sc.scrollTop += box.top - 60;
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(cache, 'adjupdate_live_table.png') });
  console.log('截图: .cache/adjupdate_live_full.png , .cache/adjupdate_live_table.png');
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('异常:', e && e.message); process.exit(2); });
