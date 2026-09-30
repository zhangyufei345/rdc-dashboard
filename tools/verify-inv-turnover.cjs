#!/usr/bin/env node
/**
 * v391「库存周转数据全 null」修复验证探针
 *
 * 背景：parseExcel 挑周转 sheet 的条件过宽（含「库存」即命中），
 *   data-2026-01~05.json 的「库存分析」sheet 被误当周转表 → 无条件覆盖 dataStore.inventoryTurnover
 *   → 页面 KPI 显示 null / 最快慢 RDC 显示 9999/0。
 *
 * 覆盖四层：
 *   A. 解析器层：误匹配 sheet 必须返回 null；真周转 sheet 必须正常解析
 *   B. 运行时层：dataStore.inventoryTurnover 正确 + 页面 KPI 无 null / 无 9999/0
 *   C. 渲染层：KPI 数值 == 同源复算（不硬编码，读 dataStore 反推）
 *   D. 🔴 自愈层：把「中毒数据」写进 IDB 后 reload（哈希全部未变 → 正常路径不会重解析），
 *      必须靠 v391 自愈把 inventory-core.json 拉回来修好
 *
 * 用法：
 *   NODE_PATH=... node tools/verify-inv-turnover.cjs
 *   RDC_BASE=https://rdc-dashboard.pages.dev ... tools/verify-inv-turnover.cjs
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.RDC_BASE || '').replace(/\/$/, '');

function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const c = [];
  for (const d of fs.readdirSync(base)) {
    c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    c.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  return c.find(p => fs.existsSync(p));
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
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

const R = { pass: 0, fail: 0 };
function chk(n, c, d) { c ? R.pass++ : R.fail++; console.log((c ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); }

(async () => {
  const { chromium } = require('playwright-core');
  let server = null, URL;
  if (BASE) URL = BASE + '/rdc-dashboard.html';
  else { server = await startServer(); URL = 'http://127.0.0.1:' + server.address().port + '/rdc-dashboard.html'; }
  console.log('目标:', URL);

  const b = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  let logs = [];
  const errs = [];
  p.on('pageerror', e => errs.push('[pageerror] ' + (e.message || e)));
  p.on('console', m => {
    const t = m.text();
    if (m.type() === 'warning' || m.type() === 'error') logs.push('[' + m.type() + '] ' + t.slice(0, 220));
    if (m.type() === 'error' && !/Failed to load resource/.test(t)) errs.push('[console] ' + t.slice(0, 200));
  });

  const boot = async () => {
    await p.waitForFunction(() => window._bootLoading === false && typeof dataStore !== 'undefined' && dataStore.loaded === true, { timeout: 240000 });
  };
  const login = async () => {
    await p.fill('#login-user', 'admin').catch(() => {});
    await p.fill('#login-pass', 'admin123').catch(() => {});
    await p.click('#login-page button').catch(() => {});
  };

  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await login();
  await boot();
  console.log('数据装载完成');

  // 读取真实源 sheet 供解析器层测试
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'data-2026-05.json'), 'utf8')).sheets['库存分析'];
  const goodSheet = JSON.parse(fs.readFileSync(path.join(ROOT, 'inventory-core.json'), 'utf8')).sheets['2026周转'];

  // ── A. 解析器层 ──────────────────────────────────────────────────────
  console.log('\n===== A. 解析器层 =====');
  const A = await p.evaluate(([bad, good]) => {
    const bd = parseInventoryTurnoverSheet(bad);
    const gd = parseInventoryTurnoverSheet(good);
    return {
      badIsNull: bd === null,
      badMatched: bd ? bd.matchedRows : null,
      goodMatched: gd ? gd.matchedRows : null,
      goodMonths: gd ? gd.months : null,
      goodTotalAll: gd ? gd.totalAllLocation : null,
    };
  }, [src, goodSheet]);
  chk('🔴 误匹配的「库存分析」sheet 解析结果必须为 null（原来会产出废数据）', A.badIsNull, 'matchedRows=' + A.badMatched);
  chk('真周转表「2026周转」解析正常（matchedRows >= 9）', A.goodMatched >= 9, 'matchedRows=' + A.goodMatched);
  chk('真周转表月份数 == 8（1月~8月）', Array.isArray(A.goodMonths) && A.goodMonths.length === 8, JSON.stringify(A.goodMonths));

  // ── B. 运行时层 ──────────────────────────────────────────────────────
  console.log('\n===== B. 运行时层 =====');
  const B = await p.evaluate(() => {
    const inv = dataStore.inventoryTurnover;
    const li = inv && inv.months ? inv.months.length - 1 : -1;
    const at = a => (Array.isArray(a) && a.length > li) ? a[li] : undefined;
    return {
      hasInv: !!inv, months: inv ? inv.months : null,
      totalAll: at(inv && inv.totalAllLocation),
      totalShared: at(inv && inv.totalSharedLocation),
      hq: at(inv && inv.headquarters),
      matchedRows: inv ? inv.matchedRows : null,
    };
  });
  chk('dataStore.inventoryTurnover 存在', B.hasInv);
  chk('月份数 == 8（不是中毒态的 7）', Array.isArray(B.months) && B.months.length === 8, JSON.stringify(B.months));
  chk('🔴 全库位汇总行最新月非 null（中毒态为 null）', typeof B.totalAll === 'number' && isFinite(B.totalAll), 'v=' + B.totalAll);
  chk('🔴 共享库汇总行最新月非 null', typeof B.totalShared === 'number' && isFinite(B.totalShared), 'v=' + B.totalShared);
  chk('🔴 总仓汇总行最新月非 null', typeof B.hq === 'number' && isFinite(B.hq), 'v=' + B.hq);

  // ── C. 渲染层 ────────────────────────────────────────────────────────
  console.log('\n===== C. 渲染层 =====');
  await p.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('inventory'); window._invTab = 'turnover'; });
  await p.waitForTimeout(4000);
  let C = await p.evaluate(() => {
    // 保险：确认真的在周转 TAB（renderInventoryTurnover 里若有其它 tab 会覆盖）
    if (typeof window.renderInventoryTurnover === 'function' && window._invTab !== 'turnover') {
      window._invTab = 'turnover'; window.renderInventoryTurnover();
    }
    const el = document.getElementById('page-inventory');
    const txt = el ? el.innerText : '';
    const kpis = [...document.querySelectorAll('#page-inventory .kpi-card')].map(k => k.innerText.replace(/\n/g, ' '));
    return { txt: txt, kpis: kpis, html: el ? el.innerHTML : '' };
  });
  if (C.txt.indexOf('null') >= 0 || C.txt.indexOf('9999') >= 0) {
    // 可能被别的渲染覆盖，重试一次
    await p.evaluate(() => { window._invTab = 'turnover'; if (typeof renderInventoryTurnover === 'function') renderInventoryTurnover(); });
    await p.waitForTimeout(4000);
    C = await p.evaluate(() => {
      const el = document.getElementById('page-inventory');
      const txt = el ? el.innerText : '';
      const kpis = [...document.querySelectorAll('#page-inventory .kpi-card')].map(k => k.innerText.replace(/\n/g, ' '));
      return { txt: txt, kpis: kpis, html: el ? el.innerHTML : '' };
    });
  }
  chk('🔴 页面不出现 null（用户报的乱码）', C.txt.indexOf('null') < 0,
    JSON.stringify(C.kpis.slice(0, 4)));
  chk('🔴 页面不出现 9999（最快/慢RDC 占位值）', C.txt.indexOf('9999') < 0);
  chk('页面不出现 NaN', C.txt.indexOf('NaN') < 0);
  // KPI 数值 == 同源复算（不硬编码）
  const expect = await p.evaluate(() => {
    const inv = dataStore.inventoryTurnover;
    const li = inv.months.length - 1;
    const sel = (typeof getInvRdcSelection === 'function') ? getInvRdcSelection().selected : Object.keys(inv.allLocation);
    let minT = 9999, maxT = 0;
    sel.forEach(r => { const v = (inv.allLocation[r] || [])[li] || 0; if (v > 0 && v < minT) minT = v; if (v > maxT) maxT = v; });
    return { all: inv.totalAllLocation[li], shared: inv.totalSharedLocation[li], hq: inv.headquarters[li], mm: minT + '/' + maxT,
             label: inv.months[li] };
  });
  chk('KPI「全库位周转」显示值 == 同源值 ' + expect.all, C.kpis.some(k => k.indexOf(String(expect.all)) >= 0));
  chk('KPI「共享库周转」显示值 == 同源值 ' + expect.shared, C.kpis.some(k => k.indexOf(String(expect.shared)) >= 0));
  chk('KPI「总仓周转」显示值 == 同源值 ' + expect.hq, C.kpis.some(k => k.indexOf(String(expect.hq)) >= 0));
  chk('KPI「最快/慢RDC」显示值 == 同源值 ' + expect.mm, C.kpis.some(k => k.indexOf(expect.mm) >= 0));
  chk('KPI 月份标签 == 同源最新月 ' + expect.label, C.txt.indexOf(expect.label) >= 0);
  console.log('  KPI 实渲染:', JSON.stringify(C.kpis.slice(0, 4)));
  await p.screenshot({ path: path.join(ROOT, 'tools', '_out', '_inv_turnover_ok.png'), fullPage: false }).catch(() => {});

  // ── D. 自愈层（最关键：模拟已被写坏的老用户缓存）────────────────────
  console.log('\n===== D. 自愈层（模拟中毒 IDB 缓存后 reload）=====');
  const poisoned = await p.evaluate(async () => {
    // 还原 v391 之前 parseExcel 对「库存分析」sheet 的实际产出（与用户截图逐项吻合）
    const poison = {
      allLocation: { '东北RDC': [105, 63, 89, 53, 64, 67, null], '华北RDC': [80, 132, 183, 46, 38, 42, null],
        '华南RDC': [79, 67, 96, 61, 48, 53, null], '华中RDC': [102, 84, 105, 38, 31, 40, null],
        '西北RDC': [60, 56, 78, 47, 40, 45, null], '西南RDC': [57, 68, 86, 34, 30, 34, null] },
      sharedLocation: {}, subLocation: {}, inventoryByRdc: {}, shipmentCost: {},
      rdcOrder: ['东北RDC', '华北RDC', '华南RDC', '华中RDC', '西北RDC', '西南RDC'],
      months: ['1月', '2月', '3月', '4月', '5月', '6月', '7月'],
      formula: '',
      totalAllLocation: [84, 79, 104, 45, 38, 45, null],
      totalSharedLocation: [63, 64, 77, 31, 30, 36, null],
      headquarters: [64, 60, 72, 62, 62, 63, null]
    };
    dataStore.inventoryTurnover = poison;
    await saveToIDB();
    return { months: dataStore.inventoryTurnover.months.length };
  });
  chk('已把中毒数据写入 IDB（months=7）', poisoned.months === 7);

  logs = [];
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.waitForTimeout(1500);
  await login();
  await boot();
  // 等自愈把 inventory-core.json 拉回并重解析
  let healed = false;
  for (let i = 0; i < 40 && !healed; i++) {
    healed = await p.evaluate(() => {
      const inv = dataStore.inventoryTurnover;
      if (!inv || !Array.isArray(inv.months) || inv.months.length !== 8) return false;
      const li = inv.months.length - 1;
      return [inv.totalAllLocation, inv.totalSharedLocation, inv.headquarters]
        .every(a => Array.isArray(a) && typeof a[li] === 'number' && isFinite(a[li]));
    });
    if (!healed) await p.waitForTimeout(500);
  }
  const healMsg = logs.find(l => l.indexOf('v391 库存周转') >= 0);
  chk('🔴 自愈日志出现（判定中毒缓存并强制补拉 inventory-core.json）', !!healMsg, healMsg || logs.slice(-3).join(' | '));
  chk('🔴 reload 后库存周转数据被修复（months=8 且汇总行非 null）', healed);
  const after = await p.evaluate(() => {
    const inv = dataStore.inventoryTurnover; const li = inv.months.length - 1;
    return { months: inv.months.length, all: inv.totalAllLocation[li], shared: inv.totalSharedLocation[li], hq: inv.headquarters[li] };
  });
  console.log('  reload 后:', JSON.stringify(after));
  chk('reload 后月份数 == 8', after.months === 8, 'months=' + after.months);
  chk('reload 后汇总行均为数值', [after.all, after.shared, after.hq].every(v => typeof v === 'number'));

  // ── E. 无副作用检查 ──────────────────────────────────────────────────
  console.log('\n===== E. 其它数据未被误伤 =====');
  const E = await p.evaluate(() => ({
    cov7: (dataStore.inventory && dataStore.inventory.cov7) ? dataStore.inventory.cov7.length : 0,
    orderDetail: (dataStore.orderDetail || []).length,
    shortage: (dataStore.shortage || []).length,
    rdcCount: Object.keys((dataStore.inventoryTurnover || {}).allLocation || {}).length,
  }));
  chk('cov7 仍完整（>=100）', E.cov7 >= 100, 'cov7=' + E.cov7);
  chk('orderDetail 仍完整（>=100000）', E.orderDetail >= 100000, 'orderDetail=' + E.orderDetail);
  chk('shortage 仍完整（>0）', E.shortage > 0, 'shortage=' + E.shortage);
  chk('周转表 RDC 行数正常（>=6）', E.rdcCount >= 6, 'rdcCount=' + E.rdcCount);

  const realErrs = errs.filter(z => !/favicon/.test(z));
  chk('无 JS 运行时错误', realErrs.length === 0, realErrs.slice(0, 2).join(' || '));

  await b.close();
  if (server) server.close();
  console.log('\n合计 ' + (R.pass + R.fail) + ' 项，通过 ' + R.pass + '，失败 ' + R.fail);
  process.exit(R.fail ? 1 : 0);
})().catch(e => { console.error('探针异常:', e && e.stack || e); process.exit(2); });
