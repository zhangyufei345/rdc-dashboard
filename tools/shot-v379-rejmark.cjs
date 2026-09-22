#!/usr/bin/env node
/**
 * v379 视觉验证：把「已拒绝」标注真实截出来（不是"应该能显示"，是"截到图"）
 * 产出：.cache/v379_tooltip.png（日满足率 hover 弹窗）/ v379_longterm_row.png（长期清单行）
 *        .cache/v379_od_caliber.png（订单缺货明细分析 口径说明）
 * 用法：NODE_PATH=".../node_modules" node tools/shot-v379-rejmark.cjs
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.cache');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const cands = [];
  for (const d of fs.readdirSync(base)) {
    cands.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    cands.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  return cands.find(p => fs.existsSync(p));
}
function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

(async () => {
  const chromium = require('playwright-core').chromium;
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 180000 }).catch(() => {});
  await page.evaluate(() => { try { navigateTo('overview'); } catch (e) {} });
  await page.waitForTimeout(3000);

  // ---- ① 日满足率趋势 hover 弹窗：用**真实鼠标悬停**（dispatchAction 实测弹不出弹窗） ----
  const box1 = await page.locator('#chart-trend').boundingBox();
  console.log('① 图表 bbox =', JSON.stringify(box1));
  let hit = { idx: -1, text: '' };
  let fallback = { idx: -1, text: '' };
  if (box1) {
    const xs = await page.evaluate(() => {
      const dom = document.getElementById('chart-trend');
      const inst = echarts.getInstanceByDom(dom);
      const n = (inst.getOption().xAxis[0].data || []).length;
      const out = [];
      for (let k = 0; k < n; k++) { const px = inst.convertToPixel({ xAxisIndex: 0 }, k); out.push(Array.isArray(px) ? px[0] : px); }
      return { labels: inst.getOption().xAxis[0].data || [], xs: out };
    });
    console.log('① 轴标签 =', JSON.stringify(xs.labels));
    for (let k = xs.xs.length - 1; k >= 0 && hit.idx < 0; k--) {
      const x = box1.x + xs.xs[k];
      await page.mouse.move(x, box1.y + box1.height * 0.45);
      await page.waitForTimeout(500);
      const t = await page.evaluate(() => {
        const tipDiv = document.querySelector('div[style*="min-width:380px"]');
        return tipDiv ? tipDiv.innerText : '';
      });
      if (t && t.indexOf('未清箱数') >= 0) {
        if (t.indexOf('已拒绝') >= 0) hit = { idx: k, label: xs.labels[k], text: t };
        else if (fallback.idx < 0) fallback = { idx: k, label: xs.labels[k], text: t };
      }
    }
    if (hit.idx < 0 && fallback.idx >= 0) {
      // 没有一天带拒绝 → 明确报告（不伪装成通过）；截图仍留作证据
      const k = fallback.idx;
      await page.mouse.move(box1.x + xs.xs[k], box1.y + box1.height * 0.45);
      await page.waitForTimeout(400);
      hit = fallback;
      console.log('   ⚠️ 该 7 天窗口内没有任何一天出现「已拒绝」（已确认不是渲染问题，弹窗本身正常）');
    }
    if (hit.idx >= 0) {
      await page.mouse.move(box1.x + xs.xs[hit.idx], box1.y + box1.height * 0.45);
      await page.waitForTimeout(600);
    }
  }
  console.log('① tooltip 命中 =', JSON.stringify(hit).slice(0, 700));
  await page.waitForTimeout(300);
  if (box1) {
    // 弹窗 min-width 380px，比 326px 宽的图表卡片还宽 → 会被挤到卡片右侧，必须按并集裁切
    const tb = await page.evaluate(() => {
      const el = document.querySelector('div[style*="min-width:380px"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const vp = page.viewportSize();
    const x1 = Math.max(0, box1.x - 10);
    const y1 = Math.max(0, Math.min(box1.y, tb ? tb.y : box1.y) - 10);
    const x2 = Math.min(vp.width, Math.max(box1.x + box1.width, tb ? tb.x + tb.w : 0) + 10);
    const y2 = Math.min(vp.height, Math.max(box1.y + box1.height, tb ? tb.y + tb.h : 0) + 10);
    console.log('① 弹窗 bbox =', JSON.stringify(tb));
    await page.screenshot({ path: path.join(OUT, 'v379_tooltip.png'), clip: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } });
    console.log('  已存 .cache/v379_tooltip.png (' + Math.round(x2 - x1) + 'x' + Math.round(y2 - y1) + ')');
  }

  // ---- ② 长期高严重度清单：翻页找到带标注的行并截图 ----
  await page.evaluate(() => { try { navigateTo('shortage'); } catch (e) {} });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { window._shortageTab = 'longterm'; try { renderShortage(); } catch (e) {} });
  await page.waitForTimeout(2000);
  let found = null;
  for (let p = 1; p <= 12 && !found; p++) {
    await page.evaluate(pp => { window._ltPage = pp; try { renderShortage(); } catch (e) {} }, p);
    await page.waitForTimeout(1200);
    const info = await page.evaluate(() => {
      const el = document.querySelector('#page-shortage [title^="其中已拒绝"]');
      if (!el) return null;
      const td = el.closest('td');
      const tr = el.closest('tr');
      const r = tr.getBoundingClientRect();
      return { page: window._ltPage, titleAttr: el.getAttribute('title'), tdText: td ? td.innerText.trim() : '', rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    });
    if (info) found = { p, ...info };
  }
  console.log('② 长期清单命中 =', JSON.stringify(found).slice(0, 600));
  if (found) {
    await page.evaluate(() => {
      const el = document.querySelector('#page-shortage [title^="其中已拒绝"]');
      if (el) { const r = el.closest('tr').getBoundingClientRect(); window.scrollBy(0, r.top - 220); }
    });
    await page.waitForTimeout(500);
    const r2 = await page.evaluate(() => { const el = document.querySelector('#page-shortage [title^="其中已拒绝"]'); const r = el.closest('tr').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await page.screenshot({ path: path.join(OUT, 'v379_longterm_row.png'), clip: { x: Math.max(0, r2.x - 4), y: Math.max(0, r2.y - 26), width: Math.min(1480, r2.w + 8), height: r2.h + 34 } });
    console.log('  已存 .cache/v379_longterm_row.png');
  }

  // ---- ③ 订单缺货明细分析：口径说明 + E 列 ----
  await page.evaluate(() => { window._shortageTab = 'order-detail'; window._odMonth = '2026-09'; try { renderShortage(); } catch (e) {} });
  await page.waitForTimeout(2500);
  const r3 = await page.evaluate(() => {
    const el = document.querySelector('#page-shortage [title^="E 拒绝（删单）"]');
    if (!el) return null;
    const tbl = el.closest('table');
    const wrap = tbl.parentElement;
    const r = wrap.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: Math.min(500, r.height), note: (document.getElementById('page-shortage').innerText.match(/关于 E（拒绝 \/ 删单）[\s\S]{0,200}/) || [''])[0] };
  });
  console.log('③ 订单明细命中 =', JSON.stringify(r3).slice(0, 500));
  if (r3) {
    await page.screenshot({ path: path.join(OUT, 'v379_od_caliber.png'), clip: { x: Math.max(0, r3.x - 4), y: Math.max(0, r3.y - 4), width: Math.min(1400, r3.w + 10), height: r3.h + 8 } });
    console.log('  已存 .cache/v379_od_caliber.png');
  }

  await browser.close();
  server.close();
  const ok = hit && hit.idx >= 0 && hit.text && hit.text.indexOf('已拒绝') >= 0 && found && r3;
  console.log(ok ? '\n视觉验证：三项均已截到（含「已拒绝」字样）' : '\n视觉验证：有项目未截到，请检查上面的 JSON');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('工具异常:', e && e.message); process.exit(2); });
