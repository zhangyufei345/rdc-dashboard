#!/usr/bin/env node
/**
 * 探针（不做硬断言、纯打印）：砍量冗余验证的「折算天数」分母口径对比
 *   旧口径 = 到货前 30 天日均出货（orderQty 口径，页面现行 avgDaily）
 *   新口径 = 未来日均需求（分仓计划 planBySkuRdc 优先 + 8月覆盖表 cov09~cov14 回退，与分仓计划监控同源）
 *   新口径试三种窗口：到货日起未来 30 / 60 / 90 天（月度需求按当月自然日线性摊平）
 *
 * 用法（项目根执行）：
 *   NODE_PATH=... node tools/probe-redund-demand.cjs > tools/_out/redund-demand.txt 2>&1
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const cands = [];
  for (const d of fs.readdirSync(base)) {
    cands.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    cands.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  const hit = cands.find(p => fs.existsSync(p));
  if (!hit) throw new Error('ms-playwright 下未找到 chromium');
  return hit;
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
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e && e.message ? e.message : String(e)));
  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 });
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 120000 }).catch(() => {});
  await page.evaluate(() => navigateTo('adjust-track'));
  // 分仓计划（planBySkuRdc）是未来需求的首要来源，adjust-track 页不会自动触发按需加载 → 显式拉起
  await page.evaluate(() => { if (window.ensureInventoryPlan) window.ensureInventoryPlan(); });
  await page.waitForFunction(() => window._invPlanReady === true && dataStore.inventory && dataStore.inventory.planBySkuRdc
    && Object.keys(dataStore.inventory.planBySkuRdc).length > 0, { timeout: 120000 })
    .then(() => console.log('分仓计划已就绪'))
    .catch(() => console.log('⚠ planBySkuRdc 加载超时（未来需求将全靠 cov 回退）'));
  await page.waitForTimeout(1500);

  const out = await page.evaluate(() => {
    const c = window.buildAdjComputed();
    const inv = dataStore.inventory || {};
    const pb = inv.planBySkuRdc || {};
    const cov7 = inv.cov7 || [];
    const covMap = {};
    cov7.forEach(d => { covMap[d.rdc + '|' + d.sku] = d; });
    const COVM = { '2026-09': 'cov09', '2026-10': 'cov10', '2026-11': 'cov11', '2026-12': 'cov12', '2027-01': 'cov13', '2027-02': 'cov14' };
    function monthDemand(sku, rdcFull, ym) {
      const p = pb[sku] && pb[sku][rdcFull] && pb[sku][rdcFull][ym];
      if (p != null && !isNaN(p) && p > 0) return { v: p, src: 'plan' };
      const d = covMap[rdcFull + '|' + sku];
      const f = COVM[ym];
      if (d && f) return { v: d[f] || 0, src: 'cov' };
      return { v: 0, src: 'miss' };
    }
    function monthDemandCov(sku, rdcFull, ym) {
      const d = covMap[rdcFull + '|' + sku];
      const f = COVM[ym];
      return (d && f) ? (d[f] || 0) : 0;
    }
    function dayDemand(sku, rdcFull, dayStr) {
      const ym = dayStr.slice(0, 7);
      const dim = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
      return monthDemand(sku, rdcFull, ym).v / dim;
    }
    function dayDemandCov(sku, rdcFull, dayStr) {
      const ym = dayStr.slice(0, 7);
      const dim = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
      return monthDemandCov(sku, rdcFull, ym) / dim;
    }
    function futureAvg(sku, rdcFull, fromDay, N) {
      let s = 0;
      for (let i = 0; i < N; i++) s += dayDemand(sku, rdcFull, _adjDateAdd(fromDay, i));
      return s / N;
    }
    function futureAvgCov(sku, rdcFull, fromDay, N) {
      let s = 0;
      for (let i = 0; i < N; i++) s += dayDemandCov(sku, rdcFull, _adjDateAdd(fromDay, i));
      return s / N;
    }
    const doneCuts = c.list.filter(r => r.cut > 0 && r.status === '已完成');
    const cd = doneCuts.filter(r => r.quadrant === 'C' || r.quadrant === 'D');
    const rows = cd.map(r => {
      const spec = r.spec || 1;
      const qty = r.cut * spec;                       // 支
      const a30 = futureAvg(r.sku, r.rdcFull, r.arrival, 30);
      const a60 = futureAvg(r.sku, r.rdcFull, r.arrival, 60);
      const a90 = futureAvg(r.sku, r.rdcFull, r.arrival, 90);
      const old = r.avgDaily;
      const src = monthDemand(r.sku, r.rdcFull, r.arrival.slice(0, 7)).src;
      return {
        date: r.date, rdc: r.rdc, sku: r.sku, name: r.skuName, type: r.adjType,
        cut: r.cut, spec: spec, qty: Math.round(qty),
        oldAvg: old, oldDays: r.redundantDays,
        d30: Math.round(qty / a30 * 10) / 10 * 1, // 保留一位
        d60: Math.round(qty / a60 * 10) / 10,
        d90: Math.round(qty / a90 * 10) / 10,
        a30: Math.round(a30 * 100) / 100, a60: Math.round(a60 * 100) / 100, a90: Math.round(a90 * 100) / 100,
        d90c: Math.round(qty / futureAvgCov(r.sku, r.rdcFull, r.arrival, 90) * 10) / 10,
        d30c: Math.round(qty / futureAvgCov(r.sku, r.rdcFull, r.arrival, 30) * 10) / 10,
        src: src,
        m09plan: (pb[r.sku] && pb[r.sku][r.rdcFull] && pb[r.sku][r.rdcFull]['2026-09']) || 0,
        m09cov: monthDemandCov(r.sku, r.rdcFull, '2026-09'),
        m10cov: monthDemandCov(r.sku, r.rdcFull, '2026-10'),
        m: {
          m09: monthDemand(r.sku, r.rdcFull, '2026-09').v,
          m10: monthDemand(r.sku, r.rdcFull, '2026-10').v,
          m11: monthDemand(r.sku, r.rdcFull, '2026-11').v,
          m12: monthDemand(r.sku, r.rdcFull, '2026-12').v
        }
      };
    });
    return { rows: rows, maxOrd: c.maxOrd, covCnt: cov7.length, pbCnt: Object.keys(pb).length, doneCuts: doneCuts.length };
  });
  await browser.close();
  server.close();

  const rows = out.rows;
  console.log('maxOrd =', out.maxOrd, '| cov7 行 =', out.covCnt, '| planBySkuRdc SKU =', out.pbCnt, '| 扣减且走完 =', out.doneCuts, '| 其中 C/D =', rows.length);
  console.log('页面运行时错误 =', errs.length ? errs.slice(0, 2) : '无');

  const fin = v => (v != null && isFinite(v));
  const avg = a => a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length * 10) / 10 : null;
  const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const n = b.length; return Math.round((n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) * 10) / 10; };

  const oldArr = rows.filter(r => fin(r.oldDays)).map(r => r.oldDays);
  const a30 = rows.filter(r => fin(r.d30) && r.d30 > 0 && isFinite(r.d30)).map(r => r.d30);
  const a60 = rows.filter(r => fin(r.d60) && r.d60 > 0 && isFinite(r.d60)).map(r => r.d60);
  const a90 = rows.filter(r => fin(r.d90) && r.d90 > 0 && isFinite(r.d90)).map(r => r.d90);
  const c30 = rows.filter(r => fin(r.d30c) && r.d30c > 0 && isFinite(r.d30c)).map(r => r.d30c);
  const c90 = rows.filter(r => fin(r.d90c) && r.d90c > 0 && isFinite(r.d90c)).map(r => r.d90c);
  console.log('\n=== 汇总（折算库存天数，C/D 记录）===');
  console.log('旧口径 近30天日均出货 : 可折算 ' + oldArr.length + ' 条 | 平均 ' + avg(oldArr) + ' 天 | 中位 ' + med(oldArr) + ' 天');
  console.log('新口径 未来30天需求   : 可折算 ' + a30.length + ' 条 | 平均 ' + avg(a30) + ' 天 | 中位 ' + med(a30) + ' 天');
  console.log('新口径 未来60天需求   : 可折算 ' + a60.length + ' 条 | 平均 ' + avg(a60) + ' 天 | 中位 ' + med(a60) + ' 天');
  console.log('新口径 未来90天需求   : 可折算 ' + a90.length + ' 条 | 平均 ' + avg(a90) + ' 天 | 中位 ' + med(a90) + ' 天');
  console.log('仅覆盖表(不含分仓计划)30天: 可折算 ' + c30.length + ' 条 | 平均 ' + avg(c30) + ' 天 | 中位 ' + med(c30) + ' 天');
  console.log('仅覆盖表(不含分仓计划)90天: 可折算 ' + c90.length + ' 条 | 平均 ' + avg(c90) + ' 天 | 中位 ' + med(c90) + ' 天');
  const noDemand = rows.filter(r => !(r.a90 > 0));
  console.log('未来需求为 0（无法折算）: ' + noDemand.length + ' 条 | 旧口径也没折算的: ' + rows.filter(r => !fin(r.oldDays)).length + ' 条');

  const srcCnt = {};
  rows.forEach(r => srcCnt[r.src] = (srcCnt[r.src] || 0) + 1);
  console.log('需求来源分布（按到货月取值）:', JSON.stringify(srcCnt));
  // 分仓计划 vs 覆盖表：9 月需求差异（两边都有值时才比）
  let cmpN = 0, cmpBig = 0, sumPlan = 0, sumCov = 0;
  rows.forEach(r => {
    if (r.m09plan > 0 && r.m09cov > 0) {
      cmpN++; sumPlan += r.m09plan; sumCov += r.m09cov;
      if (Math.abs(r.m09plan - r.m09cov) / Math.max(r.m09plan, r.m09cov) > 0.5) cmpBig++;
    }
  });
  console.log('9月需求 分仓计划 vs 覆盖表：可比 ' + cmpN + ' 条 | 计划合计 ' + Math.round(sumPlan) + ' / 覆盖表合计 ' + Math.round(sumCov) +
    ' | 差异>50% 的 ' + cmpBig + ' 条');
  let missPlan = 0, missCov10 = 0;
  rows.forEach(r => { if (!(r.m09plan > 0)) missPlan++; if (!(r.m10cov > 0)) missCov10++; });
  console.log('分仓计划缺 9 月的 ' + missPlan + ' 条 | 覆盖表缺 10 月的 ' + missCov10 + ' 条（10 月起只能靠覆盖表）');

  console.log('\n=== Top15（按旧口径冗余天数降序）===');
  console.log(['日期', 'RDC', 'SKU', '扣减(箱)', '箱规', '扣减(支)', '旧日均出', '旧天数', '计划9月', 'cov9月', '10月', '11月', '未来30d均', '30天', '60天', '90天', '纯cov90']
    .map((h, i) => h.padEnd(i < 3 ? 10 : 9)).join(''));
  rows.filter(r => fin(r.oldDays)).sort((a, b) => b.oldDays - a.oldDays).slice(0, 15).forEach(r => {
    console.log([r.date, r.rdc, r.sku, r.cut, r.spec, r.qty, r.oldAvg, r.oldDays,
      Math.round(r.m09plan), Math.round(r.m09cov), Math.round(r.m.m10), Math.round(r.m.m11), r.a30, r.d30, r.d60, r.d90, r.d90c]
      .map((v, i) => String(v == null ? '-' : v).padEnd(i < 3 ? 10 : 9)).join(''));
  });

  console.log('\n=== 未来需求 Top10（按 90 天口径降序）===');
  rows.slice().filter(r => fin(r.d90)).sort((a, b) => b.d90 - a.d90).slice(0, 10).forEach(r => {
    console.log([r.date, r.rdc, r.sku, r.cut, r.qty, r.oldAvg, r.oldDays, r.a30, r.d30, r.d60, r.d90, r.src]
      .map((v, i) => String(v == null ? '-' : v).padEnd(i < 3 ? 10 : 9)).join(''));
  });
})().catch(e => { console.error('探针异常:', e && e.stack || e); process.exit(2); });
