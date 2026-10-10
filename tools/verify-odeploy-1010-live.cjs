// 线上核验（2026-10-10 订单部署）：打 pages.dev 确认当月已切 10 月、9 月归档生效
// 用法：NODE_PATH=<...> node tools/verify-odeploy-1010-live.cjs
const path = require('path');
const fs = require('fs');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const BASE = 'https://rdc-dashboard.pages.dev';
const SHOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40/.cache';

const R = [];
function ck(n, ok, d) { R.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) }); }

(async () => {
  const exe = (() => {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    const c = [];
    for (const d of fs.readdirSync(base)) {
      c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
      c.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
    }
    return c.find(p => fs.existsSync(p));
  })();
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });   // 全新上下文 = 新用户首次访问
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console.error: ' + m.text()); });

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 300000 }).catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 180000 }).catch(() => {});
  await page.evaluate(async () => { if (typeof ensureDemandMerged === 'function') await ensureDemandMerged(); });
  await page.waitForTimeout(2500);

  const st = await page.evaluate(() => {
    const c = {};
    (dataStore.orderDetail || []).forEach(r => { const m = String(r.dateStr || '').slice(0, 7); if (m) c[m] = (c[m] || 0) + 1; });
    const ds = (dataStore.shortage || []).map(r => String(r.dateStr || '')).filter(Boolean).sort();
    return { total: (dataStore.orderDetail || []).length, months: c, latestShort: ds[ds.length - 1],
             build: (typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : null) };
  });
  const ms = Object.keys(st.months).sort();
  ck('线上 BUILD_VERSION = 393', st.build === 393, st.build);
  ck('线上月份数 = 10（01~10）', ms.length === 10, ms.join(','));
  ck('线上含 2026-09 = 25328（归档生效）', st.months['2026-09'] === 25328, st.months['2026-09']);
  ck('线上含 2026-10 = 2458（当月已切）', st.months['2026-10'] === 2458, st.months['2026-10']);
  ck('线上缺货最新日期 = 2026-10-09', st.latestShort === '2026-10-09', st.latestShort);

  // 截图总览 + 分仓监控
  for (const [route, fn] of [['overview', 'live1010_overview'], ['plan-monitor', 'live1010_planmonitor'], ['shortage', 'live1010_shortage']]) {
    await page.evaluate(r => { if (typeof navigateTo === 'function') navigateTo(r); }, route);
    await page.waitForTimeout(3000);
    fs.mkdirSync(SHOT, { recursive: true });
    await page.screenshot({ path: path.join(SHOT, fn + '.png'), fullPage: false });
  }
  ck('无 JS 运行时错误', errs.length === 0, errs.slice(0, 3).join(' ; '));

  await browser.close();
  const pass = R.filter(x => x.ok).length;
  console.log('=== 线上核验（2026-10-10 订单部署 · pages.dev）===');
  R.forEach(x => console.log(`${x.ok ? '✅' : '🔴'} ${x.n}  ${x.d ? '→ ' + x.d : ''}`));
  console.log(`\n合计 ${R.length} 项，通过 ${pass}，失败 ${R.length - pass}`);
  console.log('线上月份分布: ' + JSON.stringify(st.months));
  process.exit(pass === R.length ? 0 : 1);
})();
