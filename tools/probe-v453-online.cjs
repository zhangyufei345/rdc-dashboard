#!/usr/bin/env node
/**
 * ⚠️ 已被 v454 取代：用户要求 D / E 字母互换 —— 本文件断言的 D/E 数量与字母绑定均已作废。
 *    现行探针：tools/probe-v454-swap.cjs（本地）、tools/probe-v454-online.cjs（线上）。
 *    本文件保留作 v453 历史证据，不要直接运行（会假红）。
 * v453 验证探针：E「计划口径变动」
 *  ① dp-history.json 能加载（否则 console 有 warn）
 *  ② 2026-10 归因分布应为 A1 9 / A2 6 / C1 18 / C2 8 / D 9 / E 8（清单仍 58 行）
 *  ③ E 的 8 行必须与我离线算出的 8 个 SKU×RDC 完全一致
 *  ④ 归因卡片出现第 7 张 E、下拉出现 E 选项、单元格出现「计划 MM-DD ↑N.Nx」
 *  ⑤ 2026-09 也应出现 E（该月归档同样有分仓需求）
 *  ⑥ 零 pageerror
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
const EXPECT_E = ['9859|华中RDC', '20881|华南RDC', '20881|华北RDC', '20956|华北RDC',
  '40057|华北RDC', '40334|东北RDC', '56000|西北RDC', '72048|华北RDC'];
let PASS = 0, FAIL = 0;
function ck(cond, name, extra) {
  if (cond) { PASS++; console.log('  ✅ ' + name); }
  else { FAIL++; console.log('  ❌ ' + name + (extra ? '  →  ' + extra : '')); }
}
(async () => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('https://rdc-dashboard.pages.dev/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 240000 });
  await page.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('shortage'); window._shortageTab = 'monthly'; });
  await page.waitForFunction(() => typeof _demandReady === 'function' && _demandReady(), { timeout: 120000 }).catch(() => {});
  await page.waitForFunction(() => !!window._dpHist || !!window._dpHistError, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const ver = document.title;
    window._msMonth = '2026-10'; window._msPage = 1; window._attrFilter = 'all'; window._msDrill = null;
    renderShortage();
    const a = window._msFocusAttr; const by = {};
    (a ? a.results : []).forEach(x => { by[x.type] = (by[x.type] || 0) + 1; });
    const eRows = (a ? a.results : []).filter(x => x.type === 'E')
      .map(x => String(x.sku).replace(/^0+/, '') + '|' + x.rdc).sort();
    const s = (a ? a.results : []).find(x => x.type === 'E');
    return { title: ver, dpOk: !!window._dpHist, dpErr: window._dpHistError, hi: a ? a.results.length : -1,
             by, eRows, sample: s ? (s.sku + '·' + s.rdc + '  ' + window._dpRevText(s.planRev)) : null };
  });
  console.log('线上 title:', r.title);
  console.log('dp-history 加载:', r.dpOk, '| 错误:', r.dpErr || '无');
  console.log('2026-10 清单行数:', r.hi);
  console.log('归因分布:', JSON.stringify(r.by));
  console.log('E 组合 (' + r.eRows.length + '):', r.eRows.join(', '));
  console.log('样例:', r.sample);
  console.log('pageErrors =', errs.length, errs.slice(0, 3).join(' | '));
  await browser.close();
})().catch(e => { console.error('异常:', e && e.message); process.exit(2); });
