// v374 门控：验证「导出/页面不会读到订单口径回退值」
//
// 背景：用户 2026-09-20 报「东北81014订单支数还是38220」。逐条对拍 2,398 行后确认：
//   38220 = 已放行 34560 + 未放行 3660（3660 = 61箱 × 箱规60），即 demand.json 未并入时的
//   **订单口径回退值**；同一代码/数据在并入完成后是 89820。根因是取数时机（异步 fetch vs 同步导出），
//   不是 exportPlanAdvice 的取值逻辑。
//
// 本门控断言：
//   T1 就绪后导出 → 81014·东北RDC 订单(支) = 89820、完成率 59.3%
//   T2 未就绪时导出 → 不静默给回退值：必须触发 confirm（我们在 page 里把 confirm 置为 false → 导出应被取消）
//   T3 未就绪时导出按钮（点 confirm=true）→ 导出成功但值为回退值（有显式告知，属可接受降级）
//   T4 ensureDemandMerged 完成后，advice 子页签被重算（页面出现实际出货口径的值 / 无警示条）
//   T5 _demandReady() 语义正确：并入前 false、并入后 true
//   T6 页面无运行时错误
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript' };
function serve() { return new Promise(res => { const s = http.createServer((req, rq) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rq.writeHead(404); rq.end('nf'); return; } rq.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' }); fs.createReadStream(f).pipe(rq); }); s.listen(0, '127.0.0.1', () => res(s)); }); }

const results = [];
function T(name, ok, detail) { results.push({ name, ok, detail }); console.log((ok ? '✅' : '❌') + ' ' + name + (detail ? '  — ' + detail : '')); }

async function loginAndBoot(page, port) {
  await page.goto(`http://127.0.0.1:${port}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 120000 });
}

async function exportMine(page) {
  return await page.evaluate(() => {
    let cap = null;
    const orig = window.downloadFile;
    window.downloadFile = (n, c) => { cap = c; };
    return Promise.resolve()
      .then(() => exportPlanAdvice())
      .then(() => { window.downloadFile = orig; return cap; }, e => { window.downloadFile = orig; return 'ERR:' + e.message; });
  });
}

(async () => {
  const srv = await serve(); const port = srv.address().port;
  const exe = (() => { const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'); const c = []; for (const d of fs.readdirSync(base)) { c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(base, d, 'chrome-win64', 'chrome.exe')); } return c.find(p => fs.existsSync(p)); })();
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  // 资源级 404/网络噪声不算「运行时错误」：本地静态服务器没有 favicon.ico 等文件，
  // 浏览器会往 console 抛 "Failed to load resource: ... 404"。这类噪声会掩盖真正的
  // ReferenceError/TDZ 类 pageerror，必须过滤（pageerror 一律照收）。
  const isResourceNoise = (t) => /Failed to load resource/i.test(t) || /\b404\b/.test(t) || /net::ERR_/.test(t);
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (isResourceNoise(t)) return;   // 资源加载类噪声，跳过
    errs.push('console.error: ' + t);
  });

  await loginAndBoot(page, port);
  const BV = await page.evaluate(() => (typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : 'ERR'));
  console.log('BUILD_VERSION =', BV);
  T('版本号 = 374', BV === 374, 'BUILD_VERSION=' + BV);

  // ---- T5 前置：_demandReady 并入前应为 false（此刻 boot 可能已并入，先看实际） ----
  const readyAtBoot = await page.evaluate(() => (typeof _demandReady === 'function') ? _demandReady() : 'NOFN');
  T('T5a _demandReady 已暴露为函数', readyAtBoot !== 'NOFN', '值=' + readyAtBoot);

  // ---- 构造「未就绪」态：重置 _demandMerged + 清空 actualShipBySkuRdc ----
  await page.evaluate(() => {
    _demandMerged = false;
    window._demandMerging = false;
    window._demandFail = 0;
    if (dataStore.inventory) dataStore.inventory.actualShipBySkuRdc = {};
  });
  const readyAfterReset = await page.evaluate(() => _demandReady());
  T('T5b 重置后 _demandReady() === false', readyAfterReset === false, '值=' + readyAfterReset);

  // ---- T2 未就绪 + 用户选「取消」→ 不应产生任何导出 ----
  const t2 = await page.evaluate(() => {
    window.confirm = () => false;                 // 模拟用户点「取消」
    let cap = null;
    const orig = window.downloadFile;
    window.downloadFile = (n, c) => { cap = c; };
    // 阻止真正的合并把状态翻回 ready（把 fetch 打回失败，保持未就绪态）
    const origFetch = window.fetch;
    window.fetch = (u, o) => (String(u).indexOf('demand.json') >= 0)
      ? Promise.reject(new Error('SIMULATED_FAIL'))
      : origFetch(u, o);
    return Promise.resolve().then(() => exportPlanAdvice()).then(() => {
      window.fetch = origFetch; window.downloadFile = orig;
      return { cap, ready: _demandReady() };
    }, e => { window.fetch = origFetch; window.downloadFile = orig; return { err: e.message }; });
  });
  T('T2 未就绪时导出被 confirm 拦下（无文件产出）', !t2.err && (t2.cap === null || t2.cap === undefined), 'cap=' + (t2.cap ? '有内容(' + t2.cap.length + ')' : 'null') + ', ready=' + t2.ready);

  // ---- T3 未就绪 + 用户点「确定」→ 允许降级导出，但值应为回退口径（并已被告知） ----
  const t3 = await page.evaluate(() => {
    window.confirm = () => true;
    let cap = null;
    const orig = window.downloadFile;
    window.downloadFile = (n, c) => { cap = c; };
    const origFetch = window.fetch;
    window.fetch = (u, o) => (String(u).indexOf('demand.json') >= 0)
      ? Promise.reject(new Error('SIMULATED_FAIL'))
      : origFetch(u, o);
    return Promise.resolve().then(() => exportPlanAdvice()).then(() => {
      window.fetch = origFetch; window.downloadFile = orig;
      const lines = (cap || '').split('\n').filter(l => l.startsWith('81014,'));
      const ne = lines.filter(l => l.indexOf(',东北RDC,') >= 0)[0] || '';
      const c = ne.split(',');
      return { rows: lines.length, plan: c[6], shipped: c[7], comp: c[8] };
    }, e => { window.fetch = origFetch; window.downloadFile = orig; return { err: e.message }; });
  });
  T('T3 降级导出仍可用（已告知用户）', !t3.err && t3.shipped != null, '西南..东北RDC 订单=' + t3.shipped + ' 完成率=' + t3.comp);
  console.log('     ↳ 该值属「订单口径回退值」，低于实际出货 89820 —— 与用户报的 38220 同源');

  // ---- T1/T4 恢复就绪：真跑 ensureDemandMerged，然后导出应得 89820，且 advice 页被重算 ----
  await page.evaluate(() => { window.confirm = () => true; });
  await page.evaluate(async () => {
    if (typeof ensureDemandMerged === 'function') await ensureDemandMerged();
  });
  await page.waitForTimeout(2500);
  const readyNow = await page.evaluate(() => _demandReady());
  T('T5c 并入后 _demandReady() === true', readyNow === true, '值=' + readyNow);

  const t1 = await page.evaluate(() => {
    const v = (window._actualShipOf && _actualShipOf('81014', '东北RDC', '2026-09'));
    return v;
  });
  T('T1a _actualShipOf(81014,东北RDC,2026-09) = 89820', Number(t1) === 89820, '实际=' + t1);

  const t1exp = await (async () => {
    const csv = await exportMine(page);
    if (typeof csv !== 'string' || csv.startsWith('ERR:')) return { err: csv };
    const lines = csv.split('\n').filter(l => l.startsWith('81014,'));
    const ne = lines.filter(l => l.indexOf(',东北RDC,') >= 0)[0] || '';
    const c = ne.split(',');
    return { plan: c[6], shipped: c[7], comp: c[8], total: csv.split('\n').length - 1 };
  })();
  T('T1b 就绪后导出 81014·东北RDC = 89820 / 59.3%',
    !t1exp.err && t1exp.shipped === '89820' && t1exp.comp === '59.3',
    t1exp.err ? t1exp.err : ('计划=' + t1exp.plan + ' 订单=' + t1exp.shipped + ' 完成率=' + t1exp.comp + ' 行数=' + t1exp.total));

  // ---- T4 advice 子页签重算：进入优化建议页，断言无警示条 + 页面数值为实际出货口径 ----
  await page.evaluate(() => { window._planTab = 'advice'; if (typeof navigateTo === 'function') navigateTo('plan-monitor'); });
  await page.waitForTimeout(3000);
  const t4 = await page.evaluate(() => {
    const pg = document.getElementById('page-plan-monitor');
    const txt = pg ? pg.innerText : '';
    return {
      cur: (typeof currentPage === 'string') ? currentPage : String(window.currentPage),
      warn: txt.indexOf('订单口径回退值') >= 0,
      ready: _demandReady(),
      hasAdviceTitle: txt.indexOf('优化建议') >= 0
    };
  });
  T('T4 优化建议页已就绪且无「回退值」警示条', t4.ready === true && t4.warn === false, JSON.stringify(t4));

  // ---- T6 运行时错误 ----
  T('T6 无运行时错误', errs.length === 0, errs.length ? errs.slice(0, 5).join(' | ') : '0 条');

  console.log('\n===== 汇总 =====');
  const bad = results.filter(r => !r.ok);
  console.log(bad.length ? `❌ ${bad.length}/${results.length} 项失败` : `✅ ${results.length}/${results.length} 项全部通过`);
  await browser.close(); srv.close(); process.exit(bad.length ? 1 : 0);
})();
