// 「大仓直发」并入口径的**运行态**探针（v359 建立，v360 改写验证目标）。
//
// 为什么必须用运行态探针：离线 `require('./data.json')` 复算看不出「按月分片吞行」「消费端是否真的取值」
// 这类问题（v359 踩过：离线 174 行全在，运行态只剩 16 行）。静态检查 / smoke / e2e 只看 pageerror，一律无感。
//
// v360 口径（用户 2026-09-18 二次裁定）：
//   · 分仓计划监控 → **含**直发（订单量 / 完成率 / MTD 曲线；「都不剔除，都要算的」）
//   · 每日补货建议 → **不含**直发（满足率 / 近60天日均 / 建议补货量；「不计入订单满足率统计计算」）
// 本探针两件事都要验：监控侧并入量自洽 + 补货建议侧确实排除了直发。
//
// 用法：node tools/probe-dirship.cjs   → 输出 _v360_probe.txt
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8919;
const OUT = ROOT + '/_v360_probe.txt';
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'application/javascript' };
const server = http.createServer((req, res) => {
  const fp = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
const out = []; const P = (...a) => out.push(a.join(' '));
const HARD = setTimeout(() => { console.error('硬超时'); fs.writeFileSync(OUT, out.join('\n'), 'utf8'); process.exit(3); }, 420000);

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  await page.route('**/echarts.min.js', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(__dirname, '.cdn-cache', 'echarts.min.js')) }));
  await page.route('**/xlsx.full.min.js', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(__dirname, '.cdn-cache', 'xlsx.full.min.js')) }));

  const errs = [];
  page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message.slice(0, 200)));
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || /大仓直发/.test(t)) errs.push('[' + m.type() + '] ' + t.slice(0, 240)); });

  await page.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 60; i++) {
    const ok = await page.evaluate(() => typeof dataStore !== 'undefined' && dataStore.loaded === true && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100 && (dataStore.orderDetail || []).length > 100000).catch(() => false);
    if (ok) break;
    await page.waitForTimeout(2000);
  }
  P('=== 数据就绪检查 ===');
  const base = await page.evaluate(() => ({
    build: typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : null,
    db: typeof DB_VERSION !== 'undefined' ? DB_VERSION : null,
    dsRows: (dataStore.directShip || []).length,
    parseStat: window._dsParseStat || null,
    ordRows: (dataStore.orderDetail || []).length,
    unrelRows: (dataStore.unreleasedOrders || []).length,
    boxSpecLen: window._boxSpec ? Object.keys(window._boxSpec).length : 0,
  }));
  P(JSON.stringify(base, null, 1));

  // 前导零 / 箱规自证
  const spec = await page.evaluate(() => {
    const ds = dataStore.directShip || [];
    const zero = ds.filter(d => /^0/.test(d.skuCode));
    const miss = ds.filter(d => !(window._boxSpec && window._boxSpec[d.skuCode] > 0));
    return { zeroCnt: zero.length, missSpecCnt: miss.length,
      sample: zero.slice(0, 3).map(d => ({ raw: d.skuCode, norm: d.sku, specRaw: (window._boxSpec || {})[d.skuCode] || 0, specNorm: (window._boxSpec || {})[d.sku] || 0 })) };
  });
  P('');
  P('=== 前导零 / 箱规 ===');
  P(JSON.stringify(spec, null, 1));

  // ---- 分仓计划监控（应**含**直发）----
  await page.evaluate(() => { try { navigateTo('plan-monitor'); } catch (e) {} });
  await page.waitForTimeout(7000);
  const pm = await page.evaluate(() => {
    const st = window._planMonitorDsStat || null;
    const el = document.getElementById('page-plan-monitor');
    const txt = el ? (el.textContent || '') : '';
    const keys = st ? Object.keys(st.byKey) : [];
    const sum = st ? keys.reduce((s, k) => s + st.byKey[k], 0) : 0;
    const sumRdc = st ? Object.values(st.byRdc).reduce((s, v) => s + v, 0) : 0;
    const cellHits = el ? el.querySelectorAll('td.num div').length : 0;
    const hitTexts = el ? Array.from(el.querySelectorAll('td.num div')).map(d => (d.textContent || '').trim()).filter(t => /^\+\u76f4\u53d1/.test(t)) : [];
    return {
      month: window._planSkuAggMonth || null,
      dsStat: st ? { cnt: st.cnt, rows: st.rows, qty: st.qty, byKeySum: sum, byRdcSum: sumRdc, rdc: st.byRdc } : null,
      invariantOK: st ? (Math.abs(sum - st.qty) < 1e-6 && Math.abs(sumRdc - st.qty) < 1e-6) : null,
      chipShown: /本目标月大仓直发/.test(txt),
      chipSnippet: (txt.match(/本目标月大仓直发[^\n]{0,80}/) || [''])[0],
      kpiLabel: (txt.match(/整体计划完成率[^%]{0,40}/) || [''])[0],
      dsCellHits: hitTexts.length,
      dsCellSamples: hitTexts.slice(0, 5),
      numDivTotal: cellHits,
    };
  });
  P('');
  P('=== 分仓计划监控（运行态 · 期望含直发）===');
  P(JSON.stringify(pm, null, 1));

  // ---- 表格行内「+直发 N」标注 ----
  await page.evaluate(() => { try { window._pmSkuSort = 'qty-desc'; window._pmSkuStatus = 'all'; window._pmSkuPage = 1; renderPlanMonitor(); } catch (e) {} });
  await page.waitForTimeout(3000);
  const cellCheck = await page.evaluate(() => {
    const tbl = document.getElementById('pm-sku-detail-table');
    if (!tbl) return { err: '表格未渲染' };
    const trs = Array.from(tbl.querySelectorAll('tbody tr'));
    const parsed = trs.map(tr => {
      const tds = Array.from(tr.querySelectorAll('td'));
      const orderTd = tds[5];
      const divs = orderTd ? Array.from(orderTd.querySelectorAll('div')).map(d => (d.textContent || '').trim()) : [];
      return { sku: (tds[0] || {}).textContent ? tds[0].textContent.trim() : '', rdc: (tds[3] || {}).textContent ? tds[3].textContent.trim() : '', orderText: (orderTd || {}).textContent ? orderTd.textContent.trim() : '', dsDiv: divs.filter(t => t.indexOf('直发') >= 0) };
    });
    const hits = parsed.filter(x => x.dsDiv.length);
    const st = window._planMonitorDsStat || { byKey: {} };
    const rendered = new Set(parsed.map(x => (x.sku || '') + '|' + (x.rdc || '')));
    const keys = Object.keys(st.byKey || {});
    const keyOnPage = keys.filter(k => rendered.has(k));
    return { renderedRows: parsed.length, hits: hits.length, hitRows: hits.slice(0, 8),
      dsKeysTotal: keys.length, dsKeyOnPage: keyOnPage, dsKeyOnPageQty: keyOnPage.map(k => k + '=' + st.byKey[k]) };
  });
  P('');
  P('=== 订单量列「+直发 N」标注（DOM 实测，按订单量降序）===');
  P(JSON.stringify(cellCheck, null, 1));

  // ---- 逐月直发并入量 ----
  const opts = await page.evaluate(() => {
    const el = document.getElementById('page-plan-monitor');
    if (!el) return { found: false, options: [] };
    const sels = Array.from(el.querySelectorAll('select'));
    for (const s of sels) {
      const os = Array.from(s.options);
      if (os.some(o => /月/.test(o.textContent || '')) && os.length >= 5) {
        return { found: true, current: s.value, options: os.map(o => ({ v: o.value, t: (o.textContent || '').trim() })) };
      }
    }
    return { found: false, options: [] };
  });
  P('');
  P('=== 月份下拉 ===');
  P(JSON.stringify(opts, null, 1));

  const monthChecks = [];
  if (opts && opts.found) {
    for (const o of opts.options) {
      const r = await page.evaluate((idx) => {
        try { window._planMonthIdx = idx; renderPlanMonitor(); } catch (e) { return { err: String(e.message).slice(0, 120) }; }
        const st = window._planMonitorDsStat || { cnt: 0, rows: 0, qty: 0 };
        return { month: window._planSkuAggMonth || null, cnt: st.cnt, rows: st.rows, qty: st.qty };
      }, o.v);
      monthChecks.push({ opt: o.t, ...r });
    }
  }
  P('');
  P('=== 逐月直发并入量（运行态）===');
  monthChecks.forEach(m => P('  ' + m.opt + ' → month=' + m.month + ' 笔=' + m.cnt + ' 行=' + m.rows + ' 支=' + (m.qty || 0).toLocaleString() + (m.err ? ' ERR=' + m.err : '')));

  const dsAll = await page.evaluate(() => {
    const ds = dataStore.directShip || [];
    const byM = {};
    ds.forEach(d => { const m = String(d.dateStr || '').slice(0, 7); byM[m] = (byM[m] || 0) + 1; });
    return { rows: ds.length, byMonth: byM, parseStat: window._dsParseStat || null };
  });
  P('');
  P('=== dataStore.directShip 实况（运行态，应 174 行 / 4 个月）===');
  P(JSON.stringify(dsAll, null, 1));

  // ---- 每日补货建议（v360 重点：必须**不含**直发）----
  await page.evaluate(() => { try { navigateTo('replenishment'); } catch (e) {} });
  await page.waitForTimeout(6000);
  const rp = await page.evaluate(() => {
    const legacyFlag = typeof window._replDsDemand;   // 期望 'undefined'（v360 已删除该暴露点）
    const el = document.getElementById('page-replenishment');
    const txt = el ? (el.textContent || '') : '';
    const scored = window._replScored || [];
    const latest = window._replScoredDate || null;
    // 独立复算：与 renderReplenishment 同式（orderData = dataStore.orderDetail，60 天窗口）
    const calc = (function () {
      if (!latest) return null;
      const d0 = new Date(latest); d0.setDate(d0.getDate() - 60);
      const from = d0.toISOString().slice(0, 10);
      const analysisDays = Math.min(60, Math.ceil((new Date(latest) - d0) / 86400000));
      const _q = function (d) {
        const bq = d.boxQty || 0; if (!(bq > 0)) return 0;
        const bs = (window._boxSpec && window._boxSpec[d.skuCode]) || d.boxSpec || 0;
        return bs > 0 ? bq * bs : (d.orderQty || 0);
      };
      const byKey = {};
      (dataStore.directShip || []).forEach(function (x) {
        if (!x.dateStr || x.dateStr < from || x.dateStr > latest) return;
        const k = (x.skuCode || '') + '|' + x.rdc;
        byKey[k] = (byKey[k] || 0) + _q(x);
      });
      const topDs = Object.keys(byKey).sort(function (a, b) { return byKey[b] - byKey[a]; }).slice(0, 4);
      return { latest: latest, from: from, analysisDays: analysisDays, topDs: topDs.map(function (k) {
        const tot = (dataStore.orderDetail || []).filter(function (o) { return o.dateStr >= from && o.dateStr <= latest && (o.skuCode + '|' + o.warehouse) === k; }).reduce(function (s, o) { return s + o.orderQty; }, 0);
        return { key: k, dsQty: byKey[k], ordTotal: tot,
          dailyAvgOrd: +(tot / analysisDays).toFixed(1),
          dailyAvgWithDs: +((tot + byKey[k]) / analysisDays).toFixed(1) };
      }) };
    })();
    const pick = (calc ? calc.topDs.map(function (t) { return t.key; }) : []).map(function (k) {
      const c = scored.find(function (x) { return (x.materialCode + '|' + x.rdc) === k; });
      if (!c) return { key: k, scored: null };
      return { key: k, dailyAvg: +((c.dailyAvg || 0)).toFixed(1),
        fulfillRate: c.fulfillRate == null ? null : +(c.fulfillRate * 100).toFixed(1),
        suggestQty: c.suggestQty };
    });
    return { legacyFlag: legacyFlag, hasDsNote: /大仓直发/.test(txt),
      noteSnippet: (txt.match(/大仓直发[^\n]{0,130}/) || [''])[0], calc: calc, scoredRows: pick };
  });
  P('');
  P('=== 每日补货建议（运行态 · v360 期望：不含直发）===');
  P(JSON.stringify(rp, null, 1));

  // 硬判据：页面 dailyAvg 应等于「纯订单」口径，而不是「含直发」口径
  let verdict = '跳过（样本不足）';
  if (rp.calc && rp.scoredRows && rp.scoredRows.length) {
    const bad = [];
    rp.scoredRows.forEach(function (r) {
      if (r.scored === null || r.dailyAvg == null) return;
      const t = rp.calc.topDs.find(function (x) { return x.key === r.key; });
      if (!t) return;
      if (Math.abs(r.dailyAvg - t.dailyAvgOrd) > 1.5) {
        bad.push(r.key + ' 页面=' + r.dailyAvg + ' 纯订单=' + t.dailyAvgOrd + ' 含直发=' + t.dailyAvgWithDs);
      }
    });
    verdict = bad.length ? '❌ 仍未排除直发 → ' + bad.join(' ; ')
      : '✅ 页面「近60天日均」= 纯订单口径（不含直发）';
  }
  P('');
  P('=== v360 断言 ===');
  P(verdict);
  P('window._replDsDemand = ' + rp.legacyFlag + '  （期望 undefined，说明直发取值路径已删除）');
  P('页面是否仍出现「大仓直发」说明：' + rp.hasDsNote + '  → ' + rp.noteSnippet);

  P('');
  P('=== 相关 console（含 [大仓直发] 告警）===');
  P(errs.length ? errs.join('\n') : '(无)');

  fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
  clearTimeout(HARD);
  await browser.close(); server.close();
  console.log('probe done');
  process.exit(0);
})().catch((e) => { console.error('异常:', e.message); try { fs.writeFileSync(OUT, out.join('\n') + '\nEXC: ' + e.message, 'utf8'); } catch (_) {} clearTimeout(HARD); server.close(); process.exit(2); });
