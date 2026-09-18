// v359 运行态探针：确认「大仓直发」在真实浏览器里并入了分仓计划监控与每日补货建议。
// 用法：node tools/probe-v359-dirship.cjs
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8919;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'application/javascript' };
const server = http.createServer((req, res) => {
  const fp = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
const out = []; const P = (...a) => out.push(a.join(' '));
const HARD = setTimeout(() => { console.error('硬超时'); fs.writeFileSync(ROOT + '/_v359_probe.txt', out.join('\n'), 'utf8'); process.exit(3); }, 420000);

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

  // ---- 分仓计划监控 ----
  await page.evaluate(() => { try { navigateTo('plan-monitor'); } catch (e) {} });
  await page.waitForTimeout(4000);
  await page.waitForTimeout(3000);
  const pm = await page.evaluate(() => {
    const st = window._planMonitorDsStat || null;
    const el = document.getElementById('page-plan-monitor');
    const txt = el ? (el.textContent || '') : '';
    const keys = st ? Object.keys(st.byKey) : [];
    const sum = st ? keys.reduce((s, k) => s + st.byKey[k], 0) : 0;
    const sumRdc = st ? Object.values(st.byRdc).reduce((s, v) => s + v, 0) : 0;
    // 表体「+直发」出现次数（只统计表格区域，用 <td> 内的 div 判定）
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
  P('=== 分仓计划监控（运行态）===');
  P(JSON.stringify(pm, null, 1));

  // ---- 表格行内「+直发 N」标注（按订单量降序，确保直发大行在前）----
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


  const opts = await page.evaluate(() => {
    const el = document.getElementById('page-plan-monitor');
    if (!el) return [];
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
      // 逐个切月，记录该月的直发并入量（用 _planMonitorDsStat.qty，按 targetMonth 过滤）
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

  // 记录完整 directShip 行数与按月分布（验证未被吞）
  const dsAll = await page.evaluate(() => {
    const ds = dataStore.directShip || [];
    const byM = {};
    ds.forEach(d => { const m = String(d.dateStr || '').slice(0, 7); byM[m] = (byM[m] || 0) + 1; });
    return { rows: ds.length, byMonth: byM, parseStat: window._dsParseStat || null };
  });
  P('');
  P('=== dataStore.directShip 实况（运行态，应 174 行 / 4 个月）===');
  P(JSON.stringify(dsAll, null, 1));

  // ---- 每日补货建议 ----
  await page.evaluate(() => { try { navigateTo('replenishment'); } catch (e) {} });
  await page.waitForTimeout(5000);
  const rp = await page.evaluate(() => {
    const hit = window._replDsDemand || null;
    const el = document.getElementById('page-replenishment');
    const txt = el ? (el.textContent || '') : '';
    // 抽样：找表格首行，读日均与满足率列
    const rows = el ? Array.from(el.querySelectorAll('tbody tr')).slice(0, 3).map(tr => Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim()).slice(0, 12)) : [];
    return { dsDemand: hit, hasNote: /大仓直发/.test(txt), sampleRows: rows };
  });
  P('');
  P('=== 每日补货建议（运行态）===');
  P(JSON.stringify(rp, null, 1));

  P('');
  P('=== 相关 console（含 [大仓直发] 告警）===');
  P(errs.length ? errs.join('\n') : '(无)');

  fs.writeFileSync(ROOT + '/_v359_probe.txt', out.join('\n') + '\n', 'utf8');
  clearTimeout(HARD);
  await browser.close(); server.close();
  console.log('probe done');
  process.exit(0);
})().catch((e) => { console.error('异常:', e.message); try { fs.writeFileSync(ROOT + '/_v359_probe.txt', out.join('\n') + '\nEXC: ' + e.message, 'utf8'); } catch (_) {} clearTimeout(HARD); server.close(); process.exit(2); });
