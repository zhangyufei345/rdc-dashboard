#!/usr/bin/env node
/**
 * v397「常规品」名单专项探针 —— 慢动品分析 / 补货建议 两处同源排除判据
 *
 * 验证目标（用户 2026-10-11 需求）：
 *   产品数据「常规品」sheet 内的 SKU 一律按常规品计算，不被 促销装/非卖品/新品期 排除；
 *   名单必须随数据自更新（禁止前端硬编码）；IDB 热恢复路径下也不能丢。
 *
 * 用法（项目根执行）：
 *   NODE_PATH=".../binaries/node/workspace/node_modules" node tools/verify-v397-conventional.cjs
 *   反向验证（用未修复的 HEAD 版页面跑同一探针，必须变红）：
 *     RDC_HTML=_v397_before.html  node tools/verify-v397-conventional.cjs
 *
 * 退出码：0 = 全绿；1 = 有红项。
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML_NAME = process.env.RDC_HTML || 'rdc-dashboard.html';
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
  if (!hit) throw new Error('未找到 chromium');
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

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log((ok ? '✅ ' : '❌ ') + name + (detail ? '  → ' + detail : ''));
};

(async () => {
  const chromium = require('playwright-core').chromium;
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message || e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 300)); });

  console.log('页面文件: ' + HTML_NAME);
  await page.goto('http://127.0.0.1:' + port + '/' + HTML_NAME, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  const loaded = await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).then(() => true).catch(() => false);
  console.log('数据装载: ' + (loaded ? 'OK' : '超时'));
  if (!loaded) { check('数据装载', false, 'dataStore.loaded 未在 180s 内变 true'); }
  // CDN 异步脚本就绪（本探针不读 echarts，但保持一致以防后续扩展）
  await page.waitForFunction(() => typeof window.echarts !== 'undefined', { timeout: 60000 }).catch(() => {});
  // 库存解析就绪（inventory-core.json 与订单数据并行加载，loaded=true 时不保证 inventory 已就位；
  //   v397 首轮探针就因「inventory 尚为 null」直接 evaluate 抛异常 → 必须显式等待）
  const invReady = await page.waitForFunction(
    () => typeof dataStore !== 'undefined' && dataStore && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100,
    { timeout: 180000 }).then(() => true).catch(() => false);
  console.log('库存解析: ' + (invReady ? 'OK' : '超时'));

  // ---------- 1. 名单装载 ----------
  const info = await page.evaluate(() => ({
    n: Object.keys((dataStore && dataStore.conventionalSkus) || {}).length,
    keys: Object.keys((dataStore && dataStore.conventionalSkus) || {}),
    hasFn: typeof isConventionalSku === 'function',
    hasMapFn: typeof conventionalSkuMap === 'function',
    winFn: typeof window.isConventionalSku === 'function'
  }));
  check('dataStore.conventionalSkus 已装载且 >0', info.n > 0, 'n=' + info.n);
  check('isConventionalSku / conventionalSkuMap 已定义并挂 window', info.hasFn && info.hasMapFn && info.winFn,
    'typeof=' + info.hasFn + '/' + info.hasMapFn + '/win=' + info.winFn);

  // ---------- 2. 名单命中 + 前导零别名 + 名单外对照 ----------
  const hit = await page.evaluate(() => {
    const raw = Object.keys((dataStore && dataStore.conventionalSkus) || {});
    // 未修复版没有该函数 → 优雅降级为「全部未命中」，让反向验证能报出完整红项而不是抛异常中断
    if (typeof isConventionalSku !== 'function') return { total: raw.length, allHit: false, aliasOk: false, bad: ['isConventionalSku 未定义'], outside: null, empty: null };
    let allHit = true, aliasOk = true, bad = [];
    raw.forEach(k => {
      if (!isConventionalSku(k)) { allHit = false; bad.push('原键 ' + k); }
      const nk = normSkuCode(k);
      if (nk !== k && !isConventionalSku(nk)) { aliasOk = false; bad.push('别名 ' + nk); }
    });
    return { total: raw.length, allHit, aliasOk, bad: bad.slice(0, 5), outside: isConventionalSku('ZZZZ_NOT_EXIST'), empty: isConventionalSku('') };
  });
  check('名单内全部 SKU 命中（含 normSkuCode 别名双写）', hit.allHit && hit.aliasOk, 'total=' + hit.total + ' bad=' + JSON.stringify(hit.bad));
  check('名单外 SKU 不命中（防「无条件 true」假绿）', hit.outside === false && hit.empty === false, 'ZZZZ=' + hit.outside + ' 空串=' + hit.empty);

  // ---------- 3. isExcludedProduct：名单覆盖三处判据 + 名单外仍排除 ----------
  const ex = await page.evaluate(() => {
    const keys = Object.keys((dataStore && dataStore.conventionalSkus) || {});
    const inList = keys[0] || 'ZZZZ_NOT_EXIST';
    const outList = 'ZZZZ_NOT_EXIST';
    const probe = sku => ({
      attr: isExcludedProduct({ sku: sku, supplyChainAttr: '促销装' }),
      attr2: isExcludedProduct({ sku: sku, supplyChainAttr: '非卖品' }),
      life: isExcludedProduct({ sku: sku, lifecycle: '新品期' }),
      level: isExcludedProduct({ sku: sku, coverageLevel: '促销装' }),
      level2: isExcludedProduct({ sku: sku, coverageLevel: '新品期' }),
      clean: isExcludedProduct({ sku: sku, supplyChainAttr: '常规品' })
    });
    return { inList, outList, hasList: keys.length > 0, inR: probe(inList), outR: probe(outList) };
  });
  check('名单内：供应链属性=促销装/非卖品 不再排除', ex.hasList && ex.inR.attr === false && ex.inR.attr2 === false, '促销装=' + ex.inR.attr + ' 非卖品=' + ex.inR.attr2);
  check('名单内：生命周期=新品期 不再排除', ex.hasList && ex.inR.life === false, 'life=' + ex.inR.life);
  check('名单内：覆盖周数分类兜底（促销装/新品期）不再排除', ex.hasList && ex.inR.level === false && ex.inR.level2 === false, ex.inR.level + '/' + ex.inR.level2);
  check('名单外：三类判据仍照旧排除（对照组，防误放行）',
    ex.outR.attr === true && ex.outR.attr2 === true && ex.outR.life === true && ex.outR.level === true && ex.outR.level2 === true,
    JSON.stringify(ex.outR));
  check('名单内 + 常规品属性 → 本就不排除（负向对照）', ex.inR.clean === false, 'clean=' + ex.inR.clean);

  // ---------- 4. _isExcluded（computeStatusDerived 内副本）用造场景验证 ----------
  //    真实 9 月覆盖表里名单 SKU 的属性本就是「常规品」→ 观测不到差异，故注入合成行。
  const diag = await page.evaluate(() => {
    const inv = dataStore.inventory;
    const cov7 = inv.cov7;
    const before = cov7.length;
    const mk = (sku) => ({ rdc: '华南仓', sku: sku, skuName: 'v397探针合成行', brand: '六神', supplyChainAttr: '促销装', lifecycle: '', abc: 'A',
      isHainan: false, availableQty: 0, availQtyPlan: 1, totalAmt: 0, inventoryAmt: 0, staleAmt: 0, expiredAmt: 0, returnAmt: 0,
      nearExpiryAmt: 0, planAmt: 0, inTransitAmt: 0, coverageMonths: 99, coverageLevel: '大于6个月', reportMonth: '2026-09' });
    const keys = Object.keys((dataStore && dataStore.conventionalSkus) || {});
    const inList = keys[0] || 'ZZZZ_NOT_EXIST';
    const CONTROL = 'ZZZZ_NOT_EXIST';
    cov7.push(mk(inList), mk(CONTROL));
    let ok = null, control = null, err = '';
    try {
      computeStatusDerived();
      const m = window._slowDiagMap || {};
      ok = !!m['华南仓|' + inList];
      control = !!m['华南仓|' + CONTROL];
    } catch (e) { err = String(e && e.message || e); }
    cov7.length = before;                 // 还原
    try { computeStatusDerived(); } catch (e) {}
    return { ok, control, err, inList, before, after: cov7.length };
  });
  check('_isExcluded 同源副本：名单内促销装 SKU 进入慢动诊断（_slowDiagMap）', diag.ok === true, 'err=' + diag.err + ' 还原后 cov7=' + diag.after);
  check('_isExcluded 同源副本：名单外同类 SKU 仍被排除（对照组）', diag.control === false, 'control=' + diag.control);

  // ---------- 5. 慢动品页：DOM 数字与同源复算一致 + 基准月上的放宽可观测 + 例外文案可见 ----------
  //    ⚠️ 口径提示（探针自己先踩过一次）：renderSlowMoving 里 `var cov6 = filterArr(inv.cov7)`（当前月快照），
  //    `var cov5 = filterArr(inv.cov6)`（**基准月** = 上一月快照，L17958-17959 的变量名 cov6/cov5 ≠ inv.cov6/cov5）。
  //    excludedCount 统计的是**当前月 cov7**；而名单放宽在真实数据上恰好只体现在**基准月**（9月表把名单 SKU
  //    标为「常规品」→ 当前月本就 0 放宽；8月表标为「促销装」→ 基准月有放宽）。故两项分开断言。
  await page.evaluate(() => { window._slowFilters = { rdc: 'all', hainan: 'all', obsolete: 'all' }; if (typeof navigateTo === 'function') navigateTo('slow-moving'); });
  await page.waitForTimeout(3000);
  const slow = await page.evaluate(() => {
    const el = document.getElementById('page-slow-moving');
    const txt = el ? el.innerText : '';
    const m = txt.match(/已排除非卖品\/促销装\/新品期\s*(\d+)\s*个SKU/);
    const domCount = m ? Number(m[1]) : null;
    const oldEx = (d) => { const a = (d.supplyChainAttr || '').trim(), l = (d.lifecycle || '').trim(), c = (d.coverageLevel || '').trim();
      return a === '非卖品' || a === '促销装' || l === '新品期' || c === '非卖品' || c === '促销装' || c === '新品期'; };
    const list = Object.keys(dataStore.conventionalSkus || {});
    const inList = (d) => { const s = String(d.sku || '').trim(); return list.indexOf(s) >= 0 || list.indexOf(normSkuCode(s)) >= 0; };
    const cur = (dataStore.inventory && dataStore.inventory.cov7) || [];   // 当前月快照（页面 excludedCount 的来源）
    const base = (dataStore.inventory && dataStore.inventory.cov6) || [];  // 基准月快照（上一月）
    const calc = (rows) => ({
      n: rows.length,
      oldC: rows.filter(oldEx).length,
      newC: rows.filter(d => isExcludedProduct(d)).length,
      // 独立复算「名单放宽」行数：旧口径被排除 ∧ 名单命中
      exempt: rows.filter(d => oldEx(d) && inList(d)).length
    });
    return { domCount, cur: calc(cur), base: calc(base), hasNote: /「常规品」名单/.test(txt), txtLen: txt.length };
  });
  check('慢动品页：DOM 排除数 == 同源复算的新口径（当前月 cov7，精确相等）',
    slow.domCount !== null && slow.domCount === slow.cur.newC,
    'DOM=' + slow.domCount + ' 复算new=' + slow.cur.newC + ' (cov7 ' + slow.cur.n + ' 行)');
  check('基准月快照上「名单放宽」真实生效（newC < oldC 且放宽行数 == 独立复算）',
    slow.base.newC < slow.base.oldC && (slow.base.oldC - slow.base.newC) === slow.base.exempt && slow.base.exempt > 0,
    'cov6: old=' + slow.base.oldC + ' new=' + slow.base.newC + ' 放宽=' + slow.base.exempt + '（' + slow.base.n + ' 行）');
  check('慢动品页：可见「常规品」名单例外说明', slow.hasNote, 'txtLen=' + slow.txtLen);

  // ---------- 6. 补货建议页：下游链路未被破坏 ----------
  await page.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('replenishment'); });
  await page.waitForTimeout(3500);
  const repl = await page.evaluate(() => {
    const el = document.getElementById('page-replenishment');
    return { len: el ? el.innerHTML.length : -1, dw: Array.isArray(window._dwList) ? window._dwList.length : -1 };
  });
  check('补货建议页正常渲染且下调预警链（_dwList）可用', repl.len > 2000 && repl.dw >= 0, 'html=' + repl.len + ' _dwList=' + repl.dw);

  const pageErrs = errs.filter(e => !/ResizeObserver/.test(e));
  check('无新增 JS 运行时错误', pageErrs.length === 0, pageErrs.slice(0, 3).join(' | '));

  await browser.close();
  server.close();
  const bad = results.filter(r => !r.ok);
  console.log('\n合计 ' + results.length + ' 项，失败 ' + bad.length + ' 项');
  if (bad.length) console.log('红项: ' + bad.map(b => b.name).join(' / '));
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('工具异常:', e && e.message); process.exit(2); });
