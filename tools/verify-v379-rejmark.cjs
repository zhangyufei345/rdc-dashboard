#!/usr/bin/env node
/**
 * v379 门控： 「已拒绝」展示标注（**口径不变，只加展示提示**）
 *
 * 用户 2026-09-22 裁定：「打标拒绝原因还是要算入订单满足公式的，因为拒绝了也是未满足。
 *   只不过这些订单不会再有履约的机会了，因此最好在展示的时候有标注提醒已拒绝」
 * → 本脚本同时钉两件事：
 *   A. **数字不能被改动**（回归）：含拒绝的组合，其 shortQty / totalShort 必须与源数据复算逐键一致；
 *   B. **标注必须真的挂上**（新功能）：数据层 rejQty/totalRej/rejUnits 有值、辅助函数行为正确、
 *      ③ 订单缺货明细分析页口径说明文案已改写。
 *
 * 断言纪律（照 skill）：
 *   - 版本用 >=；② 不硬编码「会随时间增长的量」（9 月未结束，组合数/行数只会变多）→ 用 >=1；
 *   - ② 层断言读**页面同源数据入口**（getMonthlyShortageProfile / buildLongTermProfile），不在 DOM 里搜 SKU 行；
 *   - 导航前必须等 window._bootLoading === false（handleLogin 收尾会强制 navigateTo('overview')，否则被抢回总览）。
 *
 * 用法（项目根执行）：
 *   NODE_PATH=".../binaries/node/workspace/node_modules" node tools/verify-v379-rejmark.cjs
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

/* ---------- 离线复算（源 = data.json「订单明细」） ---------- */
function offlineRecompute() {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
  const bs = j.boxSpecMap || {};
  const rows = j.sheets['订单明细'], H = rows[0], I = n => H.indexOf(n);
  const C = { d: I('SAP放行日期'), o: I('销售单号'), ch: I('主渠道'), sku: I('SKU编码'), rj: I('订单拒绝原因'), wh: I('仓库名称'), fq: I('首日缺货量') };
  const nd = v => { if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10); const m = String(v || '').match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/); return m ? m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0') : String(v || ''); };
  const n = v => { const x = Number(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(x) ? x : 0; };
  const out = { day: {}, mon: {}, total: 0, totalRej: 0 };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || !r[C.sku]) continue;
    const sku = String(r[C.sku]).trim(), ds = nd(r[C.d]), ch = String(r[C.ch] || '').trim();
    const wh = String(r[C.wh] || '').trim(), fsq = n(r[C.fq]);
    const rej = r[C.rj] && String(r[C.rj]).trim() !== '';
    out.total += fsq; if (rej) out.totalRej += fsq;
    if (ds === '2026-09-21' && ch === 'KA') {
      const k = sku; out.day[k] = out.day[k] || { u: 0, r: 0, orders: new Set() };
      out.day[k].u += fsq; if (rej) { out.day[k].r += fsq; out.day[k].orders.add(String(r[C.o] || '').trim()); }
    }
    if (ds.slice(0, 7) === '2026-09' && wh === '华南RDC' && sku === '72187') {
      out.mon.detail = out.mon.detail || { u: 0, r: 0 };
      out.mon.detail.u += fsq; if (rej) out.mon.detail.r += fsq;
    }
  }
  out.box = c => { const b = bs[c]; return b > 0 ? b : null; };
  return out;
}

