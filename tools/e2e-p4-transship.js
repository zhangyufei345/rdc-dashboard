// P4 专项：验证「更新当月订单后转储数据不再丢失」
//
// 关键发现（踩坑两次后总结）：
//   1. dataStore 是顶层 const，不在 window 上，**但** page.evaluate 的代码在同一个 realm
//      的全局作用域里求值，能看到顶层 let/const → 可以直接读 dataStore.transship.length，
//      不必绕道 IndexedDB（第一版脚本读 IDB 拿不到实时内存态，判定失准）。
//   2. 进转储页（navigateTo('transship')）会触发 renderTransship 全量渲染，
//      大数据下长时间占满主线程导致 page.evaluate 永久挂起 → **不要进页面**，
//      直接 await ensureTransship()（顶层 function，挂 window）拿数据即可。
//
// A/B 设计：--control 模式会生成一份「修复回滚」的对照 HTML（无条件清空 transship），
//   跑同一套流程。期望：正式版 transship 保留，对照组 transship 被清空 → 证明测试有效。
//
// 用法：node tools/e2e-p4-transship.js [--control]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8903;
const CONTROL = process.argv.includes('--control');
const SRC = 'rdc-dashboard.html';
const PAGE = CONTROL ? '__p4-control.html' : SRC;

const FIX_LINE = "if (sheetNames.some(function(n) { return /转储/.test(String(n || '')); })) dataStore.transship = [];";
// 对照组除了还原「无条件清空」，再加一个哨兵计数：用来区分
//   「清空根本没执行」vs「清空执行了但随后又被按需加载器补回来」。
const OLD_LINE = 'dataStore.transship = []; window.__CTRL_CLEARED = (window.__CTRL_CLEARED || 0) + 1;';

if (CONTROL) {
  const html = fs.readFileSync(path.join(ROOT, SRC), 'utf8');
  if (!html.includes(FIX_LINE)) { console.error('❌ 找不到修复行，无法生成对照组'); process.exit(2); }
  fs.writeFileSync(path.join(ROOT, PAGE), html.replace(FIX_LINE, OLD_LINE), 'utf8');
  console.log('📋 对照组已生成：' + PAGE + '（无条件清空 transship，模拟修复前行为）\n');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'application/javascript' };
