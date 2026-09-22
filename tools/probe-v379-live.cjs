#!/usr/bin/env node
/**
 * v379 线上核验：直接打 https://rdc-dashboard.pages.dev
 *   1) 轮询版本（CDN 滞后，按 ?t= 破缓存 + 浏览器 UA）
 *   2) 真实浏览器：hover 日满足率曲线 → 弹窗里是否有「已拒绝」；长期清单是否有标注单元格；
 *      订单明细页口径说明是否已改写
 * 用法：NODE_PATH=".../node_modules" node tools/probe-v379-live.cjs
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const ROOT = path.resolve(__dirname, '..');
const URL_BASE = 'https://rdc-dashboard.pages.dev';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function getHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}
function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const c = [];
  for (const d of fs.readdirSync(base)) { c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(base, d, 'chrome-win64', 'chrome.exe')); }
  return c.find(p => fs.existsSync(p));
}

(async () => {
  const results = [];
  const check = (n, ok, d) => { results.push({ n, ok: !!ok, d: d == null ? '' : String(d) }); };

  // ---- 1) 轮询版本 ----
  let build = 0, tries = 0;
  while (tries < 24) {
    tries++;
    try {
      const r = await getHtml(URL_BASE + '/?t=' + Date.now() + '_' + tries);
      const m = r.body.match(/const BUILD_VERSION\s*=\s*(\d+)/);
      build = m ? Number(m[1]) : 0;
      if (build >= 379) break;
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 8000));
  }
  console.log('线上 BUILD_VERSION =', build, '（轮询 ' + tries + ' 次）');
  check('1 线上版本 >= 379', build >= 379, 'BUILD_VERSION=' + build);

  const chromium = require('playwright-core').chromium;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e && e.message ? e.message : String(e)));

  await page.goto(URL_BASE + '/?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 240000 }).catch(() => {});
  const ver = await page.evaluate(() => (typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : -1)).catch(() => -1);
  check('2 页面内版本 = 379', ver === 379, 'BUILD_VERSION=' + ver);

  // ---- 3) hover 日满足率曲线，抓弹窗 ----
  await page.evaluate(() => { try { navigateTo('overview'); } catch (e) {} });
  await page.waitForTimeout(3500);
  const box = await page.locator('#chart-trend').boundingBox();
  let tip = '';
  if (box) {
    const xs = await page.evaluate(() => {
      const dom = document.getElementById('chart-trend');
      const inst = echarts.getInstanceByDom(dom);
      if (!inst) return { labels: [], xs: [] };
      const n = (inst.getOption().xAxis[0].data || []).length;
      const out = [];
      for (let k = 0; k < n; k++) { const px = inst.convertToPixel({ xAxisIndex: 0 }, k); out.push(Array.isArray(px) ? px[0] : px); }
      return { labels: inst.getOption().xAxis[0].data || [], xs: out };
    });
    for (let k = xs.xs.length - 1; k >= 0 && tip.indexOf('已拒绝') < 0; k--) {
      await page.mouse.move(box.x + xs.xs[k], box.y + box.height * 0.45);
      await page.waitForTimeout(500);
      tip = await page.evaluate(() => { const el = document.querySelector('div[style*="min-width:380px"]'); return el ? el.innerText : ''; });
    }
    console.log('   弹窗文本片段 =', JSON.stringify(tip.replace(/\n/g, ' | ').slice(0, 260)));
  }
  check('3 hover 弹窗出现「已拒绝」标注', tip.indexOf('已拒绝') >= 0);
  check('4 弹窗仍显示 72187 302 箱（数字未变）', tip.indexOf('72187') >= 0 && tip.indexOf('302') >= 0);

  // ---- 5) 长期清单标注单元格 ----
  await page.evaluate(() => { try { navigateTo('shortage'); } catch (e) {} });
  await page.waitForTimeout(3000);
  let ltHit = null;
  for (let p = 1; p <= 12 && !ltHit; p++) {
    await page.evaluate(pp => { window._shortageTab = 'longterm'; window._ltPage = pp; try { renderShortage(); } catch (e) {} }, p);
    await page.waitForTimeout(1400);
    ltHit = await page.evaluate(() => {
      const el = document.querySelector('#page-shortage [title^="其中已拒绝"]');
      return el ? { title: el.getAttribute('title'), txt: (el.closest('td') || {}).innerText } : null;
    });
  }
  check('5 长期清单出现「已拒绝」悬停标注', !!ltHit, ltHit ? ltHit.txt + ' :: ' + String(ltHit.title).replace(/\n/g, ' | ').slice(0, 140) : '未找到');

  // ---- 6) 订单明细口径说明 ----
  await page.evaluate(() => { window._shortageTab = 'order-detail'; try { renderShortage(); } catch (e) {} });
  await page.waitForTimeout(3000);
  const t2 = await page.evaluate(() => (document.getElementById('page-shortage') || {}).innerText || '');
  check('6 口径说明已写「E 是 B 的组成部分」', t2.indexOf('E 是 B 的组成部分') >= 0);
  check('7 口径说明已写「拒绝仍计入满足率」', t2.indexOf('拒绝仍计入满足率') >= 0);
  check('8 旧文案「E 包含在 C 中」已消失', t2.indexOf('E 包含在 C 中') < 0);

  check('9 无 JS 运行时错误', errs.length === 0, errs.slice(0, 2).join(' / '));

  await browser.close();
  console.log('\n=========== v379 线上核验 ===========');
  let bad = 0;
  results.forEach(r => { console.log((r.ok ? '✅' : '❌') + ' ' + r.n + (r.d ? '  ' + r.d : '')); if (!r.ok) bad++; });
  console.log('-------------------------------------');
  console.log('通过 ' + (results.length - bad) + '/' + results.length);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('异常', e && e.message); process.exit(2); });