(async () => {
  let chromium;
  try { chromium = require('playwright-core').chromium; }
  catch (e) { console.error('需要 playwright-core：设置 NODE_PATH'); process.exit(2); }

  const OFF = offlineRecompute();
  const src = fs.readFileSync(path.join(ROOT, 'rdc-dashboard.html'), 'utf8');
  const build = Number((src.match(/const BUILD_VERSION\s*=\s*(\d+)/) || [])[1]);

  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e && e.message ? e.message : String(e)));

  const results = [];
  const check = (name, cond, detail) => { results.push({ name, ok: !!cond, detail: detail == null ? '' : String(detail) }); };

  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 180000 }).catch(() => {});
  const loaded = await page.evaluate(() => !!(typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true));
  console.log('数据装载:', loaded ? 'OK' : '失败');

  /* ===== A. 版本 ===== */
  check('A1 BUILD_VERSION >= 379', build >= 379, 'BUILD_VERSION=' + build);

  /* ===== B. 辅助函数（纯函数语义） ===== */
  const helper = await page.evaluate(() => {
    const r = {};
    r.hasIs = typeof window.isRejectedOrder === 'function';
    r.hasCell = typeof window.rejMarkCell === 'function';
    if (!r.hasIs || !r.hasCell) return r;
    r.noRej = window.rejMarkCell('100', 0, null, 100);
    r.hasRej = window.rejMarkCell('100', 30, 20, 100);
    r.isT = window.isRejectedOrder({ rejectReason: '10-不合理请求' });
    r.isBlank = window.isRejectedOrder({ rejectReason: '   ' });
    r.isNone = window.isRejectedOrder({});
    r.isNull = window.isRejectedOrder(null);
    return r;
  });
  check('B1 isRejectedOrder / rejMarkCell 已暴露', helper.hasIs && helper.hasCell);
  check('B2 无拒绝时原样返回（不加任何标记）', helper.noRej === '100', JSON.stringify(helper.noRej));
  check('B3 含拒绝时挂标注 + 箱数 + 占比',
    helper.hasRej && helper.hasRej.indexOf('其中已拒绝 30 支') >= 0 && helper.hasRej.indexOf('（2 箱）') >= 0
    && helper.hasRej.indexOf('占本行缺货 30%') >= 0 && helper.hasRej.indexOf('border-bottom:1px dashed') >= 0,
    helper.hasRej ? helper.hasRej.slice(0, 90) : 'n/a');
  check('B4 判据：非空即拒绝 / 空白不算 / 缺字段与 null 安全',
    helper.isT === true && helper.isBlank === false && helper.isNone === false && helper.isNull === false,
    JSON.stringify([helper.isT, helper.isBlank, helper.isNone, helper.isNull]));

  /* ===== C. ① 日满足率 hover「未清箱数 TOP3」===== */
  const day = await page.evaluate(() => {
    const r = {};
    try {
      const t = getTopShortageSKUsByDay('all', '2026-09-21', 3, 'KA');
      r.top = (t || []).map(x => ({ sku: x.materialCode, units: x.units, boxes: x.boxes, rejUnits: x.rejUnits, rejBoxes: x.rejBoxes, rejOrderCnt: x.rejOrderCnt, rejReason: x.rejReason }));
    } catch (e) { r.err = e.message; }
    return r;
  });
  const t0 = (day.top || [])[0] || {};
  const off0 = OFF.day[t0.sku] || { u: 0, r: 0, orders: new Set() };
  check('C1 getTopShortageSKUsByDay 可调用', !day.err, day.err || 'ok');
  check('C2 9/21 KA TOP1 = 72187', t0.sku === '72187', JSON.stringify(t0.sku));
  check('C3 TOP1 未清支数与源复算一致（**口径未被改动**）', t0.units === off0.u, '页面=' + t0.units + ' 源=' + off0.u);
  check('C4 TOP1 已拒绝支数与源复算一致', t0.rejUnits === off0.r, '页面=' + t0.rejUnits + ' 源=' + off0.r);
  const bs72187 = OFF.box('72187');
  check('C5 已拒绝箱数 = ceil(支数/箱规)', bs72187 && t0.rejBoxes === Math.ceil(off0.r / bs72187), 'rejBoxes=' + t0.rejBoxes + ' 箱规=' + bs72187);
  check('C6 已拒绝涉及单数 = 源去重单数', t0.rejOrderCnt === off0.orders.size, '页面=' + t0.rejOrderCnt + ' 源=' + off0.orders.size);
  check('C7 非拒绝 SKU 不产生标注数据（TOP2/3 rejUnits=0）', (day.top || []).slice(1).every(x => !x.rejUnits), JSON.stringify((day.top || []).slice(1).map(x => [x.sku, x.rejUnits])));

  /* ===== D. ② 缺货分析清单数据入口（不搜 DOM SKU 行） ===== */
  const prof = await page.evaluate(() => {
    const out = {};
    try {
      const p = getMonthlyShortageProfile();
      const list = (p && p.list) || [];
      out.withRej = list.filter(x => (x.rejQty || 0) > 0).length;
      const hit = list.find(x => x.sku === '72187' && x.rdc === '华南RDC' && x.month === '2026-09');
      out.hit = hit ? { shortQty: hit.shortQty, rejQty: hit.rejQty, rejBoxes: hit.rejBoxes, rejOrderCnt: hit.rejOrderCnt, mr: hit.mr, boxSpec: hit.boxSpec } : null;
    } catch (e) { out.err = e.message; }
    return out;
  });
  check('D1 月度画像可读且已含 rejQty 字段', !prof.err, prof.err || 'ok');
  check('D2 9 月存在含拒绝的 SKU×RDC 组合（>=1）', (prof.withRej || 0) >= 1, '含拒绝组合数=' + prof.withRej);
  check('D3 72187×华南RDC×2026-09 命中', !!prof.hit, JSON.stringify(prof.hit));
  if (prof.hit) {
    const expectU = OFF.mon.detail ? OFF.mon.detail.u : -1;
    const expectR = OFF.mon.detail ? OFF.mon.detail.r : -1;
    check('D4 shortQty 与源复算一致（**未被扣减**）', prof.hit.shortQty === expectU, '页面=' + prof.hit.shortQty + ' 源=' + expectU);
    check('D5 rejQty 与源复算一致', prof.hit.rejQty === expectR, '页面=' + prof.hit.rejQty + ' 源=' + expectR);
    check('D6 rejBoxes = round(rejQty/boxSpec)', prof.hit.rejBoxes === Math.round(expectR / (prof.hit.boxSpec || 1)), 'rejBoxes=' + prof.hit.rejBoxes + ' boxSpec=' + prof.hit.boxSpec);
  } else { check('D4 shortQty 与源复算一致（**未被扣减**）', false, '无命中记录'); }

  const lt = await page.evaluate(() => {
    const out = {};
    try {
      const a = (typeof buildLongTermProfile === 'function') ? buildLongTermProfile() : null;
      const b = (typeof buildLongTermProfileByRdc === 'function') ? buildLongTermProfileByRdc() : null;
      out.aHas = a ? Object.keys(a.bySku || {}).some(k => (a.bySku[k].totalRej || 0) > 0) : null;
      out.bHas = b ? Object.keys(b.byKey || {}).some(k => (b.byKey[k].totalRej || 0) > 0) : null;
      out.aSum = a ? Object.keys(a.bySku || {}).reduce((s, k) => s + (a.bySku[k].totalRej || 0), 0) : -1;
      out.bSum = b ? Object.keys(b.byKey || {}).reduce((s, k) => s + (b.byKey[k].totalRej || 0), 0) : -1;
      out.aShortSum = a ? Object.keys(a.bySku || {}).reduce((s, k) => s + (a.bySku[k].totalShort || 0), 0) : -1;
      // 同源对照：页面内 dataStore.orderDetail 里通过长期口径过滤（工作日 + 非华东）的拒绝首日缺货合计
      //   ⚠️ 必须用页面自己加载的全量 orderDetail（含各月分片），不能用 data.json —— 后者只含当月。
      var tot = 0, rejAll = 0, ms = {};
      (dataStore.orderDetail || []).forEach(function (d) {
        if (!d || !d.dateStr || !d.skuCode || !d.warehouse) return;
        if (!isWorkday(d.dateStr)) return;
        if (normalizeRdcName(d.warehouse) === '华东RDC') return;
        ms[d.dateStr.slice(0, 7)] = 1;
        tot += (d.firstDayShort || 0);
        if (isRejectedOrder(d)) rejAll += (d.firstDayShort || 0);
      });
      out.pageShort = tot; out.pageRej = rejAll;
      out.months = Object.keys(ms).sort(); out.rows = (dataStore.orderDetail || []).length;
    } catch (e) { out.err = e.message; }
    return out;
  });
  check('D7 长期画像(SKU 层)已含 totalRej 且有值', !lt.err && lt.aHas === true, lt.err || ('totalRej 合计=' + lt.aSum));
  check('D8 长期画像(按RDC)已含 totalRej 且有值', lt.bHas === true, 'totalRej 合计=' + lt.bSum);
  check('D9 长期 totalRej ≤ 同源 totalShort（子集关系，未被放大）', lt.aSum >= 0 && lt.pageShort > 0 && lt.aSum <= lt.pageShort, 'totalRej=' + lt.aSum + ' 同源 totalShort=' + lt.pageShort);
  check('D10 长期 totalRej ≤ 同源拒绝合计（未重复计入）', lt.pageRej > 0 && lt.aSum <= lt.pageRej,
    '长期=' + lt.aSum + ' 同源=' + lt.pageRej + '（orderDetail ' + lt.rows + ' 行，月份 ' + (lt.months || []).join(',') + '）');
  check('D11 两视图(SKU 层 / 按 RDC)拒绝合计一致', lt.aSum >= 0 && lt.aSum === lt.bSum, lt.aSum + ' vs ' + lt.bSum);

  /* ===== E. ③ 订单缺货明细分析页文案（静态、确定性） ===== */
  await page.evaluate(() => { try { navigateTo('shortage'); } catch (e) {} });
  await page.waitForTimeout(2000);
  const txt = await page.evaluate(() => {
    const el = document.getElementById('page-shortage');
    return el ? el.innerText : '';
  });
  const html = await page.evaluate(() => {
    const el = document.getElementById('page-shortage');
    return el ? el.innerHTML : '';
  });
  check('E1 口径说明已明确「E 是 B 的组成部分」', txt.indexOf('E 是 B 的组成部分') >= 0);
  check('E2 口径说明已写明「拒绝仍计入满足率」', txt.indexOf('拒绝仍计入满足率') >= 0);
  check('E3 口径说明不再出现旧的「E 包含在 C 中」', txt.indexOf('E 包含在 C 中') < 0);
  check('E4 E 列表头带悬停说明', html.indexOf('title="E 拒绝（删单）') >= 0);

  /* ===== F. 软报告：清单里实际渲染出的标注单元格数（不设门） ===== */
  let markCells = 0;
  for (const tab of ['monthly', 'longterm']) {
    await page.evaluate(t => { window._shortageTab = t; try { renderShortage(); } catch (e) {} }, tab);
    await page.waitForTimeout(1800);
    const n = await page.evaluate(() => {
      const el = document.getElementById('page-shortage');
      return el ? (el.innerHTML.match(/title="其中已拒绝/g) || []).length : 0;
    });
    console.log('   软报告 · ' + tab + ' 页当前渲染出的「已拒绝」标注单元格 = ' + n);
    markCells += n;
  }

  await browser.close();
  server.close();

  console.log('\n================ v379 门控结果 ================');
  let bad = 0;
  for (const r of results) {
    console.log((r.ok ? '✅' : '❌') + ' ' + r.name.padEnd(46) + (r.detail ? '  ' + r.detail : ''));
    if (!r.ok) bad++;
  }
  console.log('----------------------------------------------');
  console.log('通过 ' + (results.length - bad) + '/' + results.length + '；页签 JS 运行时错误 ' + errs.length + ' 个');
  if (errs.length) errs.slice(0, 5).forEach(e => console.log('   ERR: ' + e));
  process.exit(bad || errs.length ? 1 : 0);
})().catch(e => { console.error('工具异常:', e && e.message); process.exit(2); });
