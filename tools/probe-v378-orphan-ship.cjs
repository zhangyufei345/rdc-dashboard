#!/usr/bin/env node
/**
 * v378 探针：「有实际出货、但不在分仓计划键集里」的 SKU×仓 到底有多少、构成是什么。
 *
 * 背景：verify-v378 对账时发现 页面分子 5,388,957 vs demand.json 实际出货 5,389,829（差 872 支 / 0.016%）。
 *   分仓计划监控页的行是**由 分仓计划(planBySkuRdc) 驱动**的（分母口径），
 *   所以「分仓计划里根本没有这个 SKU×仓」的出货量天然进不了明细。
 *   本探针把差额拆出来，确认它是「口径必然」还是「key 格式 bug」。
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
    const pb = inv.planBySkuRdc || {};
    const sh = inv.actualShipBySkuRdc || {};
    // 页面键集（planBySkuRdc 的非 NaN 月值键，与 renderPlanMonitor 行驱动一致）
    const planKeys = new Set();
    Object.keys(pb).forEach(s => Object.keys(pb[s] || {}).forEach(r => {
      const v = Number(pb[s][r][M]); if (!isNaN(v)) planKeys.add(s + '|' + r);
    }));
    // 出货键集
    const shipKeys = new Set();
    Object.keys(sh).forEach(s => Object.keys(sh[s] || {}).forEach(r => {
      const v = sh[s][r][M]; if (v) shipKeys.add(s + '|' + r);
    }));
    const orphans = [...shipKeys].filter(k => !planKeys.has(k));
    const detail = orphans.map(k => {
      const p = k.split('|'); const s = p[0], r = p[1];
      const q = Number(sh[s][r][M]);
      const skuExists = !!pb[s];
      const rdcsOfSku = skuExists ? Object.keys(pb[s]) : [];
      const hasNormTwin = !!(pb[normSkuCode(s)]);
      return { key: k, qty: q, skuInPlan: skuExists, rdcInSku: rdcsOfSku, skuNormTwin: hasNormTwin, rdcs: rdcsOfSku.slice(0, 8) };
    }).sort((a, b) => b.qty - a.qty);
    return {
      planKeys: planKeys.size, shipKeys: shipKeys.size,
      orphanCnt: orphans.length, orphanQty: detail.reduce((a, x) => a + x.qty, 0),
      top: detail.slice(0, 12),
      skuMissingCnt: detail.filter(x => !x.skuInPlan).length,
      skuMissingQty: detail.filter(x => !x.skuInPlan).reduce((a, x) => a + x.qty, 0),
      rdcMissingCnt: detail.filter(x => x.skuInPlan).length,
      rdcMissingQty: detail.filter(x => x.skuInPlan).reduce((a, x) => a + x.qty, 0),
      normTwinCnt: detail.filter(x => x.skuNormTwin).length
    };
  });

  console.log('planBySkuRdc 2026-09 键数 =', out.planKeys, '｜实际出货键数 =', out.shipKeys);
  console.log('有出货无计划行 =', out.orphanCnt, '个键 /', Math.round(out.orphanQty).toLocaleString(), '支');
  console.log('  · SKU 完全不在分仓计划里 :', out.skuMissingCnt, '个 /', Math.round(out.skuMissingQty).toLocaleString(), '支');
  console.log('  · SKU 在、但该 RDC 不在计划里 :', out.rdcMissingCnt, '个 /', Math.round(out.rdcMissingQty).toLocaleString(), '支');
  console.log('  · 其中「去零码有孪生键」的 =', out.normTwinCnt, '个（>0 说明存在 key 口径可疑项）');
  console.log('\nTOP 明细：');
  out.top.forEach(x => console.log('  ' + x.key.padEnd(26) + ' ' + String(Math.round(x.qty)).padStart(9) + ' 支  skuInPlan=' + x.skuInPlan + '  skuNormTwin=' + x.skuNormTwin + '  该SKU计划里的RDC=' + JSON.stringify(x.rdcs)));

  await browser.close(); server.close();
})().catch(e => { console.error('异常:', e && e.message); process.exit(2); });
