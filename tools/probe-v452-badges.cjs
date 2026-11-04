#!/usr/bin/env node
/**
 * 探针：验证 v452 的三处展示层改动
 *  ① 历史月（无「分仓需求」来源）→ _planSkuAggShipBasis='order' → 归因卡/清单卡必须出现「订单量口径」提示条
 *  ② 有实际出货的月份（10/9 月）→ basis='actual' → 不应出现提示条
 *  ③ 有效组合不足 4 天的月份（2026-11）→ 标题应显示「跨月合并 P75」，不得谎称「本月 P75」
 */
const fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const c = [];
  for (const d of fs.readdirSync(base)) { c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(base, d, 'chrome-win64', 'chrome.exe')); }
  return c.find(p => fs.existsSync(p));
}
function startServer() {
  const s = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(s)));
}
(async () => {
  const { chromium } = require('playwright-core');
  const server = await startServer(); const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 });
  await page.evaluate(() => { window._shortageTab = 'monthly'; if (typeof navigateTo === 'function') navigateTo('shortage'); });
  await page.waitForFunction(() => typeof _demandReady === 'function' && _demandReady(), { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // demand.json 里实际有实际出货数据的月份（真源）
  const shipMonths = await page.evaluate(() => {
    const m = (dataStore.inventory && dataStore.inventory.actualShipBySkuRdc) || {};
    const hit = {};
    Object.keys(m).forEach(sk => Object.keys(m[sk] || {}).forEach(rd => Object.keys(m[sk][rd] || {}).forEach(mo => { if (m[sk][rd][mo] != null) hit[mo] = (hit[mo] || 0) + 1; })));
    return hit;
  });
  console.log('demand.json 有实际出货的月份:', JSON.stringify(shipMonths));

  const months = await page.evaluate(() => Object.keys(getMonthlyShortageProfile().monthWorkdays || {}).sort().reverse());
  const targets = ['2026-11', '2026-10', '2026-09', '2026-05'];
  console.log('');
  console.log('月份      基  basis   归因卡提示条  清单卡提示条  清单标题阈值来源');
  for (const m of targets) {
    if (!months.includes(m)) { console.log(m + '  （画像里无此月，跳过）'); continue; }
    const r = await page.evaluate(mm => {
      window._msMonth = mm; window._msPage = 1; window._attrFilter = 'all'; window._msDrill = null;
      renderShortage();
      const pg = document.getElementById('page-shortage');
      const cards = [...pg.querySelectorAll('.card')];
      const attr = cards.find(c => c.textContent.indexOf('高严重度产品归因分析') >= 0);
      const lst = cards.find(c => c.textContent.indexOf('严重度高重点跟进清单') >= 0);
      const t = lst ? ((lst.querySelector('.card-title') || {}).textContent || '') : '';
      return {
        basis: window._planSkuAggShipBasis,
        attrBadge: !!(attr && attr.textContent.indexOf('归因口径：销售进度用订单量') >= 0),
        listBadge: !!(lst && lst.textContent.indexOf('销售进度：订单量口径') >= 0),
        title: t.replace(/\s+/g, ' ').trim(),
        rows: lst ? lst.querySelectorAll('tbody tr').length : 0,
        err: (!lst || !attr) ? 'CardMissing' : null
      };
    }, m);
    console.log('%s   %s  %s  %s  %s  %s', m.padEnd(9), String(r.basis).padEnd(7), '',
      r.attrBadge ? '有 ✅' : '无', r.listBadge ? '有 ✅' : '无', r.title.slice(0, 78));
  }

  console.log('');
  console.log('运行时错误:', errs.length ? errs.slice(0, 3) : '无');
  await browser.close(); server.close();
})().catch(e => { console.error('异常:', e && e.message); process.exit(2); });
