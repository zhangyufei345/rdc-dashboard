// v374 线上门控：直接打 https://rdc-dashboard.pages.dev，验证真实线上页面
//   L1 线上 BUILD_VERSION = 374
//   L2 进入「分仓计划优化建议」页，等实际出货就绪 → 页面出现 81014·东北 89820 / 59.3% 且无回退值警示条
//   L3 点导出（走 exportPlanAdvice）→ CSV 里 81014·东北RDC = 89820 / 59.3%
//   L4 无运行时错误（过滤资源 404 噪声）
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const LIVE = 'https://rdc-dashboard.pages.dev/';
const results = [];
const T = (n, ok, d) => { results.push({ n, ok }); console.log((ok ? '✅' : '❌') + ' ' + n + (d ? '  — ' + d : '')); };

(async () => {
  const exe = (() => { const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'); const c = []; for (const d of fs.readdirSync(base)) { c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(base, d, 'chrome-win64', 'chrome.exe')); } return c.find(p => fs.existsSync(p)); })();
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  const noise = t => /Failed to load resource/i.test(t) || /\b404\b/.test(t) || /net::ERR_/.test(t);
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !noise(m.text())) errs.push('console.error: ' + m.text()); });

  console.log('--- 打开线上页面 ---');
  await page.goto(LIVE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 240000 });
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 180000 });

  const BV = await page.evaluate(() => BUILD_VERSION);
  T('L1 线上 BUILD_VERSION = 374', BV === 374, 'BUILD_VERSION=' + BV);

  // 等实际出货就绪
  await page.waitForFunction(() => (typeof _demandReady === 'function') && _demandReady() === true, { timeout: 90000 }).catch(() => {});
  const rd = await page.evaluate(() => (typeof _demandReady === 'function') ? _demandReady() : 'NOFN');
  T('L2a 线上 _demandReady() === true（实际出货已并入）', rd === true, '值=' + rd);

  // 进优化建议页
  await page.evaluate(() => { window._planTab = 'advice'; if (typeof navigateTo === 'function') navigateTo('plan-monitor'); });
  await page.waitForTimeout(4000);
  const pgv = await page.evaluate(() => {
    const pg = document.getElementById('page-plan-monitor');
    const txt = pg ? pg.innerText : '';
    const m = txt.match(/81014[\s\S]{0,220}/);
    return { cur: currentPage, warn: txt.indexOf('订单口径回退值') >= 0, has: txt.indexOf('81014') >= 0, snip: m ? m[0].replace(/\s+/g, ' ').slice(0, 200) : '' };
  });
  T('L2b 优化建议页就绪且无「回退值」警示条', pgv.cur === 'plan-monitor' && pgv.warn === false, JSON.stringify({ cur: pgv.cur, warn: pgv.warn }));
  console.log('      页面 81014 片段: ' + pgv.snip);

  // 导出
  const csv = await page.evaluate(() => {
    let cap = null; const orig = window.downloadFile;
    window.downloadFile = (n, c) => { cap = c; };
    return Promise.resolve().then(() => exportPlanAdvice())
      .then(() => { window.downloadFile = orig; return cap; }, e => { window.downloadFile = orig; return 'ERR:' + e.message; });
  });
  if (typeof csv !== 'string' || csv.startsWith('ERR:')) {
    T('L3 线上导出 81014·东北RDC = 89820 / 59.3%', false, String(csv));
  } else {
    const L = csv.split('\n').filter(l => l.startsWith('81014,'));
    const ne = L.filter(l => l.indexOf(',东北RDC,') >= 0)[0] || '';
    const c = ne.split(',');
    T('L3 线上导出 81014·东北RDC = 89820 / 59.3%',
      c[7] === '89820' && c[8] === '59.3',
      '计划=' + c[6] + ' 订单=' + c[7] + ' 完成率=' + c[8] + '  81014行数=' + L.length + '  总行数=' + (csv.split('\n').length - 1));
  }

  T('L4 无运行时错误', errs.length === 0, errs.length ? errs.slice(0, 4).join(' | ') : '0 条');
  console.log('\n===== 汇总 =====');
  const bad = results.filter(r => !r.ok);
  console.log(bad.length ? `❌ ${bad.length}/${results.length} 项失败` : `✅ ${results.length}/${results.length} 项全部通过`);
  await browser.close(); process.exit(bad.length ? 1 : 0);
})();
