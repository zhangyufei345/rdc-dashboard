#!/usr/bin/env node
/**
 * v378 截图留证：分仓计划监控页（KPI + 对比卡 + 品牌矩阵 + MTD 曲线 + 明细表头）
 * ⚠️ headless-shell 下对 canvas/DOM 元素单独截图不可靠 → 用「把目标滚动到视口顶部 + 整屏截图」。
 *   滚动方式：找最近的可滚动祖先，scrollTop += rect.top - 70。
 */
const fs = require('fs'); const http = require('http'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  for (const d of fs.readdirSync(base)) for (const c of [['chrome-headless-shell-win64', 'chrome-headless-shell.exe'], ['chrome-win64', 'chrome.exe']]) {
    const p = path.join(base, d, c[0], c[1]); if (fs.existsSync(p)) return p;
  }
  throw new Error('no chromium');
}
function startServer() {
  const s = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(s)));
}
const SHOT = path.join(ROOT, '.cache');
(async () => {
  const chromium = require('playwright-core').chromium;
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: 1 })).newPage();
  await page.goto('http://127.0.0.1:' + server.address().port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin'); await page.fill('#login-pass', 'admin123');
  await page.click('#login-page button');
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true && window._bootLoading === false, { timeout: 180000 });
  await page.evaluate(() => { window._planTab = 'monitor'; navigateTo('plan-monitor'); });
  await page.waitForFunction(() => (typeof _demandReady === 'function' ? _demandReady() : false) && !!window._demandHistory, { timeout: 120000 });
  await page.waitForTimeout(2500);
  if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

  async function shotTo(id, file, offset) {
    await page.evaluate(([sel, off]) => {
      const el = document.querySelector(sel); if (!el) return;
      let node = el, scroller = null;
      while (node) { const st = getComputedStyle(node); if (/(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 10) { scroller = node; break; } node = node.parentElement; }
      const rect = el.getBoundingClientRect();
      if (scroller) scroller.scrollTop += rect.top - (off || 70);
      else window.scrollTo(0, window.scrollY + rect.top - (off || 70));
    }, [id, offset]);
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(SHOT, file) });
    console.log('  ' + file);
  }
  await shotTo('#page-plan-monitor', 'v378_p1_kpi.png', 0);
  await shotTo('#pm-brand-rdc-card', 'v378_p2_brandmatrix.png', -180);
  await shotTo('#pm-rdc-trend', 'v378_p3_mtd.png', 600);   // 图表高 340px → 顶置 600px 即可整张入镜（含上方曲线头部）
  await shotTo('#pm-sku-detail-table', 'v378_p4_detail.png', -80);
  await browser.close(); server.close();
})().catch(e => { console.error('异常:', e && e.message); process.exit(2); });