const server = http.createServer((req, res) => {
  const fp = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

// 带死线的 evaluate：主线程被渲染占满时不拖死整个脚本
async function ev(page, fn, ms) {
  let t;
  const dead = new Promise((r) => { t = setTimeout(() => r('__TIMEOUT__'), ms); });
  try { return await Promise.race([page.evaluate(fn).catch((e) => ({ __err: String(e.message).slice(0, 160) })), dead]); }
  finally { clearTimeout(t); }
}

const SNAP = () => ({
  ts: (dataStore.transship || []).length,
  shortage: (dataStore.shortage || []).length,
  ord: (dataStore.orderDetail || []).length,
  cov7: (dataStore.inventory && dataStore.inventory.cov7) ? dataStore.inventory.cov7.length : 0,
  loaded: dataStore.loaded
});

async function waitState(page, pred, label, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const r = await ev(page, SNAP, 15000);
    if (r && r !== '__TIMEOUT__' && !(r && r.__err)) last = r;
    if (last && pred(last)) { console.log('  [' + label + '] ' + Math.round((Date.now() - t0) / 1000) + 's → ' + JSON.stringify(last)); return last; }
    await page.waitForTimeout(2000);
  }
  console.log('  [' + label + '] ⚠️ 超时，当前: ' + JSON.stringify(last));
  return last;
}

// 稳定判定：连续 3 次（间隔 2s）读到相同 transship 行数才认为状态已定。
//   踩坑：waitState 一达标就读数，可能在 refreshFromManifest 应用 data.json（replace）
//   **之前**就取到值 —— 对照组第一次跑就是这样误判成「未丢失」。
//   不加这段，正式版的「通过」同样可能是「清空还没发生」，结论不可信。
async function settle(page, label, maxMs) {
  const t0 = Date.now();
  let prev = null, same = 0, last = null;
  while (Date.now() - t0 < maxMs) {
    const r = await ev(page, SNAP, 15000);
    if (r && r !== '__TIMEOUT__' && !(r && r.__err)) {
      last = r;
      same = (prev !== null && prev === r.ts) ? same + 1 : 0;
      prev = r.ts;
      if (same >= 2) { console.log('  [' + label + '] 稳定于 ts=' + r.ts + '（' + Math.round((Date.now() - t0) / 1000) + 's）'); return r; }
    }
    await page.waitForTimeout(2000);
  }
  console.log('  [' + label + '] ⚠️ 未稳定，最后 ts=' + (last && last.ts));
  return last;
}

const HARD = setTimeout(() => { console.error('\n❌ 硬超时 5 分钟，强制退出'); process.exit(3); }, 300000);

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  page.on('pageerror', (e) => console.log('  PAGEERROR: ' + e.message.slice(0, 160)));
  // 记录 reload 后实际拉取了哪些数据文件 —— 用来确认 replace 模式真的跑过
  let netHits = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/\/(data(-20\d\d-\d\d)?|inventory-(core|master|plan|extra|status)|transship|manifest)\.json/.test(u)) {
      netHits.push(u.split('/').pop());
    }
  });

  const tag = CONTROL ? '[对照组·修复前]' : '[正式版·修复后]';

  console.log(tag + ' [1/5] 首次加载（等 cov7 就位）...');
  await page.goto(`http://127.0.0.1:${PORT}/${PAGE}`, { waitUntil: 'domcontentloaded' });
  await waitState(page, (s) => s.cov7 > 100, '冷加载', 180000);

  console.log(tag + ' [2/5] 触发三个按需加载器（不进页面，避免渲染阻塞主线程）...');
  const r1 = await ev(page, async () => {
    const t0 = performance.now();
    await ensureTransship();
    const tTs = Math.round(performance.now() - t0);
    const t1 = performance.now();
    await ensureInventoryExtra();
    const tEx = Math.round(performance.now() - t1);
    const t2 = performance.now();
    await ensureInventoryPlan();
    const tPl = Math.round(performance.now() - t2);
    return {
      transship: (dataStore.transship || []).length,
      pullback: (dataStore.inventory && dataStore.inventory.pullbackRows) ? dataStore.inventory.pullbackRows.length : -1,
      planSku: (dataStore.inventory && dataStore.inventory.planBySkuRdc) ? Object.keys(dataStore.inventory.planBySkuRdc).length : -1,
      extraLoaded: !!(dataStore.inventory && dataStore.inventory._extraLoaded),
      ms: { transship: tTs, extra: tEx, plan: tPl }
    };
  }, 120000);
  console.log('  ' + JSON.stringify(r1));
  if (!(r1 && r1.transship > 1000)) {
    console.log('  ❌ 转储加载失败（AbortSignal 修复未生效？），无法继续判定');
    process.exit(1);
  }
  console.log('  （v204 修复前这里恒为 0：AbortController.timeout 不存在 → 三处 fetch 全部抛 TypeError）');

  // 顺带量一下转储页渲染耗时（用户抱怨过「点了就死」）
  const renderMs = await ev(page, () => {
    const t0 = performance.now();
    try { renderTransship(); } catch (e) { return { err: String(e.message).slice(0, 120) }; }
    return { ms: Math.round(performance.now() - t0) };
  }, 120000);
  console.log('  转储页 renderTransship 耗时: ' + JSON.stringify(renderMs));

  console.log(tag + ' [3/5] saveToIDB 落盘（模拟部署时的保存动作）...');
  await ev(page, async () => { await saveToIDB(); return 1; }, 60000);

  console.log(tag + ' [4/5] 模拟「只更新 9 月订单」部署 → reload ...');
  await page.evaluate(() => {
    const h = JSON.parse(localStorage.getItem('rdc_manifest_hashes') || '{}');
    delete h['data.json'];
    localStorage.setItem('rdc_manifest_hashes', JSON.stringify(h));
    localStorage.setItem('rdc_deploy_flag', 'SIMULATE_DEPLOY_P4');
  });
  netHits = [];
  await page.reload({ waitUntil: 'domcontentloaded' });
  const after = await waitState(page, (s) => s.cov7 > 100 && s.shortage > 1000 && s.loaded === true, 'reload 后', 180000);
  console.log('  reload 实际拉取: [' + netHits.join(', ') + ']');

  console.log(tag + ' [5/5] 复检内存中的转储数据（等状态稳定）...');
  const final = await settle(page, '稳定判定', 120000);
  const cleared = await ev(page, () => window.__CTRL_CLEARED || 0, 15000);
  if (CONTROL) console.log('  哨兵 __CTRL_CLEARED（replace 触发清空次数）= ' + cleared);

  const tsBefore = (r1 && typeof r1 === 'object') ? r1.transship : r1;
  console.log('\n═══════════ P4 结论 ' + tag + ' ═══════════');
  console.log('  部署前转储行数: ' + tsBefore);
  console.log('  部署后转储行数: ' + (final && final.ts));
  console.log('  （对照组佐证）缺货行数=' + (final && final.shortage) + '、订单行数=' + (final && final.ord) + ' → replace 模式确实跑过');

  let ok;
  if (CONTROL) {
    ok = final && final.ts === 0 && final.shortage > 1000;
    console.log(ok ? '  ✅ 对照组如期丢失转储数据（说明本测试能抓到该 Bug）' : '  ⚠️ 对照组未复现丢失 —— 测试灵敏度存疑');
  } else {
    ok = final && final.ts === tsBefore && final.shortage > 1000;
    console.log(ok ? '  ✅ 转储数据跨部署完整保留（replace 未再误清空）' : '  ❌ 转储数据丢失 —— 修复未生效');
  }

  clearTimeout(HARD);
  await browser.close();
  server.close();
  if (CONTROL) { try { fs.unlinkSync(path.join(ROOT, PAGE)); } catch (e) {} }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('异常:', e.message); clearTimeout(HARD); server.close(); process.exit(2); });
