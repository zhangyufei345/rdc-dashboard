#!/usr/bin/env node
/**
 * v392 交付前目视核对截图：选 RDC 后筛选栏数字是否与该仓对齐
 *
 * 产出：
 *   tools/_out/_v392_rdc_none.png   —— RDC=全部（基线，按钮应为 345/15/66/72/192）
 *   tools/_out/_v392_rdc_db.png     —— RDC=东北RDC（应为 42/1/5/14/22）
 *   tools/_out/_v392_bar_db.png     —— 只截筛选栏（放大看数字与「共 N（东北RDC）」）
 *
 * 用法：NODE_PATH=... node tools/shot-v392.cjs
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

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

(async () => {
  const server = await startServer();
  const { chromium } = require('playwright-core');
  const b = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1.5 });
  const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:' + server.address().port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.fill('#login-user', 'admin').catch(() => {});
  await p.fill('#login-pass', 'admin123').catch(() => {});
  await p.click('#login-page button').catch(() => {});
  await p.waitForFunction(() => window._bootLoading === false && typeof dataStore !== 'undefined' && dataStore.loaded === true, { timeout: 240000 });

  const go = async (rdc) => {
    await p.evaluate((rd) => {
      // 🔴 必须先 navigateTo('shortage')：handleLogin 收尾会强制 navigateTo('overview')，
      //   只设 _shortageTab 会渲染进未激活的 #page-shortage → 截图拍到的是总览页。
      if (typeof currentPage === 'undefined' || currentPage !== 'shortage') {
        if (typeof navigateTo === 'function') navigateTo('shortage');
      }
      window._shortageTab = 'monthend';
      window._meRdc = rd;
      window._meQuad = 'all';
      window._meWhBadOnly = false;
      window._mePage = 1;
      renderShortage();
    }, rdc);
    await p.waitForTimeout(1500);
    // 滚到筛选栏，让它在视口内
    await p.evaluate(() => {
      const span = Array.from(document.querySelectorAll('#page-shortage span')).find(s => /个 SKU×RDC/.test(s.innerText || ''));
      if (span) span.scrollIntoView({ block: 'center' });
    }).catch(() => {});
    await p.waitForTimeout(600);
  };

  await go('all');
  await p.screenshot({ path: path.join(ROOT, 'tools', '_out', '_v392_rdc_none.png'), fullPage: false });

  await go('东北RDC');
  await p.screenshot({ path: path.join(ROOT, 'tools', '_out', '_v392_rdc_db.png'), fullPage: false });

  // 只截筛选栏（定位含「个 SKU×RDC」的那个 span 的父容器）
  const barBox = await p.evaluate(() => {
    const span = Array.from(document.querySelectorAll('#page-shortage span')).find(s => /个 SKU×RDC/.test(s.innerText || ''));
    const el = span && span.parentElement;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(1500, r.width + 16), height: r.height + 16 };
  });
  if (barBox) {
    await p.screenshot({ path: path.join(ROOT, 'tools', '_out', '_v392_bar_db.png'), clip: barBox });
    console.log('筛选栏截图区域:', JSON.stringify(barBox));
  } else {
    console.log('⚠️ 未定位到筛选栏容器');
  }
  console.log('截图完成: _v392_rdc_none.png / _v392_rdc_db.png / _v392_bar_db.png');
  await b.close(); server.close();
})().catch(e => { console.error('异常:', e && e.message || e); process.exit(1); });
