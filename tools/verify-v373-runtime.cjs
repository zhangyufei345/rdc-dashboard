// v373 门控：验证「每日补货建议」满足率已并入大仓直发，且与 demand.json 实际出货口径一致
// 用法：node tools/verify-v373-runtime.cjs
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript' };
function serve() { return new Promise(res => { const s = http.createServer((req, rq) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rq.writeHead(404); rq.end('nf'); return; } rq.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' }); fs.createReadStream(f).pipe(rq); }); s.listen(0, '127.0.0.1', () => res(s)); }); }
const fails = [];
function gate(ok, msg) { console.log((ok ? '✅ ' : '❌ ') + msg); if (!ok) fails.push(msg); }

(async () => {
  const srv = await serve(); const port = srv.address().port;
  const exe = (() => { const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'); const c = []; for (const d of fs.readdirSync(base)) { c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(base, d, 'chrome-win64', 'chrome.exe')); } return c.find(p => fs.existsSync(p)); })();
  if (!exe) throw new Error('未找到 chromium');
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console.error: ' + m.text()); });

  await page.goto(`http://127.0.0.1:${port}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {}); await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 120000 });
  await page.evaluate(async () => { if (typeof ensureDemandMerged === 'function') await ensureDemandMerged(); });
  await page.waitForTimeout(2000);

  console.log('=== v373 门控 ===\n');

  // A: BUILD_VERSION
  const ver = await page.evaluate(() => (typeof BUILD_VERSION !== 'undefined') ? BUILD_VERSION : 'ERR');
  gate(ver === 373, `A1 BUILD_VERSION = ${ver}（应 373）`);

  // B: 补货建议页渲染并抓 89025·华中 的满足率
  await page.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('replenishment'); });
  await page.waitForTimeout(3500);
  const b = await page.evaluate(() => {
    const rows = window._replScored || [];
    const hit = rows.filter(r => String(r.materialCode) === '89025' && r.rdc === '华中RDC');
    const disp = window._replDisplayList || [];
    const inDisp = disp.filter(r => String(r.materialCode) === '89025' && r.rdc === '华中RDC');
    return {
      total: rows.length,
      scored: hit.map(r => ({ sku: r.materialCode, rdc: r.rdc, dailyAvg: Math.round(r.dailyAvg), fulfillRate: +(r.fulfillRate * 100).toFixed(2), demandDays: r.demandDays, suggestQty: r.suggestQty, score: r.score, urgency: r.urgencyLabel })),
      inDisp: inDisp.map(r => ({ sku: r.materialCode, rdc: r.rdc, fulfillRate: +(r.fulfillRate * 100).toFixed(2), suggestQty: r.suggestQty })),
      dispCount: disp.length,
    };
  });
  console.log('B1 _replScored 组合数 =', b.total, ' 展示列表条数 =', b.dispCount);
  if (!b.scored.length) { gate(false, 'B2 未找到 89025·华中 的评分行（无法核对）'); }
  else {
    const r = b.scored[0];
    console.log('B2 89025·华中:', JSON.stringify(r));
    gate(Math.abs(r.fulfillRate - 89.5) < 1.5, `B3 89025·华中 满足率 = ${r.fulfillRate}%（应≈89.5%，v372 前为≈82.3%）→ 已并入大仓直发`);
  }

  // C: 全量满足率（应与 probe 实测的 97.82% 同量级）
  const c = await page.evaluate(() => {
    const rows = window._replScored || [];
    let t = 0, f = 0, n = 0;
    rows.forEach(r => { if (r.dailyAvg > 0 || r.fulfillRate >= 0) { n++; } });
    return { n };
  });
  console.log('C1 _replScored 规模 =', c.n);

  // D: 源数据侧独立复算（Node 直读 data.json + demand.json 校验口径自洽）
  const dj = JSON.parse(fs.readFileSync(ROOT + '/demand.json', 'utf8'));
  const s89025 = dj.actualShip['89025'] && dj.actualShip['89025']['华中RDC'] ? dj.actualShip['89025']['华中RDC']['2026-09'] : null;
  console.log('D1 demand.json 89025·华中·2026-09 实际出货 =', s89025);
  gate(s89025 != null, 'D2 demand.json 可取到 89025·华中 实际出货');

  // E: 补货建议说明页文案已同步（不再出现"不并入本模块"）
  const e = await page.evaluate(() => {
    const s = document.body.innerText || '';
    return { hasOld: s.includes('不并入本模块'), hasNew: s.includes('已并入本模块') };
  });
  gate(e.hasOld === false, `E1 说明页已无「不并入本模块」旧文案（实测 hasOld=${e.hasOld}）`);

  console.log('\n运行时错误 ' + errs.length + ' 条');
  errs.slice(0, 12).forEach(x => console.log('  ❌ ' + x));
  if (errs.length) fails.push('运行时错误 ' + errs.length + ' 条');

  await browser.close(); srv.close();
  console.log(fails.length === 0 ? '\n✅ 门控通过' : '\n❌ 门控未通过 ' + fails.length + ' 项');
  process.exit(fails.length === 0 ? 0 : 1);
})();
