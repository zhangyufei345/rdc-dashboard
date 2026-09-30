#!/usr/bin/env node
/**
 * v388.1 图表 tooltip 运行时校验（补上 verify-monthend-tab.cjs 的盲区）
 *
 * 背景：v388 上线后用户报「页面报错 Cannot read properties of undefined (reading 'n')」
 *   —— 根因是「逐月压货达标率」图的 tooltip 用被 slice(5) 截断的 x 轴标签 '01' 去查
 *   key 为 '2026-01' 的 monthStat → undefined → s.n 抛错。
 *   ⚠️ 原 34 项探针**全部通过**却漏掉了它，因为这些断言只验「图表实例化 + series>0」，
 *   **从未真正触发 tooltip formatter**。教训：tooltip formatter 只在真实 hover 时才执行，
 *   光看 getOption() 永远发现不了里面的 TypeError。
 *
 * 做法：对每张图，在图表 DOM 范围内按网格真实 page.mouse.move，
 *   逐点扫描触发 tooltip，全程监听 pageerror / console.error。
 *
 * 用法：
 *   NODE_PATH=".../node_modules" "$NODE" tools/verify-monthend-tooltip.cjs
 *   RDC_BASE=https://rdc-dashboard.pages.dev ... tools/verify-monthend-tooltip.cjs
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.RDC_BASE || '').replace(/\/$/, '');

function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const c = [];
  for (const d of fs.readdirSync(base)) {
    c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    c.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  return c.find(p => fs.existsSync(p));
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
function startServer() {
  const s = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(s)));
}

const R = { pass: 0, fail: 0 };
function chk(n, c, d) { c ? R.pass++ : R.fail++; console.log((c ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); }

(async () => {
  const { chromium } = require('playwright-core');
  let server = null, URL;
  if (BASE) URL = BASE + '/rdc-dashboard.html';
  else { server = await startServer(); URL = 'http://127.0.0.1:' + server.address().port + '/rdc-dashboard.html'; }
  console.log('目标:', URL);

  const b = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  let errs = [];
  p.on('pageerror', e => errs.push('[pageerror] ' + (e.message || e)));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('[console] ' + m.text().slice(0, 240)); });

  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.fill('#login-user', 'admin').catch(() => {});
  await p.fill('#login-pass', 'admin123').catch(() => {});
  await p.click('#login-page button').catch(() => {});
  await p.waitForFunction(() => window._bootLoading === false && typeof dataStore !== 'undefined' && dataStore.loaded === true, { timeout: 240000 });

  await p.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('shortage'); });
  await p.waitForTimeout(1000);
  await p.evaluate(() => {
    const t = [...document.querySelectorAll('#page-shortage button')].find(x => (x.textContent || '').indexOf('月底压货商品分析') >= 0);
    if (t) t.click();
  });
  await p.waitForTimeout(3000);

  const CHARTS = ['chart-me-quad', 'chart-me-wh', 'chart-me-month', 'chart-me-rdc'];
  const shotDir = path.join(ROOT, 'tools', '_out');
  fs.mkdirSync(shotDir, { recursive: true });

  for (const id of CHARTS) {
    const el = await p.$('#' + id);
    if (!el) { chk('图表 ' + id + ' 存在', false); continue; }
    await el.scrollIntoViewIfNeeded();
    await p.waitForTimeout(600);
    const box = await el.boundingBox();
    if (!box || !(box.width > 20) || !(box.height > 20)) { chk('图表 ' + id + ' boundingBox 有效', false, JSON.stringify(box)); continue; }

    const el2 = await p.$('#' + id);
    if (el2) { await el2.scrollIntoViewIfNeeded(); await p.waitForTimeout(600); }
    const box2 = await el2.boundingBox();

    errs = [];
    // 网格扫描：横向 14 段 × 纵向 5 段（覆盖散点/柱/线/堆叠各类）
    let moves = 0, bad = null;
    for (let i = 1; i <= 14 && !bad; i++) {
      for (let j = 1; j <= 5; j++) {
        const x = Math.round(box2.x + (box2.width * i) / 15);
        const y = Math.round(box2.y + (box2.height * j) / 6);
        if (!isFinite(x) || !isFinite(y) || x < 0 || y < 0) continue;
        try {
          await p.mouse.move(x, y);
          moves++;
        } catch (e) { bad = e.message; break; }
        await p.waitForTimeout(45);
        const e2 = errs.filter(z => !/favicon/.test(z));
        if (e2.length) { bad = e2[0]; errs = e2; break; }
      }
    }
    if (bad && !errs.length) { chk('图表 ' + id + ' mouse.move 正常', false, bad); continue; }
    await p.mouse.move(3, 3);
    await p.waitForTimeout(150);
    const real = errs.filter(z => !/favicon/.test(z));
    chk('图表 ' + id + ' 网格 hover ' + moves + ' 点无 tooltip 报错', real.length === 0, real.slice(0, 2).join(' || '));
    errs = [];
  }

  // ── 专项：逐月图 tooltip 内容断言（原 bug 的确切位置）──
  try {
    const el = await p.$('#chart-me-month');
    await el.scrollIntoViewIfNeeded();
    await p.waitForTimeout(600);
    const box = await el.boundingBox();
    errs = [];
    let tipTxt = '';
    for (let i = 0; i < 9; i++) {
      const x = Math.round(box.x + box.width * (i + 0.5) / 9);
      const y = Math.round(box.y + box.height * 0.5);
      await p.mouse.move(x, y);
      await p.waitForTimeout(180);
      tipTxt = await p.evaluate(() => {
        const cand = [...document.querySelectorAll('#chart-me-month div')].filter(d =>
          d.style && d.style.position === 'absolute' && d.textContent && d.textContent.indexOf('可观测组合') >= 0);
        return cand.length ? cand[0].innerText : '';
      });
      if (tipTxt) break;
    }
    chk('逐月图 tooltip 能正常弹出且含「可观测组合」', tipTxt.indexOf('可观测组合') >= 0, JSON.stringify(tipTxt.slice(0, 100)));
    chk('🔴 逐月图 tooltip 月份为完整 YYYY-MM（原 bug 截断成 01）', /2026-\d\d/.test(tipTxt), JSON.stringify(tipTxt.slice(0, 40)));
    const real = errs.filter(z => !/favicon/.test(z));
    chk('🔴 逐月图 hover 全程无报错（用户报错点）', real.length === 0, real.slice(0, 2).join(' || '));
    await p.screenshot({ path: path.join(shotDir, '_me_tooltip_month.png'), clip: box }).catch(() => {});
  } catch (e) { chk('逐月图 tooltip 专项', false, String(e && e.message || e)); }

  await b.close();
  if (server) server.close();
  console.log('\n合计 ' + (R.pass + R.fail) + ' 项，通过 ' + R.pass + '，失败 ' + R.fail);
  process.exit(R.fail ? 1 : 0);
})().catch(e => { console.error('探针异常:', e && e.stack || e); process.exit(2); });
