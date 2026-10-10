#!/usr/bin/env node
/**
 * v395（2026-10-10）9月库存部署 —— 月份窗口平移专项探针
 *
 * 为什么需要这个：`verify-page-runtime.cjs` 只能证明「14 个页签不报错、HTML 非空」，
 *   而本次改动是**位置语义槽位整体右移一月**（cov5/6/7 指向的 sheet 换了），
 *   这类 bug 的典型表现是「页面正常渲染、数字静默错一个月/整列恒 0」，**不会报错**。
 *   所以必须逐项断言「字段 → 月份」映射与 UI 文案（memory 铁律：只验容器存在=假绿）。
 *
 * 覆盖三层：
 *   A. 数据层  —— dataStore.inventory.cov5/6/7 的 reportMonth 是否 7/8/9 月，cov15 是否有值
 *   B. 助手层  —— covFieldToYM / covFieldOfYM / covSnapMonthLabel / covFutureFields 双向映射
 *   C. UI 层   —— 真实渲染产物（库存周转列、分仓计划监控目标月、慢动品表头、年末预测阴影区）
 *                 + 反例断言（不得再出现「6月覆盖/7月覆盖/7月分仓需求」等陈旧字面量）
 *
 * 用法（项目根执行）：
 *   NODE_PATH="C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules" \
 *   "C:/Users/zhangyufei1/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" tools/verify-v395-window.cjs
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
  if (BASE) URL = BASE + '/rdc-dashboard.html';
  else { server = await startServer(); URL = 'http://127.0.0.1:' + server.address().port + '/rdc-dashboard.html'; }
  console.log('目标:', URL, '\n');

  const b = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('[pageerror] ' + (e.message || e)));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('[console] ' + m.text().slice(0, 200)); });

  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.fill('#login-user', 'admin').catch(() => {});
  await p.fill('#login-pass', 'admin123').catch(() => {});
  await p.click('#login-page button').catch(() => {});
  // 等数据就位（先等 bootLoading 归位，再等 loaded —— 顺序反了会误判）
  await p.waitForFunction(() => window._bootLoading === false, { timeout: 240000 }).catch(() => {});
  await p.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 240000 })
    .then(() => console.log('数据装载: OK\n'))
    .catch(() => console.log('数据装载: 超时（后续结果可能不准）\n'));

  // ══════════ A. 数据层 ══════════
  // ⚠ cov5（位置=再上一月，现指向「7月库存覆盖数据」）位于 inventory-extra.json，属**按需**文件，
  //   首屏不会加载（这一点 v395 前后一致，不是本次引入）。断言前必须显式触发 ensureInventoryExtra，
  //   否则拿到空数组会把「没加载」误判成「解析错」。
  console.log('=== A. 数据层：cov5/6/7 槽位指向的 sheet 月份 ===');
  const cov5Before = await p.evaluate(() => ((dataStore.inventory || {}).cov5 || []).length);
  await p.evaluate(() => { if (typeof ensureInventoryExtra === 'function') return ensureInventoryExtra(); }).catch(() => {});
  for (let i = 0; i < 30; i++) {
    const n = await p.evaluate(() => ((dataStore.inventory || {}).cov5 || []).length);
    if (n > 0) break;
    await p.waitForTimeout(1000);
  }
  const cov5After = await p.evaluate(() => ((dataStore.inventory || {}).cov5 || []).length);
  console.log('  · cov5 按需加载：' + cov5Before + ' → ' + cov5After + '（首屏为 0 属预期，7月表在 inventory-extra.json）');
  const A = await p.evaluate(() => {
    const inv = dataStore.inventory || {};
    const g = (src) => {
      const a = inv[src] || [];
      return { n: a.length, reportMonth: (a[0] && a[0].reportMonth) || null, hint: (a[0] && a[0].monthHint) || null };
    };
    const sum = (arr, f) => (arr || []).reduce((s, d) => s + (d[f] || 0), 0);
    return {
      cov5: g('cov5'), cov6: g('cov6'), cov7: g('cov7'),
      cov15sum_cov7: sum(inv.cov7, 'cov15'),
      cov14sum_cov7: sum(inv.cov7, 'cov14'),
      cov10sum_cov7: sum(inv.cov7, 'cov10'),
      cov09sum_cov6: sum(inv.cov6, 'cov09'),
      // cov5 槽装 7月表 → 其最大需求月应是 2027-01（cov13）
      cov13sum_cov5: sum(inv.cov5, 'cov13'),
      cov15sum_cov5: sum(inv.cov5, 'cov15'),
      cov07sum_cov5: sum(inv.cov5, 'cov07'),
      covFieldCount: (inv.cov7 && inv.cov7[0]) ? Object.keys(inv.cov7[0]).filter(k => /^cov\d\d$/.test(k)).length : 0,
      DB_VERSION: typeof DB_VERSION !== 'undefined' ? DB_VERSION : null,
      BUILD_VERSION: typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : null,
    };
  });
  chk(A.cov5.reportMonth === '2026-07', 'cov5(位置:再上一月) reportMonth=' + A.cov5.reportMonth + '（期望 2026-07 / 7月表）  行数=' + A.cov5.n);
  chk(A.cov6.reportMonth === '2026-08', 'cov6(位置:上一月)   reportMonth=' + A.cov6.reportMonth + '（期望 2026-08 / 8月表）  行数=' + A.cov6.n);
  chk(A.cov7.reportMonth === '2026-09', 'cov7(位置:当前月)   reportMonth=' + A.cov7.reportMonth + '（期望 2026-09 / 9月表）  行数=' + A.cov7.n);
  chk(A.covFieldCount === 10, 'cov7 行上 covNN 字段数=' + A.covFieldCount + '（期望 10 = cov06..cov15）');
  // 🔴 关键：cov15 若恒 0 说明最后一个月需求整月丢失（v395 新增字段）
  chk(A.cov15sum_cov7 > 0, 'cov7.cov15 合计=' + A.cov15sum_cov7.toLocaleString() + '（>0 才说明 2027-03 需求没丢）');
  chk(A.cov10sum_cov7 > 0, 'cov7.cov10 合计=' + A.cov10sum_cov7.toLocaleString() + '（2026-10 需求）');
  chk(A.cov09sum_cov6 > 0, 'cov6.cov09 合计=' + A.cov09sum_cov6.toLocaleString() + '（8月表的首个需求月 2026-09）');
  // 7月表（cov5 槽）需求列恒为 cov08..cov13 → cov15/cov07 必须为 0，cov13 必须 >0
  chk(A.cov15sum_cov5 === 0 && A.cov07sum_cov5 === 0, 'cov5(7月表) 上 cov15=' + A.cov15sum_cov5 + ' / cov07=' + A.cov07sum_cov5 + '（都必须为 0，7月表只含 cov08..cov13）');
  chk(A.cov13sum_cov5 > 0, 'cov5(7月表) 上 cov13 合计=' + A.cov13sum_cov5.toLocaleString() + '（7月表末月=2027-01，>0）');
  chk(A.DB_VERSION === 235, 'DB_VERSION=' + A.DB_VERSION + '（期望 235，老缓存必须作废）');
  chk(A.BUILD_VERSION === 395, 'BUILD_VERSION=' + A.BUILD_VERSION + '（期望 395）');

  // ══════════ B. 助手层 ══════════
  console.log('\n=== B. 助手层：covNN ↔ YYYY-MM 双向映射 ===');
  const B = await p.evaluate(() => {
    const out = {};
    out.toYM = {};
    ['cov06','cov07','cov08','cov09','cov10','cov11','cov12','cov13','cov14','cov15'].forEach(f => out.toYM[f] = covFieldToYM(f));
    out.ofYM = {};
    ['2026-06','2026-09','2026-10','2026-12','2027-01','2027-03'].forEach(m => out.ofYM[m] = covFieldOfYM(m));
    out.labels = { cov5: covSnapMonthLabel('cov5'), cov6: covSnapMonthLabel('cov6'), cov7: covSnapMonthLabel('cov7') };
    out.range7 = covFutureRangeText('cov7');
    out.range6 = covFutureRangeText('cov6');
    out.range5 = covFutureRangeText('cov5');
    const cfg = getCovMonthConfig('cov7');
    out.cfg7 = { fields: cfg.fields, labels: cfg.labels, yms: cfg.yms };
    const cfg6 = getCovMonthConfig('cov6');
    out.cfg6 = { fields: cfg6.fields, labels: cfg6.labels, yms: cfg6.yms };
    const cfg5 = getCovMonthConfig('cov5');
    out.cfg5 = { fields: cfg5.fields, labels: cfg5.labels, yms: cfg5.yms };
    const _n = new Date();
    out.curYM = _n.getFullYear() + '-' + String(_n.getMonth() + 1).padStart(2, '0');
    out.ymOf = (f) => covFieldToYM(f);
    // covFutureFields 必须走「数据推导」而不是 legacy 兜底 → 传一个明显错误的 legacy，结果仍应是 cov10..cov15
    out.fieldsDerived = covFutureFields(dataStore.inventory.cov7, ['WRONG1','WRONG2']);
    // 同源复算：助手取字段 + 求和  vs 手工把 6 个字段读出来相加
    const d0 = (dataStore.inventory.cov7 || [])[0] || {};
    out.helperSum = covFutureSum(d0, out.fieldsDerived);
    out.manualSum = ['cov10','cov11','cov12','cov13','cov14','cov15'].reduce((s, f) => s + (d0[f] || 0), 0);
    out.sample = { rdc: d0.rdc, sku: d0.sku };
    return out;
  });
  const expToYM = { cov06:'2026-06', cov07:'2026-07', cov08:'2026-08', cov09:'2026-09', cov10:'2026-10', cov11:'2026-11', cov12:'2026-12', cov13:'2027-01', cov14:'2027-02', cov15:'2027-03' };
  const badToYM = Object.keys(expToYM).filter(f => B.toYM[f] !== expToYM[f]);
  chk(badToYM.length === 0, 'covFieldToYM 全部正确 ' + JSON.stringify(B.toYM) + (badToYM.length ? '  错项:' + badToYM.join(',') : ''));
  const expOfYM = { '2026-06':'cov06', '2026-09':'cov09', '2026-10':'cov10', '2026-12':'cov12', '2027-01':'cov13', '2027-03':'cov15' };
  const badOfYM = Object.keys(expOfYM).filter(m => B.ofYM[m] !== expOfYM[m]);
  chk(badOfYM.length === 0, 'covFieldOfYM 全部正确 ' + JSON.stringify(B.ofYM) + (badOfYM.length ? '  错项:' + badOfYM.join(',') : ''));
  chk(B.labels.cov5 === '7月' && B.labels.cov6 === '8月' && B.labels.cov7 === '9月',
    'covSnapMonthLabel = ' + JSON.stringify(B.labels) + '（期望 7月/8月/9月）');
  // ⚠ getCovMonthConfig 会按设计截断「只保留 <= 当前日历月的选项」（分仓计划不提前放后续月），
  //   所以断言「前缀正确 + 截断规则正确」，而不是断言整段 6 项全等。
  const curYM = B.curYM;
  function cfgChk(name, cfg, fullFields, fullLabels) {
    const isPrefix = cfg.fields.every((f, i) => f === fullFields[i]);
    chk(isPrefix && cfg.fields.length >= 1,
      name + '.fields = ' + cfg.fields.join(',') + '（应为 ' + fullFields.join(',') + ' 的前缀；末月=' + cfg.yms[cfg.yms.length - 1] + ' ≤ 当月 ' + curYM + '）');
    chk(cfg.labels.join(',') === fullLabels.slice(0, cfg.fields.length).join(','),
      name + '.labels = ' + cfg.labels.join(',') + '（与 fields 严格同位）');
    chk(cfg.yms.every(y => y <= curYM), name + '.yms 全部 ≤ 当月：' + cfg.yms.join(','));
    return true;
  }
  cfgChk('getCovMonthConfig(cov7)', B.cfg7, ['cov10','cov11','cov12','cov13','cov14','cov15'], ['10月','11月','12月','次年1月','次年2月','次年3月']);
  cfgChk('getCovMonthConfig(cov6)', B.cfg6, ['cov09','cov10','cov11','cov12','cov13','cov14'], ['9月','10月','11月','12月','次年1月','次年2月']);
  cfgChk('getCovMonthConfig(cov5)', B.cfg5, ['cov08','cov09','cov10','cov11','cov12','cov13'], ['8月','9月','10月','11月','12月','次年1月']);
  chk(B.range7 === 'cov10~cov15（2026-10 ~ 2027-03，快照月起点的未来 6 个月）', 'covFutureRangeText(cov7) = ' + B.range7);
  chk(B.range6.indexOf('cov09~cov14') === 0, 'covFutureRangeText(cov6) = ' + B.range6);
  chk(B.fieldsDerived.join(',') === 'cov10,cov11,cov12,cov13,cov14,cov15',
    'covFutureFields 走数据推导（传错 legacy 仍返回） = ' + B.fieldsDerived.join(','));
  // 🔴 铁律：断言必须同源复算，不能只比「有没有值」
  chk(B.helperSum === B.manualSum && B.helperSum > 0,
    '同源复算 covFutureSum vs 手加 6 列：' + B.helperSum.toLocaleString() + ' == ' + B.manualSum.toLocaleString() + '（样本 ' + B.sample.rdc + '|' + B.sample.sku + '）');

  // ══════════ C. UI 层 ══════════
  console.log('\n=== C. UI 层：真实渲染产物 ===');
  const nav = async (route, extra) => {
    await p.evaluate(([r, ex]) => {
      if (typeof navigateTo === 'function') navigateTo(r);
      if (ex && typeof ex === 'object') { Object.keys(ex).forEach(k => { window[k] = ex[k]; }); }
      if (ex && ex.__rerender && typeof window[ex.__rerender] === 'function') window[ex.__rerender]();
    }, [route, extra || null]);
    await p.waitForTimeout(2600);
    return p.evaluate(r => { const el = document.getElementById('page-' + r); return el ? el.innerText : ''; }, route);
  };

  // C1 库存周转（v395 修的「右表探测上界」直接影响出货成本是否读到）
  await nav('inventory');
  const C1 = await p.evaluate(() => {
    const inv = dataStore.inventoryTurnover || {};
    const last = (o) => { const a = o || []; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
    // shipmentCost / allLocation / subLocation 的值是 **array[monthCount]**，不是标量
    const arrSum = (o) => Object.keys(o || {}).reduce((s, k) => s + (Array.isArray(o[k]) ? o[k].reduce((a, b) => a + (Number(b) || 0), 0) : 0), 0);
    const sc = inv.shipmentCost || {};
    return {
      months: inv.months || [],
      headLast: last(inv.headquarters), headLen: (inv.headquarters || []).length,
      sharedLast: last(inv.totalSharedLocation),
      allLast: last(inv.totalAllLocation),
      shipmentCostKeys: Object.keys(sc).length,
      shipmentCostSum: arrSum(sc),
      scTotal: sc['总仓'] || null,
      scNe: sc['东北RDC'] || null,
      allLocKeys: Object.keys(inv.allLocation || {}).length,
      allLocSum: arrSum(inv.allLocation),
    };
  });
  chk(C1.months.length > 0 && C1.months[C1.months.length - 1] === '9月',
    '库存周转 months 末位 = ' + C1.months[C1.months.length - 1] + '（期望 9月；全部=' + C1.months.join(',') + '）');
  const nonNull = [C1.headLast, C1.sharedLast, C1.allLast].filter(v => v != null && v !== 0);
  chk(nonNull.length === 3, '三张汇总行最新月均非空：总仓=' + C1.headLast + ' 共享仓=' + C1.sharedLast + ' 全库位=' + C1.allLast);
  // v395 核心：rightStartCol 探测上界从 c<=10 放宽到 c<=20，否则 9月模板(索引11) 读不到出货成本
  chk(C1.shipmentCostKeys >= 8 && C1.shipmentCostSum > 0,
    '出货成本右表已读到：键数=' + C1.shipmentCostKeys + ' 合计=' + C1.shipmentCostSum.toLocaleString() + '（>0 才说明右表列定位正确）');
  chk(Array.isArray(C1.scTotal) && C1.scTotal.length === 9 && (C1.scTotal[8] || 0) > 0,
    '出货成本 「总仓」行 = [' + (C1.scTotal || []).join(',') + ']（长度 9 = 1-9月，末月>0）');
  // 与 JSON 层逐格断言交叉核对（同源复算：xlsx r22c21 = 117059 = 总仓 2026-09 出货成本）
  chk(C1.scTotal && C1.scTotal[8] === 117059,
    '交叉核对：页面 shipmentCost.总仓[8] = ' + (C1.scTotal || [])[8] + ' == JSON 的 r22c21 = 117059');
  chk(C1.allLocKeys === 7 && C1.allLocSum > 0, '全库位周转天数：键数=' + C1.allLocKeys + ' 合计=' + C1.allLocSum.toLocaleString());

  // C2 分仓计划监控：月份下拉选项 + 目标月 + 文案来源表
  await nav('plan-monitor');
  const C2 = await p.evaluate(() => {
    const el = document.getElementById('page-plan-monitor');
    let opts = [];
    const sel = el && el.querySelector('select[onchange*="_planMonthIdx"]');
    if (sel) opts = Array.prototype.map.call(sel.options, o => o.textContent.trim());
    return { opts, text: el ? el.innerText : '', html: el ? el.innerHTML : '', targetIdx: window._planMonthIdx };
  });
  // 下拉项 = getCovMonthConfig('cov7').labels（按设计已截断到 ≤ 当月），必须与其严格一致
  chk(C2.opts.length > 0 && C2.opts.join(',') === B.cfg7.labels.join(','),
    '分仓计划监控 月份下拉 = ' + C2.opts.join(',') + '（应等于 cov7 截断后 labels = ' + B.cfg7.labels.join(',') + '）');
  const targetM = (C2.text.match(/当前目标月\s*(\S+?)（(\d{4}-\d{2})）/) || []);
  chk(!!targetM[2], '页面「当前目标月」= ' + (targetM[1] || '?') + '（' + (targetM[2] || '?') + '）');
  // 目标月必须与 cfg.fields[idx] 反推的月份一致（v395 修的硬编码只到 cov13 → 错位）
  chk(targetM[2] === B.cfg7.yms[Number(C2.targetIdx) || 0],
    '目标月与 cfg.fields[idx] 反推一致：' + targetM[2] + ' == ' + B.cfg7.yms[Number(C2.targetIdx) || 0] + ' (idx=' + C2.targetIdx + ')');
  chk(C2.text.indexOf(targetM[2]) >= 0, '目标月已随下拉联动渲染到页面（' + targetM[2] + '）');
  // 悬浮口径文案在 title 属性里 → 必须查 innerHTML（innerText 不含属性）
  chk(C2.html.indexOf('9月库存覆盖数据') >= 0 && C2.html.indexOf('7月库存覆盖数据') < 0,
    '悬浮口径文案指向 9月库存覆盖数据（且不含 7月）');

  // C3 慢动品页：表头月份 + 陈旧字面量反例
  await nav('slow-moving');
  const C3 = await p.evaluate(() => {
    const el = document.getElementById('page-slow-moving');
    const ths = el ? Array.prototype.map.call(el.querySelectorAll('th'), t => t.innerText.trim()) : [];
    let xAxis = null;
    try { const c = window.echarts && echarts.getInstanceByDom(document.getElementById('chart-slow-trend')); if (c) xAxis = (c.getOption().xAxis[0] || {}).data; } catch (e) {}
    return { ths, xAxis, text: el ? el.innerText : '' };
  });
  const thAll = C3.ths.join('|');
  chk(thAll.indexOf('8月覆盖') >= 0 && thAll.indexOf('9月覆盖') >= 0,
    '慢动品表头含「8月覆盖 / 9月覆盖」→ ' + C3.ths.filter(t => /覆盖/.test(t)).join(' , '));
  chk(thAll.indexOf('未来6月需求合计') >= 0 && thAll.indexOf('7月分仓需求') < 0,
    '「分仓需求」列已改为「未来6月需求合计」→ ' + C3.ths.filter(t => /需求/.test(t)).join(' , '));
  chk((C3.text.match(/8月正常→9月慢动/) || []).length > 0, '新增慢动品卡片标题含「8月正常→9月慢动」');
  chk(Array.isArray(C3.xAxis) && C3.xAxis.join(',') === '8月,9月', '慢动品趋势图 x 轴 = ' + JSON.stringify(C3.xAxis) + '（期望 ["8月","9月"]）');
  const staleSM = ['6月覆盖', '7月覆盖', '7月分仓需求', '6月正常→7月慢动'].filter(s => C3.text.indexOf(s) >= 0);
  chk(staleSM.length === 0, '慢动品页无陈旧月份字面量' + (staleSM.length ? ' → 仍出现: ' + staleSM.join(',') : ''));

  // C4 慢动品根因逻辑页：fut5 标签必须与真实来源（inv.cov6=8月）一致
  await nav('slow-moving-logic');
  const C4 = await p.evaluate(() => { const el = document.getElementById('page-slow-moving-logic'); return el ? el.innerText : ''; });
  chk(C4.indexOf('8月库存覆盖表') >= 0 && C4.indexOf('cov09~cov14') >= 0,
    '逻辑说明页 fut5 来源已指向 8月库存覆盖表 cov09~cov14');
  const badLG = ['7月库存覆盖表', 'cov08~cov13', '7月起点未来6个月', '8月起点未来6个月 / 7月起点'].filter(s => C4.indexOf(s) >= 0);
  chk(C4.indexOf('9月起点未来6个月 / 8月起点未来6个月') >= 0 && badLG.length === 0,
    '「未来需求下降」判定式已改为 9月/8月' + (badLG.length ? ' → 仍出现: ' + badLG.join(',') : ''));

  // C5 年末库存预测：阴影区起点 = 实际末月+1
  await nav('inventory', { _invTab: 'forecast', __rerender: 'renderInventoryTurnover' });
  const C5 = await p.evaluate(() => {
    let ma = null;
    try {
      const c = echarts.getInstanceByDom(document.getElementById('chart-forecast'));
      if (c) { const s = c.getOption().series[1]; ma = s && s.markArea && s.markArea.data; }
    } catch (e) {}
    const el = document.getElementById('page-inventory');
    return { ma, text: el ? el.innerText : '', html: el ? el.innerHTML : '' };
  });
  const maStart = (C5.ma && C5.ma[0] && C5.ma[0][0] && C5.ma[0][0].xAxis) || null;
  chk(maStart === '10月', '年末预测 markArea 起点 = ' + maStart + '（期望 10月 = 实际末月9月+1）');
  chk(C5.text.indexOf('10-12 月预测区间') >= 0 && C5.text.indexOf('H2 预测区间') < 0,
    '阴影区说明文案已改为「10-12 月预测区间」');
  chk(C5.text.indexOf('2026 1-9 月 actual') >= 0, '数据基准文案含「2026 1-9 月 actual」');
  // C5b 「月末库存预测·库存覆盖明细」表头 = 未来 6 月窗口第 1 月（= planMonths[0] = 2026-10）。
  //     🔴 该列值取 monthDemands[0]（未来首月需求），旧代码写死 '<th>9 月需求（支）</th>' → 表头比数据早一月。
  //     这里同时断言 title 说明（title 属性不在 innerText 里 → 必须查 innerHTML）。
  chk(C5.text.indexOf('10 月需求（支）') >= 0 && C5.text.indexOf('9 月需求（支）') < 0,
    '覆盖明细表头 = 「10 月需求（支）」= planMonths[0]（且无陈旧的「9 月需求」）');
  chk(C5.html.indexOf('未来 6 个月需求窗口的第 1 个月') >= 0,
    '覆盖明细表头带 title 口径说明（查 innerHTML，innerText 不含属性）');

  await b.close();
  if (server) server.close();
  const realErrs = errs.filter(e => !/net::ERR|Failed to load resource/.test(e));
  if (realErrs.length) { console.log('\n⚠ 页面 JS 错误 ' + realErrs.length + ' 条：'); realErrs.slice(0, 5).forEach(e => console.log('   ' + e)); }
  console.log('\n' + (bad === 0 && realErrs.length === 0 ? '✅ 全部通过' : '❌ 存在失败项') + '  通过 ' + ok + ' 项，失败 ' + bad + ' 项');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('工具异常:', e && e.stack || e); process.exit(2); });
