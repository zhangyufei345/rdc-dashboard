// 度量：每日补货建议 改为「实际出货口径」（大仓直发并入）后的影响面
// 口径 A（现状）= orderDetail(已放行) 聚合的 orderQty / totalFulfillQty
// 口径 B（候选）= 口径 A + dataStore.directShip(大仓直发) 折支
// 用法：node tools/probe-repl-directship-impact.cjs
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript' };

function serve() {
  return new Promise(res => {
    const s = http.createServer((req, rq) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rq.writeHead(404); rq.end('nf'); return; }
      rq.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rq);
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}

(async () => {
  const srv = await serve();
  const port = srv.address().port;
  const exe = (() => {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    const cands = [];
    for (const d of fs.readdirSync(base)) {
      cands.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
      cands.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
    }
    return cands.find(p => fs.existsSync(p));
  })();
  if (!exe) throw new Error('未找到 chromium');
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console.error: ' + m.text()); });

  await page.goto(`http://127.0.0.1:${port}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 120000 });
  await page.evaluate(async () => { if (typeof ensureDemandMerged === 'function') await ensureDemandMerged(); });
  await page.waitForTimeout(2000);

  const out = await page.evaluate(() => {
    const orderData = dataStore.orderDetail || [];
    const dsRows = dataStore.directShip || [];

    // 与 renderReplenishment 相同的窗口：latestDate 取最新缺货日
    const shortData = dataStore.shortage || [];
    const allDates = shortData.map(d => d.dateStr).filter(Boolean).sort();
    const latestDate = allDates[allDates.length - 1];
    const t = new Date(latestDate); t.setDate(t.getDate() - 60);
    const sixtyStr = t.toISOString().slice(0, 10);
    const analysisDays = Math.min(60, Math.ceil((new Date(latestDate) - t) / 86400000));

    // ---- 口径 A：现状（orderDetail 已放行）----
    const dA = {};
    orderData.forEach(function (d) {
      if (d.dateStr < sixtyStr || d.dateStr > latestDate) return;
      const k = d.skuCode + '|' + d.warehouse;
      if (!dA[k]) dA[k] = { total: 0, fulfill: 0, dailyVals: {} };
      dA[k].total += d.orderQty;
      dA[k].fulfill += d.totalFulfillQty;
      dA[k].dailyVals[d.dateStr] = (dA[k].dailyVals[d.dateStr] || 0) + d.orderQty;
    });

    // ---- 口径 B：A + 大仓直发 ----
    const dB = {};
    Object.keys(dA).forEach(k => { dB[k] = { total: dA[k].total, fulfill: dA[k].fulfill, dailyVals: Object.assign({}, dA[k].dailyVals) }; });
    let dsUsedRows = 0, dsQtyTotal = 0, dsSkippedOutWindow = 0;
    dsRows.forEach(function (d) {
      if (!d.dateStr) return;
      if (d.dateStr < sixtyStr || d.dateStr > latestDate) { dsSkippedOutWindow++; return; }
      const k = String(d.skuCode) + '|' + d.rdc;
      const q = (typeof _dsQty === 'function') ? _dsQty(d) : (d.orderQty || 0);
      if (!dB[k]) dB[k] = { total: 0, fulfill: 0, dailyVals: {} };
      dB[k].total += q;
      // 直发是「已发货」，满足部分按同量计入（口径：卖了就算满足）
      dB[k].fulfill += q;
      dB[k].dailyVals[d.dateStr] = (dB[k].dailyVals[d.dateStr] || 0) + q;
      dsUsedRows++; dsQtyTotal += q;
    });

    // ---- 汇总对比 ----
    function agg(map) {
      let tot = 0, ful = 0, keys = 0, big = 0;
      Object.keys(map).forEach(k => { tot += map[k].total; ful += map[k].fulfill; keys++; if (map[k].total >= 200) big++; });
      return { keys, total: Math.round(tot), fulfill: Math.round(ful), rate: tot > 0 ? ful / tot : 0, big: big };
    }
    const A = agg(dA), B = agg(dB);

    // ---- 逐 SKU×RDC 满足率变化 Top（按需求量级）----
    const diffs = [];
    Object.keys(dB).forEach(function (k) {
      const a = dA[k] || { total: 0, fulfill: 0 };
      const b = dB[k];
      if (b.total < 200 || a.total <= 0) return;
      const ra = a.total > 0 ? a.fulfill / a.total : 0;
      const rb = b.total > 0 ? b.fulfill / b.total : 0;
      diffs.push({ k: k, A_total: Math.round(a.total), B_total: Math.round(b.total), A_rate: +(ra * 100).toFixed(1), B_rate: +(rb * 100).toFixed(1), d_rate: +((rb - ra) * 100).toFixed(1), d_total: Math.round(b.total - a.total) });
    });
    diffs.sort((x, y) => x.d_rate - y.d_rate);

    // directShip 总体规模
    let dsAllQty = 0; dsRows.forEach(d => { dsAllQty += (typeof _dsQty === 'function') ? _dsQty(d) : (d.orderQty || 0); });

    return {
      latestDate, sixtyStr, analysisDays,
      dsRowCount: dsRows.length,
      dsAllQty: Math.round(dsAllQty),
      dsUsedRows, dsQtyTotal: Math.round(dsQtyTotal), dsSkippedOutWindow,
      A, B,
      worst: diffs.slice(0, 12),
      nAffected: diffs.filter(d => d.d_rate < -0.1).length,
      nAffectedAny: diffs.filter(d => Math.abs(d.d_rate) > 0.01).length,
    };
  });

  console.log('=== 窗口 ===');
  console.log(`latestDate=${out.latestDate}  60天前=${out.sixtyStr}  analysisDays=${out.analysisDays}`);
  console.log('\n=== 大仓直发数据规模 ===');
  console.log(`dataStore.directShip 行数=${out.dsRowCount}  折支合计=${out.dsAllQty.toLocaleString()}`);
  console.log(`落在 60 天窗口内=${out.dsUsedRows} 行 / ${out.dsQtyTotal.toLocaleString()} 支   窗口外跳过=${out.dsSkippedOutWindow} 行`);

  console.log('\n=== 全量满足率 对比（口径A现状 vs 口径B并入直发）===');
  console.log(`  组合数   A=${out.A.keys}   B=${out.B.keys}`);
  console.log(`  需求量   A=${out.A.total.toLocaleString()}   B=${out.B.total.toLocaleString()}   (+${(out.B.total - out.A.total).toLocaleString()})`);
  console.log(`  满足量   A=${out.A.fulfill.toLocaleString()}   B=${out.B.fulfill.toLocaleString()}`);
  console.log(`  满足率   A=${(out.A.rate * 100).toFixed(2)}%   B=${(out.B.rate * 100).toFixed(2)}%   (${((out.B.rate - out.A.rate) * 100).toFixed(2)}pt)`);
  console.log(`  ≥200支组合数  A=${out.A.big}   B=${out.B.big}`);

  console.log('\n=== 受影响组合 ===');
  console.log(`  满足率下降 >10pt 的组合数 = ${out.nAffected}`);
  console.log(`  满足率有任何变化的组合数 = ${out.nAffectedAny}`);
  console.log('\n  下降最多的 12 个（sku|rdc）：');
  out.worst.forEach(d => console.log(`    ${d.k.padEnd(28)} 需求 ${String(d.A_total).padStart(8)}→${String(d.B_total).padStart(8)}  满足率 ${String(d.A_rate).padStart(5)}%→${String(d.B_rate).padStart(5)}%  (${d.d_rate}pt)`));

  console.log('\n运行时错误 ' + errs.length + ' 条');
  errs.slice(0, 10).forEach(e => console.log('  ❌ ' + e));

  await browser.close();
  srv.close();
  process.exit(0);
})();
