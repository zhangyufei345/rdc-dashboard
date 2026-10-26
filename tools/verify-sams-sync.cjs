#!/usr/bin/env node
/**
 * 山姆预警线「数据源断链」修复验证（2026-10-26，generate_data_json.mjs v439）
 *
 * 背景：samsLoad() 直接 fetch('./sams-demand.xlsx')，而该文件停在 2026-10-18，
 *   导致山姆预警线（历史周均/σ/上沿 + 未来 DP）长期冻结。v439 改为每次订单部署
 *   自动把 data.xlsx 的「山姆需求」sheet 导回 sams-demand.xlsx。
 *
 * 断言：
 *  A1 山姆数据已加载（window._samsState.data 非空）
 *  A2 🔴 10/19-25 实际已进入文件（修复前整周空白）——惠州/天津均非 null
 *  A3 预警线已随新数据变化（惠州 ≠ 19,843 / 天津 ≠ 25,117，修复前旧值）
 *  A4 山姆页零运行时错误
 *  A5 sams-fc 页面已渲染
 *
 * 用法（项目根）：NODE_PATH="<node workspace node_modules>" <node> tools/verify-sams-sync.cjs
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

// ⚠ 必须用 path.resolve（反斜杠）——硬编码正斜杠会让 path.join 的产物 startsWith 恒为假 → 全站 404
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.xlsx': 'application/octet-stream' };

const RESULTS = [];
function check(name, ok, detail) { RESULTS.push({ name, ok, detail }); console.log((ok ? '✅ ' : '❌ ') + name + (detail ? '  — ' + detail : '')); }

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  for (const d of fs.readdirSync(base)) {
    for (const c of [path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
                     path.join(base, d, 'chrome-win64', 'chrome.exe')]) {
      if (fs.existsSync(c)) return c;
    }
  }
  throw new Error('未找到 chromium');
}
function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

(async () => {
  const chromium = require('playwright-core').chromium;
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 980 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e && e.message ? e.message : String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 300)); });

  // CDN 本地缓存拦截（沙箱无外网时启用；本机可直连 CDN，默认不拦截，与 verify-page-runtime 一致）
  if (process.env.USE_CDN_CACHE === '1') {
    await page.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(__dirname, '.cdn-cache', 'echarts.min.js')) }));
    await page.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(__dirname, '.cdn-cache', 'xlsx.full.min.js')) }));
  }

  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, null, { timeout: 180000 });
  await page.waitForTimeout(6000);

  await page.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('sams-fc'); else window.location.hash = '#sams-fc'; });
  await page.waitForTimeout(600);
  await page.evaluate(() => { if (typeof samsLoad === 'function') samsLoad(true); });
  await page.waitForFunction(() => window._samsState && window._samsState.data && window._samsState.data.whs && window._samsState.data.whs.length > 0, null, { timeout: 60000 });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    const st = window._samsState, data = st.data, mw = data.mweeks || [];
    const rows = data.whs.map(w => samsRopAt(w, st.coverW, st));
    const idx = mw.findIndex(w => String(w.short || '').replace(/\s/g, '').indexOf('10/19') >= 0);
    const pick = (kw) => {
      const w = data.whs.find(x => String(x.name).indexOf(kw) >= 0);
      const r = rows.find(x => String(x.name).indexOf(kw) >= 0);
      return w ? { actual_1019: (idx >= 0 ? w.actualM[idx] : null),
                   rop: r ? Math.round(r.rop) : null, reqCover: r ? Math.round(r.reqCover) : null,
                   ssFinal: r ? Math.round(r.ssFinal) : null, dropDays: r ? +r.dropDays.toFixed(1) : null,
                   reqBasis: r ? r.reqBasis : null, k: r ? +r.k.toFixed(3) : null, lastVal: r ? r.lastVal : null } : null;
    };
    return {
      coverW: st.coverW, csl: st.csl, win: st.win,
      lastWeeks: mw.slice(-4).map(w => w.short + (w.ok ? '(已完成)' : (w.running ? '(进行中)' : ''))),
      idx_1019: idx,
      hz: pick('惠州'), tj: pick('天津'),
      allRop: rows.map(r => r.short + '=' + Math.round(r.rop)).join(', ')
    };
  });

  check('A1 山姆数据已加载', info.allRop.length > 0, '覆盖周数=' + info.coverW + ' 窗口=' + info.win + ' 最近周=' + info.lastWeeks.join(' / '));
  check('A2 🔴 10/19-25 实际已进入文件（修复前整周空白）',
    info.hz && info.hz.actual_1019 != null && info.tj && info.tj.actual_1019 != null,
    '惠州=' + (info.hz && info.hz.actual_1019) + ' / 天津=' + (info.tj && info.tj.actual_1019) + '（10/19-25 列索引=' + info.idx_1019 + '）');
  check('A3 预警线已随新数据变化（旧值：惠州 19,843 / 天津 25,117）',
    info.hz && info.hz.rop !== 19843 && info.tj && info.tj.rop !== 25117,
    '惠州 ' + (info.hz && info.hz.rop) + ' = 需求覆盖 ' + (info.hz && info.hz.reqCover) + ' + 安全库存 ' + (info.hz && info.hz.ssFinal)
    + ' ｜ 天津 ' + (info.tj && info.tj.rop) + ' = ' + (info.tj && info.tj.reqCover) + ' + ' + (info.tj && info.tj.ssFinal));
  console.log('\n【各仓预警线】' + info.allRop + '\n');
  check('A4 山姆页零运行时错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '无');
  const htmlLen = await page.evaluate(() => { const el = document.getElementById('page-sams-fc'); return el ? el.innerHTML.length : 0; });
  check('A5 sams-fc 页面已渲染', htmlLen > 1000, 'html=' + htmlLen);

  await browser.close();
  server.close();

  const fail = RESULTS.filter(r => !r.ok);
  console.log('\n===== ' + (RESULTS.length - fail.length) + '/' + RESULTS.length + ' 通过 =====');
  if (fail.length) { console.log('失败项：'); fail.forEach(f => console.log('  ✗ ' + f.name + ' — ' + f.detail)); process.exit(1); }
})();
