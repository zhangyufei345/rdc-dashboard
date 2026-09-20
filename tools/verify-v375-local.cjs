// v375 本地门控：本地静态服务器 + 冷启动直进 advice 页（与线上同逻辑，验证 v375 修复）
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript' };
const serve = () => new Promise(res => { const s = http.createServer((rq, rs) => { let p = decodeURIComponent(rq.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); rs.end('nf'); return; } rs.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' }); fs.createReadStream(f).pipe(rs); }); s.listen(0, '127.0.0.1', () => res(s)); });

const results = [];
const T = (n, ok, d) => { results.push({ n, ok }); console.log((ok ? '✅' : '❌') + ' ' + n + (d ? '  — ' + d : '')); };

(async () => {
  const srv = await serve(); const port = srv.address().port;
  const exe = (() => { const b = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'); const c = []; for (const d of fs.readdirSync(b)) { c.push(path.join(b, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(b, d, 'chrome-win64', 'chrome.exe')); } return c.find(p => fs.existsSync(p)); })();
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [], mergeLogs = [];
  const noise = t => /Failed to load resource/i.test(t) || /\b404\b/.test(t) || /net::ERR_/.test(t);
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { const t = m.text(); if (/ensureDemandMerged/.test(t)) mergeLogs.push(t.slice(0, 140)); if (m.type() === 'error' && !noise(t)) errs.push('console.error: ' + t); });

  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 });
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 120000 });

  const bv = await page.evaluate(() => BUILD_VERSION);
  T('版本号 = 375', bv === 375, 'BUILD_VERSION=' + bv);

  const a = await page.evaluate(() => ({ cur: currentPage, ready: _demandReady(), shipSkus: Object.keys((dataStore.inventory && dataStore.inventory.actualShipBySkuRdc) || {}).length }));
  console.log('   冷启动: cur=' + a.cur + ' ready=' + a.ready + ' shipSkus=' + a.shipSkus);

  // 关键：人为打回「未就绪」再进 advice 页，验证**本页自身**会触发并入
  await page.evaluate(() => { _demandMerged = false; window._demandMerging = false; window._demandFail = 0; dataStore.inventory.actualShipBySkuRdc = {}; window._invPlanReady = true; });
  mergeLogs.length = 0;
  await page.evaluate(() => { window._planTab = 'advice'; navigateTo('plan-monitor'); });
  let ready = false, waited = 0;
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(1000); waited += 1000; ready = await page.evaluate(() => _demandReady()); if (ready) break; }
  T('B/C 进 advice 页后本页自身触发并入并最终就绪', ready === true, '耗时 ' + waited + 'ms，merge 日志 ' + mergeLogs.length + ' 条');
  mergeLogs.slice(0, 3).forEach(l => console.log('      ' + l));

  await page.waitForTimeout(3500);
  const d = await page.evaluate(() => {
    const pg = document.getElementById('page-plan-monitor');
    const txt = pg ? pg.innerText : '';
    const rows = [];
    pg.querySelectorAll('tr').forEach(tr => { const t = (tr.innerText || '').replace(/\s+/g, ' '); if (t.indexOf('81014') >= 0 && t.indexOf('东北') >= 0) rows.push(t); });
    return { banner: txt.indexOf('订单口径回退值') >= 0, rows, has89820: txt.indexOf('89820') >= 0, has38220: txt.indexOf('38220') >= 0 };
  });
  T('D 页面 81014·东北RDC = 89820（非 38220）', d.has89820 === true && d.has38220 === false, '含89820=' + d.has89820 + ' 含38220=' + d.has38220);
  d.rows.slice(0, 2).forEach(r => console.log('      ' + r.slice(0, 190)));
  T('F 就绪后无「回退值」警示条', d.banner === false, 'banner=' + d.banner);

  const csv = await page.evaluate(() => {
    let cap = null; const orig = window.downloadFile;
    window.downloadFile = (n, c) => { cap = c; };
    return Promise.resolve().then(() => exportPlanAdvice()).then(() => { window.downloadFile = orig; return cap; }, e => { window.downloadFile = orig; return 'ERR:' + e.message; });
  });
  if (typeof csv !== 'string' || csv.startsWith('ERR:')) T('E 导出 81014·东北RDC = 89820 / 59.3%', false, String(csv));
  else {
    const L = csv.split('\n').filter(l => l.startsWith('81014,'));
    const ne = L.filter(l => l.indexOf(',东北RDC,') >= 0)[0] || '';
    const c = ne.split(',');
    T('E 导出 81014·东北RDC = 89820 / 59.3%', c[7] === '89820' && c[8] === '59.3', '计划=' + c[6] + ' 订单=' + c[7] + ' 完成率=' + c[8]);
  }

  const f2 = await page.evaluate(() => {
    const bak = dataStore.inventory.actualShipBySkuRdc;
    _demandMerged = false; window._demandMerging = false; window._demandFail = 0; dataStore.inventory.actualShipBySkuRdc = {};
    renderPlanAdvice();
    const pg = document.getElementById('page-plan-monitor');
    const txt = pg ? pg.innerText : '';
    const out = { banner: txt.indexOf('订单口径回退值') >= 0, retry: txt.indexOf('重试加载') >= 0 };
    _demandMerged = true; dataStore.inventory.actualShipBySkuRdc = bak;
    return out;
  });
  T('F2 未就绪时警示条 + 重试按钮可见', f2.banner === true && f2.retry === true, JSON.stringify(f2));
  T('G 无运行时错误', errs.length === 0, errs.length ? errs.slice(0, 4).join(' | ') : '0 条');

  console.log('\n===== 汇总 =====');
  const bad = results.filter(r => !r.ok);
  console.log(bad.length ? `❌ ${bad.length}/${results.length} 项失败` : `✅ ${results.length}/${results.length} 项全部通过`);
  await browser.close(); srv.close(); process.exit(bad.length ? 1 : 0);
})();
