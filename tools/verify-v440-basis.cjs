#!/usr/bin/env node
/**
 * v440 基准口径「按历史销售覆盖」贯穿性验证（2026-10-26）
 *
 * 断言：
 *  A1 参数栏三个口径按钮文案 = 未来计划优先 / 按历史销售覆盖 / 取两者高
 *  A2 plan 口径逐仓预警线与 v439 基线一致（零回归）
 *  A3 hist 口径：覆盖天数 = 覆盖周数×7 时 目标水位 == 预警线（需补 0 箱）
 *  A4 hist 口径：覆盖 14 天 > 7 天，目标水位升高、车数 > 0（口径能真正驱动补货）
 *  A5 hist 口径下卡片文案标注「按历史销售覆盖」，且不再出现「历史回退」误标
 *  A6 零运行时错误
 *
 * 用法（项目根）：NODE_PATH="<node_modules>" node tools/verify-v440-basis.cjs
 */
const fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.xlsx': 'application/octet-stream' };
const R = [];
const ck = (n, ok, d) => { R.push({ n, ok, d }); console.log((ok ? '✅ ' : '❌ ') + n + (d ? '  — ' + d : '')); };
function findC() { const b = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'); const c = []; for (const d of fs.readdirSync(b)) { c.push(path.join(b, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(b, d, 'chrome-win64', 'chrome.exe')); } return c.find(p => fs.existsSync(p)); }
function srv() { const s = http.createServer((q, r) => { const rel = decodeURIComponent(q.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html'; const f = path.join(ROOT, rel); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('nf'); return; } r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }); return new Promise(x => s.listen(0, '127.0.0.1', () => x(s))); }
// v439 基线（plan / 近8周 / 覆盖1周 / 未填库存）
const BASE = { '惠州': 31378, '天津': 34848, '武汉': 5939, '成都': 3480, '常州': 6612, '嘉兴': 13032 };

(async () => {
  const { chromium } = require('playwright-core');
  const server = await srv(); const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findC(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1560, height: 1000 } })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e && e.message)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('C:' + m.text().slice(0, 160)); });
  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {}); await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, null, { timeout: 180000 });
  await page.waitForTimeout(6000);
  await page.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('sams-fc'); });
  await page.waitForTimeout(600);
  await page.evaluate(() => { if (typeof samsLoad === 'function') samsLoad(true); });
  await page.waitForFunction(() => window._samsState && window._samsState.data && window._samsState.data.whs.length > 0, null, { timeout: 60000 });
  await page.waitForTimeout(1200);

  const grab = (o) => page.evaluate(cfg => {
    samsSet('basis', cfg.basis); samsSet('win', '8'); samsSet('coverW', '1'); samsSet('coverDays', String(cfg.cd)); samsClearStock();
    const st = window._samsState, rows = samsAllMetrics(st);
    const el = document.getElementById('page-sams-fc'); const txt = el ? el.innerText : '';
    return {
      rows: rows.map(x => ({ wh: x.short, rop: Math.round(x.rop), target: Math.round(x.coverTarget), need: Math.round(x.coverNeed), nCar: x.nCar, basis: x.reqBasis })),
      labels: (txt.match(/未来计划优先|按历史销售覆盖|取两者高/g) || []),
      cards: [].map.call(document.querySelectorAll('#page-sams-fc .kpi-card'), function (c) { return c.innerText.replace(/\n+/g, ' '); })
    };
  }, o);

  const plan = await grab({ basis: 'plan', cd: 7 });
  const badBase = plan.rows.filter(x => BASE[x.wh] != null && x.rop !== BASE[x.wh]);
  ck('A1 三个口径按钮文案齐全', ['未来计划优先', '按历史销售覆盖', '取两者高'].every(l => plan.labels.indexOf(l) >= 0), plan.labels.join(' / '));
  ck('A2 plan 口径逐仓预警线与 v439 基线一致（零回归）', badBase.length === 0,
    badBase.length ? badBase.map(x => x.wh + ' ' + x.rop + '≠' + BASE[x.wh]).join(' / ') : plan.rows.map(x => x.wh + '=' + x.rop).join(' / '));

  const h7 = await grab({ basis: 'hist', cd: 7 });
  const mis7 = h7.rows.filter(x => Math.abs(x.target - x.rop) > 2 || x.need !== 0);
  ck('A3 hist 覆盖7天：目标水位 == 预警线、需补 0', mis7.length === 0 && h7.rows.every(x => x.basis === 'hist'),
    h7.rows.map(x => x.wh + ' 目标' + x.target + '/预警' + x.rop + '/需补' + x.need).join(' | '));

  const h14 = await grab({ basis: 'hist', cd: 14 });
  const pos = h14.rows.filter(x => x.target > x.rop && x.nCar > 0);
  ck('A4 hist 覆盖14天：目标水位升高且车数>0', pos.length === h14.rows.length,
    h14.rows.map(x => x.wh + ' 目标' + x.target + ' → ' + x.nCar + '车').join(' | '));

  const cardBad = h7.cards.filter(t => t.indexOf('按历史销售覆盖') < 0 || t.indexOf('历史回退') >= 0);
  ck('A5 hist 口径每张卡片都标「按历史销售覆盖」且无「历史回退」误标', h7.cards.length > 0 && cardBad.length === 0,
    h7.cards.length + ' 张卡片，异常 ' + cardBad.length + (cardBad.length ? '：' + cardBad[0].slice(0, 60) : ''));
  ck('A6 零运行时错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '无');

  await browser.close(); server.close();
  const fail = R.filter(x => !x.ok);
  console.log('\n===== ' + (R.length - fail.length) + '/' + R.length + ' 通过 =====');
  if (fail.length) process.exit(1);
})().catch(e => { console.error('工具异常:', e && e.message); process.exit(2); });
