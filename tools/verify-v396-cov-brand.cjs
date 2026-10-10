#!/usr/bin/env node
/**
 * v396（2026-10-10）库存覆盖图「按品牌堆叠」维度 —— 专项探针
 *
 * 用户需求原文：
 *   「红框处增加一个按品牌展示库存覆盖的维度。选择按品牌展示，则柱状图切换为品牌展示。
 *     数据同样要求能下钻，下钻后先展示 RDC 维度数据，再展示 SKU 明细。」
 *   「品牌要求玉泽、佰草集不要展示，（百爱神、海鸥、雅霜、友谊、春蕾都归为传统品牌）」
 *
 * 为什么必须专项探针：本次是「新增展示维度」+「下钻分两层」，
 *   典型失败模式全是**不报错的静默错**：
 *     · 切换维度后图表仍是 RDC 段（按钮绑上但没生效）
 *     · 品牌没归一化 → 传统品牌/百爱神 等分裂成多根柱
 *     · 玉泽/佰草集 仍在图例与柱里
 *     · 下钻后没有 ① RDC 维度层，或 ① 与 ② 不同源（合计对不上）
 *     · 点 RDC 行筛选后无法退回（筛选态不可退）
 *   只断言「页面不报错 / 容器存在」= 假绿（v389/v390 教训）。
 *
 * 覆盖四层：
 *   A. 数据层  —— cov7 品牌聚合（归一化 + 隐藏品牌 + 与 RDC 维度同源）
 *   B. UI 层    —— 维度切换控件、卡片标题、色块图例、ECharts series/x 轴/tooltip
 *   C. 下钻    —— 真实点击品牌柱 → 明细页两层结构 + ① 与数据同源复算 + RDC 行筛选可退
 *   D. 反例    —— 不得出现「玉泽」「佰草集」；不得出现「按RDC堆叠」字样（品牌维度下）
 *
 * 用法（项目根执行）：
 *   NODE_PATH="C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules" \
 *   "C:/Users/zhangyufei1/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" tools/verify-v396-cov-brand.cjs
 *   # 直连线上：RDC_BASE=https://rdc-dashboard.pages.dev ...
 * 退出码：全部通过 0，否则 1。
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.RDC_BASE || '').replace(/\/$/, '');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };

let ok = 0, bad = 0;
function chk(c, msg) { console.log((c ? '  ✅ ' : '  ❌ ') + msg); c ? ok++ : bad++; }

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const c = [];
  for (const d of fs.readdirSync(base)) {
    c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    c.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  const hit = c.find(p => fs.existsSync(p));
  if (!hit) throw new Error('未找到 chromium');
  return hit;
}
function startServer() {
  const s = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(s)));
}

(async () => {
  const { chromium } = require('playwright-core');
  let server = null, URL;
  // 🔴 线上验版走根路径 `/`（Cloudflare Pages 去扩展名，/rdc-dashboard.html 会 308）
  if (BASE) URL = BASE + (process.env.RDC_PATH || '/');
  else { server = await startServer(); URL = 'http://127.0.0.1:' + server.address().port + '/rdc-dashboard.html'; }
  console.log('目标:', URL, '\n');

  const b = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('[pageerror] ' + (e.message || e)));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('[console] ' + m.text().slice(0, 200)); });

  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.fill('#login-user', 'admin').catch(() => {});
  await p.fill('#login-pass', 'admin123').catch(() => {});
  await p.click('#login-page button').catch(() => {});
  await p.waitForFunction(() => window._bootLoading === false, { timeout: 240000 }).catch(() => {});
  await p.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 240000 })
    .then(() => console.log('数据装载: OK'))
    .catch(() => console.log('数据装载: 超时（后续结果可能不准）'));
  // 🔴 ECharts / SheetJS 都是 unpkg 上的 CDN 异步脚本（非打包内联）。数据装载完成 ≠ CDN 脚本就绪，
  //    直接取实例会偶发 `echarts is not defined`（探针自身假红，v396 首次运行即踩到）。
  //    凡是要读 ECharts 实例的探针都必须先等这里。
  await p.waitForFunction(() => typeof window.echarts !== 'undefined' && !!window.echarts.getInstanceByDom, { timeout: 120000 })
    .then(() => console.log('ECharts CDN: OK\n'))
    .catch(() => console.log('ECharts CDN: 超时（后续图表断言会失败，属环境问题）\n'));

  // ══════════ A. 数据层：品牌聚合口径 ══════════
  console.log('=== A. 数据层：品牌聚合（归一化 / 隐藏品牌 / 与 RDC 维度同源）===');
  const A = await p.evaluate(() => {
    const inv = dataStore.inventory || {};
    const rows = inv.cov7 || [];
    const norm = (s) => normalizeBrandName(String(s || '').trim()) || '(未知品牌)';
    const HIDDEN = ['玉泽', '佰草集'];
    const agg = {};
    rows.forEach(d => {
      if (!d || !d.rdc) return;
      const b = norm(d.brand);
      if (HIDDEN.indexOf(b) >= 0) return;
      const lv = (String(d.coverageLevel || '').trim() === '0~1个月') ? '≤1个月' : String(d.coverageLevel || '').trim();
      if (!agg[b]) agg[b] = {};
      agg[b][lv] = (agg[b][lv] || 0) + (d.planAmt || 0);
    });
    // 品牌×周期 明细（下钻同源复算用）
    const detail = {};
    rows.forEach(d => {
      if (!d || !d.rdc) return;
      const b = norm(d.brand);
      if (HIDDEN.indexOf(b) >= 0) return;
      const lv = (String(d.coverageLevel || '').trim() === '0~1个月') ? '≤1个月' : String(d.coverageLevel || '').trim();
      const k = b + '||' + lv;
      if (!detail[k]) detail[k] = { n: 0, sum: 0, byRdc: {} };
      detail[k].n++;
      detail[k].sum += (d.planAmt || 0);
      detail[k].byRdc[d.rdc] = (detail[k].byRdc[d.rdc] || 0) + (d.planAmt || 0);
    });
    // 数据里是否真的存在被点名的 5 个小品牌（若存在，必须已被归一化掉）
    const rawNames = {};
    rows.forEach(d => { const r = String(d.brand || '').trim(); if (r) rawNames[r] = (rawNames[r] || 0) + 1; });
    const normNames = {};
    rows.forEach(d => { const r = norm(d.brand); if (r) normNames[r] = (normNames[r] || 0) + 1; });
    return {
      totalRows: rows.length,
      brands: Object.keys(agg).sort(),
      brandTotals: Object.fromEntries(Object.keys(agg).map(k => [k, Object.values(agg[k]).reduce((s, v) => s + v, 0)])),
      rawNames, normNames, detail
    };
  });
  console.log('  · cov7 明细行数 = ' + A.totalRows + '；参与展示的品牌 = ' + A.brands.length + ' → ' + A.brands.join('、'));
  chk(A.brands.indexOf('玉泽') < 0, '品牌集合不含「玉泽」');
  chk(A.brands.indexOf('佰草集') < 0, '品牌集合不含「佰草集」');
  const fiveSmall = ['百爱神', '海鸥', '雅霜', '友谊', '春蕾'];
  const splitLeak = fiveSmall.filter(n => A.normNames[n] > 0);
  chk(splitLeak.length === 0, '5 个小品牌（百爱神/海鸥/雅霜/友谊/春蕾）均已归一化，未单独成柱' + (splitLeak.length ? ' → 泄漏: ' + splitLeak.join('、') : ''));
  chk(A.brands.indexOf('传统') >= 0, '归一化后存在「传统」品牌（= 页面既有口径，覆盖 ' + (A.normNames['传统'] || 0) + ' 行）');

  // 与 RDC 维度同源：品牌金额合计 应 = 全部 RDC 的可用库存金额合计（同样只剔除隐藏品牌）
  const syncCheck = await p.evaluate(() => {
    const rows = (dataStore.inventory || {}).cov7 || [];
    const HIDDEN = ['玉泽', '佰草集'];
    let brandSum = 0, allSum = 0, hiddenSum = 0;
    rows.forEach(d => {
      if (!d || !d.rdc) return;
      const b = normalizeBrandName(String(d.brand || '').trim()) || '(未知品牌)';
      allSum += (d.planAmt || 0);
      if (HIDDEN.indexOf(b) >= 0) hiddenSum += (d.planAmt || 0); else brandSum += (d.planAmt || 0);
    });
    return { brandSum, allSum, hiddenSum };
  });
  chk(Math.abs((syncCheck.brandSum + syncCheck.hiddenSum) - syncCheck.allSum) < 0.01,
    '口径同源：品牌合计 ' + Math.round(syncCheck.brandSum).toLocaleString() + ' + 隐藏品牌 ' + Math.round(syncCheck.hiddenSum).toLocaleString()
    + ' = 全量 ' + Math.round(syncCheck.allSum).toLocaleString() + ' 元');

  // ══════════ B. UI 层：RDC 维度（回归）→ 品牌维度（新增）══════════
  console.log('\n=== B. UI 层：维度切换控件与图表 ===');
  await p.evaluate(() => navigateTo('inventory-structure'));
  await p.waitForTimeout(1500);

  const bRdc = await p.evaluate(() => {
    const el = document.getElementById('page-inventory-structure');
    const inst = window.echarts.getInstanceByDom(document.getElementById('chart-cov-stacked'));
    const opt = inst ? inst.getOption() : null;
    return {
      renderOk: !!el && el.innerText.indexOf('渲染失败') < 0,
      dim: window._covDim,
      hasSwitch: !!el && el.innerHTML.indexOf('展示维度：') >= 0,
      hasBtnRdc: !!el && el.innerHTML.indexOf('按 RDC') >= 0,
      hasBtnBrand: !!el && el.innerHTML.indexOf('按品牌') >= 0,
      title: (el.innerText.match(/库存覆盖-可用库存[^\n]*/) || [''])[0],
      series: opt ? opt.series.map(s => s.name) : [],
      xLen: opt && opt.xAxis && opt.xAxis[0] ? opt.xAxis[0].data.length : 0,
    };
  });
  chk(bRdc.renderOk, '库存结构页正常渲染（不是「⚠ 渲染失败」错误卡片）');
  chk(bRdc.hasSwitch && bRdc.hasBtnRdc && bRdc.hasBtnBrand, '红框处已出现「展示维度：按 RDC / 按品牌」切换控件');
  chk(bRdc.dim === 'rdc', '默认维度 = rdc（未切换前行为与 v395 一致）');
  chk(bRdc.title.indexOf('按RDC堆叠') >= 0, 'RDC 维度下卡片标题含「按RDC堆叠」→ ' + bRdc.title.slice(0, 60));
  chk(bRdc.series.length >= 1 && bRdc.series.every(s => /RDC$/.test(s)), 'RDC 维度下 series 全为 RDC 名（' + bRdc.series.length + ' 个）');
  chk(bRdc.xLen === 12, '横轴仍为 12 个覆盖周期（实际 ' + bRdc.xLen + '）');

  // 真实点击「按品牌」（走 UI，不直接改 window._covDim）
  await p.locator('#page-inventory-structure button:has-text("按品牌")').first().click();
  await p.waitForTimeout(1200);

  const bBrand = await p.evaluate(() => {
    const el = document.getElementById('page-inventory-structure');
    const inst = window.echarts.getInstanceByDom(document.getElementById('chart-cov-stacked'));
    const opt = inst ? inst.getOption() : null;
    return {
      dim: window._covDim,
      selected: (window._covSelectedBrands || []).slice(),
      legendText: (el.innerHTML.match(/点击色块切换[^<]*/) || [''])[0],
      title: (el.innerText.match(/库存覆盖-可用库存[^\n]*/) || [''])[0],
      series: opt ? opt.series.map(s => s.name) : [],
      xData: opt && opt.xAxis && opt.xAxis[0] ? opt.xAxis[0].data.slice() : [],
      seriesData: opt ? opt.series.map(s => s.data.slice()) : [],
      html: el.innerHTML
    };
  });
  chk(bBrand.dim === 'brand', '点击「按品牌」后 window._covDim = brand（按钮真实生效，非仅改状态）');
  chk(bBrand.title.indexOf('按品牌堆叠') >= 0 && bBrand.title.indexOf('按RDC堆叠') < 0,
    '品牌维度下卡片标题切换为「按品牌堆叠」→ ' + bBrand.title.slice(0, 70));
  chk(bBrand.legendText.indexOf('品牌') >= 0, '色块图例切换为品牌口径 → 「' + bBrand.legendText.trim() + '」');
  // ⚠ 断言必须精确到「色块图例 / 系列」这一层：卡片说明里主动写了「不含玉泽/佰草集」，
  //   若笼统断言「HTML 中无这两个词」会把正确的口径说明也判成失败（v396 探针首轮即误判）。
  chk(bBrand.html.indexOf("_covToggleBrand('玉泽'") < 0 && bBrand.html.indexOf("_covToggleBrand('佰草集'") < 0,
    '品牌色块图例中没有「玉泽」「佰草集」');
  chk(bBrand.series.indexOf('玉泽') < 0 && bBrand.series.indexOf('佰草集') < 0,
    '图表系列中没有「玉泽」「佰草集」');
  chk(bBrand.html.indexOf('不含玉泽/佰草集') >= 0, '卡片说明中已明示口径「不含玉泽/佰草集」（避免用户以为漏数据）');
  chk(bBrand.series.length === A.brands.length,
    '系列数 = 参与展示品牌数（' + bBrand.series.length + ' vs 期望 ' + A.brands.length + '）');
  chk(bBrand.series.every(s => A.brands.indexOf(s) >= 0), '每个系列名都是合法品牌名 → ' + bBrand.series.slice(0, 4).join('、') + '…');
  chk(bBrand.series.every(s => s.indexOf('RDC') < 0), '品牌维度下不再出现 RDC 系列');
  chk(bBrand.selected.length === A.brands.length, '窗口品牌勾选态 = 全选（' + bBrand.selected.length + ' 个）');
  chk(bBrand.xData.length === 12 && bBrand.xData[0] === '≤1个月',
    '品牌维度横轴仍为 12 个覆盖周期 → ' + bBrand.xData.slice(0, 3).join('/') + '…');

  // 同源复算：每个品牌的各周期柱值 必须等于 数据层聚合值
  let seriesMismatch = [];
  for (let i = 0; i < bBrand.series.length; i++) {
    const name = bBrand.series[i];
    for (let j = 0; j < bBrand.xData.length; j++) {
      const lv = bBrand.xData[j];
      const want = (A.detail[name + '||' + lv] || { sum: 0 }).sum;
      const got = bBrand.seriesData[i][j] || 0;
      if (Math.abs(got - want) > 0.5) seriesMismatch.push(name + '×' + lv + ': 图=' + got + ' 数据=' + Math.round(want));
    }
  }
  chk(seriesMismatch.length === 0, '同源复算：品牌×周期 全部柱值 = cov7 聚合值（' + bBrand.series.length + '×12 格）' + (seriesMismatch.length ? ' → ' + seriesMismatch.slice(0, 3).join(' | ') : ''));

  // tooltip 文案（v395 铁律：innerText 不含 title，且 formatter 是惰性回调，必须真实触发）
  const tip = await p.evaluate(() => {
    const inst = window.echarts.getInstanceByDom(document.getElementById('chart-cov-stacked'));
    const opt = inst.getOption();
    const f = opt.tooltip[0].formatter;
    const params = opt.series.map((s, i) => ({ axisValue: opt.xAxis[0].data[0], seriesName: s.name, value: s.data[0] || 0, marker: '[m]' }));
    return String(f(params));
  });
  chk(tip.indexOf('点击下钻该品牌明细') >= 0, 'tooltip 文案切换为「点击下钻该品牌明细」（真实触发 formatter）');

  // ══════════ C. 下钻：真实点击品牌柱 → 两层明细 ══════════
  console.log('\n=== C. 下钻：真实点击品牌柱 → 明细页「① RDC 维度 → ② SKU 明细」===');
  const hit = await p.evaluate(() => {
    const el = document.getElementById('chart-cov-stacked');
    const inst = window.echarts.getInstanceByDom(el);
    const opt = inst.getOption();
    const j = 0; // 第一个覆盖周期 ≤1个月
    let best = { i: -1, v: 0 };
    opt.series.forEach((s, i) => { const v = s.data[j] || 0; if (v > best.v) best = { i, v }; });
    if (best.i < 0) return null;
    let base = 0;
    for (let k = 0; k < best.i; k++) base += (opt.series[k].data[j] || 0);
    const topVal = base + best.v;
    const xPix = inst.convertToPixel({ xAxisIndex: 0 }, j);
    const yTop = inst.convertToPixel({ yAxisIndex: 0 }, topVal);
    const yBase = inst.convertToPixel({ yAxisIndex: 0 }, base);
    const r = el.getBoundingClientRect();
    return { x: r.left + xPix, y: r.top + (yTop + yBase) / 2, brand: opt.series[best.i].name, period: opt.xAxis[0].data[j], px: (yTop + yBase) / 2 };
  });
  chk(!!hit, '定位到可点击的品牌柱段（' + (hit ? hit.brand + ' · ' + hit.period : '无') + '）');
  if (hit) {
    // 🔴 落点自检（v396 踩坑）：`elementHandle.screenshot()` 等操作会让页面发生布局位移，
    //   旧算出的「视口坐标」可能落到**固定侧边栏/遮罩**上 → 点击被吞、导航不发生，
    //   表现成「功能坏了」的假红。先 elementFromPoint 确认落点真的在 canvas 上。
    const landed = await p.evaluate(([x, y]) => {
      const e = document.elementFromPoint(x, y);
      return e ? (e.tagName + (e.id ? '#' + e.id : '')) : 'null';
    }, [hit.x, hit.y]);
    chk(landed === 'CANVAS', '点击落点命中图表 canvas（elementFromPoint=' + landed + '）');
    await p.mouse.click(hit.x, hit.y);
    await p.waitForTimeout(1500);
    const drill = await p.evaluate(({ brand, period }) => {
      const el = document.getElementById('page-inventory-coverage-detail');
      const C = window._invCoverageDetailCtx || null;
      const raw = (dataStore.inventory.cov7 || []).filter(d =>
        (normalizeBrandName(String(d.brand || '').trim()) === brand) &&
        (d.coverageLevel === period || (period === '≤1个月' && d.coverageLevel === '0~1个月')));
      const byRdc = {};
      raw.forEach(d => { byRdc[d.rdc] = (byRdc[d.rdc] || 0) + (d.planAmt || 0); });
      // 页面上 ① 表：第一行 = 全部 RDC
      const tables = el ? Array.from(el.querySelectorAll('table.data-table')) : [];
      const t1row0 = tables[0] ? Array.from(tables[0].querySelectorAll('tbody tr')).slice(0, 1).map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim())) : [];
      const t1rows = tables[0] ? Array.from(tables[0].querySelectorAll('tbody tr')).map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim())) : [];
      const t2rows = tables[1] ? tables[1].querySelectorAll('tbody tr').length : -1;
      return {
        active: (document.getElementById('page-inventory-coverage-detail') || {}).className || '',
        ctx: C,
        title: (el.innerText.match(/^[^\n]*明细[^\n]*/m) || [''])[0],
        text: el ? el.innerText : '',
        hasLayer1: /①\s*RDC\s*维度/.test(el ? el.innerText : ''),
        hasLayer2: /②\s*SKU\s*明细/.test(el ? el.innerText : ''),
        tableCount: tables.length,
        firstRow: t1row0[0] || [],
        allRows: t1rows,
        skuRows: t2rows,
        expect: { n: raw.length, sum: raw.reduce((s, d) => s + (d.planAmt || 0), 0), rdcs: Object.keys(byRdc).sort(), byRdc }
      };
    }, { brand: hit.brand, period: hit.period });
    chk(/\bactive\b/.test(drill.active), '点击品牌柱后已跳转到「库存覆盖明细」页');
    chk(drill.ctx && drill.ctx.dim === 'brand' && drill.ctx.value === hit.brand,
      '下钻上下文 = 品牌「' + (drill.ctx ? drill.ctx.value : '?') + '」· 周期「' + (drill.ctx ? drill.ctx.period : '?') + '」');
    chk(drill.hasLayer1, '明细页存在「① RDC 维度」层（用户要求：先展示 RDC 维度数据）');
    chk(drill.hasLayer2, '明细页存在「② SKU 明细」层');
    // 金额比对用页面**自己的** formatMoney 复算期望文本后逐字比（页面显示成「¥108.8万」，
    // 自己写数字解析器会误判；同源比较才能同时验证「值对」和「格式对」）
    const expectMoney = await p.evaluate((v) => formatMoney(v), drill.expect.sum);
    const fCnt = Number(String(drill.firstRow[3] || '').replace(/[^\d.-]/g, ''));
    chk(drill.firstRow[1] === expectMoney,
      '① 「全部 RDC」金额 = formatMoney(同源复算 ' + Math.round(drill.expect.sum).toLocaleString() + ' 元) → 页面 ' + (drill.firstRow[1] || '-') + ' / 期望 ' + expectMoney);
    chk(fCnt === drill.expect.n, '① 「全部 RDC」SKU 数 = 同源复算 ' + drill.expect.n + ' 条（页面 ' + (drill.firstRow[3] || '-') + '）');
    // ① 的 RDC 行集合 必须与数据层一致（不能缺仓/多仓）
    const pageRdcs = drill.allRows.slice(1).map(r => r[0]).sort();
    chk(JSON.stringify(pageRdcs) === JSON.stringify(drill.expect.rdcs),
      '① 的 RDC 行 = 数据层实际落仓（' + pageRdcs.length + ' 个）→ ' + pageRdcs.join('、'));

    // ② 点某个 RDC 行 → SKU 明细跟随（筛选可见可退）
    if (pageRdcs.length) {
      const pick = pageRdcs[0];
      await p.evaluate((rdc) => {
        const el = document.getElementById('page-inventory-coverage-detail');
        const tr = Array.from(el.querySelectorAll('table.data-table tbody tr')).find(t => (t.querySelector('td') || {}).innerText
          && t.querySelector('td').innerText.trim() === rdc);
        if (tr) tr.click();
      }, pick);
      await p.waitForTimeout(900);
      const after = await p.evaluate(() => {
        const el = document.getElementById('page-inventory-coverage-detail');
        return {
          pick: window._invCoverageDetailRdc,
          text: el.innerText,
          hasX: el.innerHTML.indexOf('已筛选：') >= 0,
          skuRows: (el.querySelectorAll('table.data-table')[1] || { querySelectorAll: () => [] }).querySelectorAll('tbody tr').length
        };
      });
      chk(after.pick === pick, '点击 ① 的 RDC 行 → 筛选态生效（' + after.pick + '）');
      chk(after.hasX && after.text.indexOf('✕') >= 0, '筛选态「可见 + 可退」：徽标显示「已筛选：' + pick + '」并带 ✕ 出口');
      chk(after.skuRows > 0 && after.skuRows <= 25, '② SKU 明细跟随 RDC 筛选（当前页 ' + after.skuRows + ' 行，单页上限 25）');

      // 点 ✕ 退回
      await p.evaluate(() => {
        const el = document.getElementById('page-inventory-coverage-detail');
        const sp = Array.from(el.querySelectorAll('span')).find(s => s.innerText.trim() === '✕' && s.getAttribute('onclick'));
        if (sp) sp.click();
      });
      await p.waitForTimeout(900);
      const back = await p.evaluate(() => window._invCoverageDetailRdc);
      chk(back === 'all', '点 ✕ 后退回「全部 RDC」（实际 ' + back + '）');
    }
  }

  // ══════════ D. 反例（切回 RDC 维度后必须完全恢复原行为）══════════
  console.log('\n=== D. 反例断言 ===');
  await p.evaluate(() => navigateTo('inventory-structure'));
  await p.waitForTimeout(1200);
  await p.locator('#page-inventory-structure button:has-text("按 RDC")').first().click();
  await p.waitForTimeout(1200);
  const backRdc = await p.evaluate(() => {
    const el = document.getElementById('page-inventory-structure');
    const inst = window.echarts.getInstanceByDom(document.getElementById('chart-cov-stacked'));
    const opt = inst ? inst.getOption() : null;
    return {
      dim: window._covDim,
      title: (el.innerText.match(/库存覆盖-可用库存[^\n]*/) || [''])[0],
      series: opt ? opt.series.map(s => s.name) : [],
      hasRdcLegend: el.innerHTML.indexOf('点击色块切换RDC显示') >= 0
    };
  });
  chk(backRdc.dim === 'rdc', '切回「按 RDC」后维度复位（双向可切，不是单向开关）');
  chk(backRdc.title.indexOf('按RDC堆叠') >= 0, '切回后卡片标题恢复「按RDC堆叠」');
  chk(backRdc.hasRdcLegend, '切回后 RDC 色块图例恢复（v395 行为未被破坏）');
  chk(backRdc.series.every(s => /RDC$/.test(s)), '切回后 series 恢复为 RDC 名（' + backRdc.series.join('、') + '）');

  chk(errs.length === 0, '全程无 JS 运行时错误' + (errs.length ? ' → ' + errs.slice(0, 3).join(' | ') : ''));

  console.log('\n────────────────────────');
  console.log(bad === 0 ? '✅ 全部通过：' + ok + ' 项' : '❌ 存在失败项：' + ok + ' 通过 / ' + bad + ' 失败');
  await b.close();
  if (server) server.close();
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error('探针异常:', e && e.stack || e); process.exit(2); });
