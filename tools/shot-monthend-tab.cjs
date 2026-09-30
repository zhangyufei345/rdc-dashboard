#!/usr/bin/env node
// v388 交付目视截图（线上，A 象限视图，整页）
const fs = require('fs'); const path = require('path');
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
(async () => {
  const { chromium } = require('playwright-core');
  const b = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  await p.goto((process.env.RDC_BASE || 'https://rdc-dashboard.pages.dev') + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.fill('#login-user', 'admin').catch(() => {});
  await p.fill('#login-pass', 'admin123').catch(() => {});
  await p.click('#login-page button').catch(() => {});
  await p.waitForFunction(() => window._bootLoading === false && typeof dataStore !== 'undefined' && dataStore.loaded === true, { timeout: 240000 });
  await p.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('shortage'); });
  await p.waitForTimeout(1000);
  await p.evaluate(() => {
    const btns = [...document.querySelectorAll('#page-shortage button')];
    const t = btns.find(x => (x.textContent || '').indexOf('月底压货商品分析') >= 0);
    if (t) t.click();
  });
  await p.waitForTimeout(3000);
  await p.evaluate(() => { window._meQuad = 'A'; window._mePage = 1; renderShortage(); });
  await p.waitForTimeout(2000);
  const out = path.join(ROOT, 'tools', '_out');
  fs.mkdirSync(out, { recursive: true });
  await p.screenshot({ path: path.join(out, '_me_final_full.png'), fullPage: true });
  const h = await p.evaluate(() => document.getElementById('page-shortage').scrollHeight);
  console.log('page height', h);
  await b.close();
})();
