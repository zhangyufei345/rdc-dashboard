// 2026-10-10「更新订单部署（9月归档 + 10月切换）」专项验证
// 用法：NODE_PATH=<...> node tools/verify-odeploy-1010.cjs
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
const SHOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40/.cache';
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

const R = [];   // 结果
function ck(name, ok, detail) { R.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); }

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
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  // 全新上下文（无 IDB 缓存）→ 等价「新用户首次访问」场景
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console.error: ' + m.text()); });

  await page.goto(`http://127.0.0.1:${port}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 300000 }).catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 180000 }).catch(() => {});
  await page.evaluate(async () => { if (typeof ensureDemandMerged === 'function') await ensureDemandMerged(); });
  await page.evaluate(async () => { if (typeof ensureInventoryPlan === 'function') await ensureInventoryPlan(); });
  await page.waitForTimeout(2000);

  // ---- 1) 订单明细月份分布（核心：9 月必须还在 + 10 月是当月）----
  const dist = await page.evaluate(() => {
    const c = {};
    (dataStore.orderDetail || []).forEach(r => { const m = String(r.dateStr || '').slice(0, 7); if (m) c[m] = (c[m] || 0) + 1; });
    return { total: (dataStore.orderDetail || []).length, months: c };
  });
  const ms = Object.keys(dist.months).sort();
  ck('订单明细总行数 > 0', dist.total > 0, dist.total);
  ck('月份数 = 10（2026-01~10）', ms.length === 10, ms.join(','));
  ck('含 2026-09（归档生效）', !!dist.months['2026-09'], dist.months['2026-09']);
  ck('2026-09 行数 = 25328', dist.months['2026-09'] === 25328, dist.months['2026-09']);
  ck('含 2026-10（当月已切）', !!dist.months['2026-10'], dist.months['2026-10']);
  ck('2026-10 行数 = 2458', dist.months['2026-10'] === 2458, dist.months['2026-10']);
  ck('2026-10 之后无其他月份', ms[ms.length - 1] === '2026-10', ms[ms.length - 1]);

  // ---- 2) 缺货汇总最新日期 ----
  const sh = await page.evaluate(() => {
    const ds = (dataStore.shortage || []).map(r => String(r.dateStr || '')).filter(Boolean).sort();
    return { n: (dataStore.shortage || []).length, latest: ds[ds.length - 1], first: ds[0], uniq: Array.from(new Set(ds.slice(-3))) };
  });
  ck('缺货汇总最新日期 = 2026-10-09', sh.latest === '2026-10-09', sh.latest + ' | ' + sh.uniq.join(','));
  ck('缺货汇总行数 > 0', sh.n > 0, sh.n);

  // ---- 3) 分仓需求月份 = 10/11/12 ----
  // 🔴 探针自纠：_demandMerged 是 boolean（L15412 `let _demandMerged = false`）**不是对象**，
  //    早先写 `_demandMerged.planMonths` 恒 undefined → 假红。改读真实数据入口 planBySkuRdc 的月份键。
  const dm = await page.evaluate(() => {
    const p = (dataStore.inventory && dataStore.inventory.planBySkuRdc) || {};
    const s = new Set();
    Object.keys(p).forEach(sk => Object.keys(p[sk] || {}).forEach(rd => Object.keys(p[sk][rd] || {}).forEach(m => s.add(m))));
    const ship = (dataStore.inventory && dataStore.inventory.actualShipBySkuRdc) || {};
    const s2 = new Set();
    Object.keys(ship).forEach(sk => Object.keys(ship[sk] || {}).forEach(rd => Object.keys(ship[sk][rd] || {}).forEach(m => s2.add(m))));
    const meta = (dataStore.inventory && dataStore.inventory.demandMeta) || {};
    return { planMonths: Array.from(s).sort(), shipMonths: Array.from(s2).sort(), metaPlan: meta.planMonths || null, merged: _demandMerged };
  });
  ck('分仓需求计划月份 = 2026-10/11/12', JSON.stringify(dm.planMonths) === JSON.stringify(['2026-10', '2026-11', '2026-12']), JSON.stringify(dm.planMonths));
  ck('分仓需求出货月份 = 仅 2026-10', JSON.stringify(dm.shipMonths) === JSON.stringify(['2026-10']), JSON.stringify(dm.shipMonths));
  ck('_demandMerged = true', dm.merged === true, dm.merged);

  // ---- 4) 截图 + 页面 KPI ----
  const shots = [['overview', 'odeploy1010_overview'], ['plan-monitor', 'odeploy1010_planmonitor'], ['shortage', 'odeploy1010_shortage']];
  for (const [route, fn] of shots) {
    await page.evaluate(r => { if (typeof navigateTo === 'function') navigateTo(r); }, route);
    await page.waitForTimeout(2500);
    const txt = await page.evaluate(() => {
      const el = document.querySelector('.page.active') || document.querySelector('[data-page].active') || document.body;
      return (el.innerText || '').slice(0, 4000);
    });
    fs.mkdirSync(SHOT, { recursive: true });
    await page.screenshot({ path: path.join(SHOT, fn + '.png'), fullPage: false });
    if (route === 'overview') {
      const has1009 = /2026-10-09|10-09|10\/09/.test(txt);
      ck('总览页出现缺货日期 10-09', has1009, (txt.match(/2026-10-\d\d|10-\d\d/g) || []).slice(0, 4).join(','));
    }
    if (route === 'plan-monitor') {
      const m = txt.match(/整体计划完成率[^\n]*?\n?([\d.]+%)/);
      ck('分仓监控页有完成率数字', !!m, m ? m[1] : txt.slice(0, 120).replace(/\n/g, ' | '));
    }
  }

  ck('无 JS 运行时错误', errs.length === 0, errs.slice(0, 3).join(' ; '));

  await browser.close();
  srv.close();

  const pass = R.filter(x => x.ok).length;
  console.log('=== 部署后专项验证（2026-10-10 订单部署）===');
  R.forEach(x => console.log(`${x.ok ? '✅' : '🔴'} ${x.name}  ${x.detail ? '→ ' + x.detail : ''}`));
  console.log(`\n合计 ${R.length} 项，通过 ${pass} 项，失败 ${R.length - pass} 项`);
  console.log('订单明细月份分布: ' + JSON.stringify(dist.months));
  process.exit(pass === R.length ? 0 : 1);
})();
