#!/usr/bin/env node
/**
 * v378 探针（2026-09-22 重写）：页面分子 vs demand.json 实际出货 的**逐键对拍**。
 *
 * 为什么重写：初版 probe-v378-orphan-ship.cjs 假设「页面明细行由 planBySkuRdc 驱动」，
 *   但实读 buildPlanSkuAgg() 发现行是 **cov7(覆盖表) 驱动 + planBySkuRdc 补充**
 *   （L17638 cov7.forEach → 建 sku|rdc 行；L17662 再补 cov7 未覆盖的计划键）。
 *   所以初版把「有出货无计划」的键算作不可见，结论框架错了（量级差 400 倍）。
 *
 * 本探针在**页面上下文里**直接对拍：
 *   源  = dataStore.inventory.actualShipBySkuRdc（demand.json）每个 (sku,rdc,月) 值
 *   页面 = window._planSkuAgg[normSkuCode(sku)+'|'+normalizeRdcName(rdc)].shipped
 * 对每个不等的键，标注它是否在 cov / planBySkuRdc 里 → 区分「口径必然」与「key bug」。
 *
 * 用法（项目根）：NODE_PATH=<node_modules> node tools/probe-v378-gap.cjs
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };

function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  for (const d of fs.readdirSync(base)) {
    for (const c of [['chrome-headless-shell-win64', 'chrome-headless-shell.exe'], ['chrome-win64', 'chrome.exe']]) {
      const p = path.join(base, d, c[0], c[1]);
      if (fs.existsSync(p)) return p;
    }
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

(async () => {
  const chromium = require('playwright-core').chromium;
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  page.on('pageerror', e => console.log('  [pageerror]', e.message));
  await page.goto('http://127.0.0.1:' + server.address().port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin'); await page.fill('#login-pass', 'admin123');
  await page.click('#login-page button');
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true && window._bootLoading === false, { timeout: 180000 });
  await page.evaluate(() => { window._planTab = 'monitor'; navigateTo('plan-monitor'); });
  await page.waitForFunction(() => (typeof _demandReady === 'function' ? _demandReady() : false), { timeout: 120000 });
  await page.waitForTimeout(1500);

  const out = await page.evaluate(() => {
    const M = '2026-09';
    const inv = dataStore.inventory || {};
    const sh = inv.actualShipBySkuRdc || {};
    const pb = inv.planBySkuRdc || {};
    const cov = inv.cov7 || inv.cov6 || inv.cov5 || [];
    const agg = window._planSkuAgg || (typeof buildPlanSkuAgg === 'function' ? buildPlanSkuAgg() : {});

    const covKeys = new Set();
    cov.forEach(d => { if (d && d.sku) covKeys.add(normSkuCode(d.sku) + '|' + normalizeRdcName(d.rdc)); });
    const pbKeys = new Set();
    Object.keys(pb).forEach(s => Object.keys(pb[s] || {}).forEach(r => {
      const v = Number(pb[s][r][M]); if (!isNaN(v)) pbKeys.add(normSkuCode(s) + '|' + normalizeRdcName(r));
    }));

    // 源侧：每个原始 (sku,rdc) 的出货 → 映射到页面键（可能多对一）
    const srcByKey = {};
    let srcTot = 0, srcKeyCnt = 0;
    const rawCollide = {};
    Object.keys(sh).forEach(s => Object.keys(sh[s] || {}).forEach(r => {
      const v = Number(sh[s][r][M]) || 0;
      if (!v) return;
      srcTot += v; srcKeyCnt++;
      const k = normSkuCode(s) + '|' + normalizeRdcName(r);
      if (!srcByKey[k]) srcByKey[k] = { qty: 0, raw: [] };
      srcByKey[k].qty += v;
      srcByKey[k].raw.push(s + '|' + r);
      rawCollide[k] = srcByKey[k].raw.length;
    }));

    let pageTot = 0;
    const miss = [];
    Object.keys(srcByKey).forEach(k => {
      const row = agg[k];
      const got = row ? (row.shipped || 0) : 0;
      pageTot += got;
      if (Math.abs(got - srcByKey[k].qty) > 0.5) {
        const p = k.split('|');
        miss.push({
          key: k,
          src: srcByKey[k].qty, page: got, raw: srcByKey[k].raw,
          inCov: covKeys.has(k), inPlan: pbKeys.has(k),
          aggPlan: row ? row.plan : null,
          skuInPlanTable: !!pb[p[0]]
        });
      }
    });
    miss.sort((a, b) => Math.abs(b.src - b.page) - Math.abs(a.src - a.page));

    // 页面里 shipped>0 的键数 & 零出货行
    let shipRows = 0, zeroRows = 0, aggShipTot = 0, aggPlanTot = 0;
    Object.keys(agg).forEach(k => {
      if (k.indexOf('|') < 0) return;      // 跳过 SKU 总览键
      const v = agg[k];
      aggShipTot += (v.shipped || 0);
      aggPlanTot += (v.plan || 0);
      if (v.shipped > 0) shipRows++; else zeroRows++;
    });

    const collision = Object.keys(rawCollide).filter(k => rawCollide[k] > 1);

    return {
      srcTot, srcKeyCnt, pageTot, aggShipTot, aggPlanTot, shipRows, zeroRows,
      missCnt: miss.length, missQty: miss.reduce((a, x) => a + (x.src - x.page), 0),
      missNotInCov: miss.filter(x => !x.inCov && !x.inPlan).length,
      missNotInCovQty: miss.filter(x => !x.inCov && !x.inPlan).reduce((a, x) => a + (x.src - x.page), 0),
      missInCovCnt: miss.filter(x => x.inCov).length,
      collisionCnt: collision.length, collision,
      top: miss.slice(0, 15)
    };
  });

  const n = v => Math.round(v).toLocaleString();
  console.log('=== 逐键对拍（2026-09）===');
  console.log('  源 actualShipBySkuRdc 非零原始键 ' + out.srcKeyCnt + ' 个 ｜ 合计 ' + n(out.srcTot) + ' 支');
  console.log('  页面 _planSkuAgg |键 shipped 合计 ' + n(out.aggShipTot) + ' 支（plan 合计 ' + n(out.aggPlanTot) + '）');
  console.log('  明细行：有出货 ' + out.shipRows + ' 行 ｜ 零出货 ' + out.zeroRows + ' 行');
  console.log('  差额 = 源 − 页面 = ' + n(out.srcTot - out.aggShipTot) + ' 支');
  console.log('');
  console.log('=== 不等键归因 ===');
  console.log('  不等键 ' + out.missCnt + ' 个 ｜ 合计差 ' + n(out.missQty) + ' 支');
  console.log('  · 该 sku|rdc 既不在 cov7 也不在 planBySkuRdc（行不存在 → 口径必然）: ' + out.missNotInCov + ' 个 / ' + n(out.missNotInCovQty) + ' 支');
  console.log('  · 该键在 cov7 里却仍不等（⚠️ 须排查 key/逻辑 bug）: ' + out.missInCovCnt + ' 个');
  console.log('  · 多原始键归一到同一页面键（去零碰撞嫌疑）: ' + out.collisionCnt + ' 个 ' + JSON.stringify(out.collision));
  console.log('');
  console.log('=== 差异 Top（按差额）===');
  out.top.forEach(x => console.log('  ' + x.key.padEnd(24) + ' 源 ' + String(n(x.src)).padStart(9) + ' → 页面 ' + String(n(x.page)).padStart(9) +
    '  在cov7=' + x.inCov + ' 在计划=' + x.inPlan + ' 该键计划量=' + x.aggPlan + '  原始键=' + JSON.stringify(x.raw)));

  await browser.close(); server.close();
})().catch(e => { console.error('异常:', e && e.message); process.exit(2); });
