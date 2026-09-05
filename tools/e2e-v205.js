// v205 本地 E2E：①cold load ②boot中点转储→自动恢复 ③优化建议tab三张图+明细折叠 ④td 2行封顶 ⑤reload缓存路径
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8921;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 10 分钟'); process.exit(3); }, 600000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  // CDN 拦截（沙箱访问不稳定，喂本地副本）
  const cdn = path.join(__dirname, '.cdn-cache');
  await p.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'echarts.min.js')) }).catch(() => {}));
  await p.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'xlsx.full.min.js')) }).catch(() => {}));
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message.slice(0, 160)));
  const URL = `http://127.0.0.1:${PORT}/rdc-dashboard.html`;
  const state = () => p.evaluate(() => ({
    loaded: !!dataStore.loaded, cov7: (dataStore.inventory && dataStore.inventory.cov7 || []).length,
    orders: (dataStore.orderDetail || []).length, transship: (dataStore.transship || []).length,
  })).catch(() => ({}));

  // ── P1 冷加载：验证 boot 进度覆盖层 ──
  console.log('[P1] 冷加载（观察 boot 进度覆盖层）...');
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  await p.evaluate(() => navigateTo('plan-monitor'));
  await sleep(800);
  const overlay = await p.evaluate(() => {
    const el = document.getElementById('boot-loading-note');
    return { note: el ? el.textContent : null, prog: window._bootProgress && window._bootProgress.text };
  }).catch(() => ({}));
  console.log('  覆盖层进度: ' + JSON.stringify(overlay));
  let ok1 = false;
  for (let i = 0; i < 120; i++) {
    const s = await state();
    if (s.loaded && s.cov7 > 100 && s.orders > 100000) { ok1 = true; console.log(`  ✅ 就绪 (${i * 2}s): ` + JSON.stringify(s)); break; }
    if (i % 5 === 0) process.stdout.write('  ...' + JSON.stringify(s) + '\n');
    await sleep(2000);
  }
  if (!ok1) { console.log('  ❌ 冷加载失败'); }

  // ── P2 优化建议 tab：三张图 + 明细折叠 ──
  console.log('[P2] 优化建议 tab...');
  await p.evaluate(() => { window._planTab = 'advice'; window._planMonitorRetry = 0; renderPlanMonitor(); });
  await sleep(2500);
  const adv = await p.evaluate(() => {
    const page = document.getElementById('page-plan-monitor');
    const details = page.querySelector('details');
    return {
      hasTypeChart: !!document.getElementById('pa-chart-type') && document.getElementById('pa-chart-type').querySelector('canvas') !== null,
      hasRdcChart: !!document.getElementById('pa-chart-rdc') && document.getElementById('pa-chart-rdc').querySelector('canvas') !== null,
      hasTopChart: !!document.getElementById('pa-chart-top') && document.getElementById('pa-chart-top').querySelector('canvas') !== null,
      detailsExists: !!details,
      detailsOpen: details ? details.open : null,
      summaryText: details && details.querySelector('summary') ? details.querySelector('summary').textContent.trim().slice(0, 50) : null,
      detailCards: details ? details.querySelectorAll('[onclick*="jumpToAdviceTarget"]').length : 0,
    };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  console.log('  ' + JSON.stringify(adv, null, 1));

  // ── P3 td 2行封顶 ──
  // 必须先切到「有表格」的页面：优化建议页是「三张图 + 折叠明细」，本身没有 .data-table，
  // 直接在当前页测会得到 totalTd=0 的假失败。全看板逐页封顶由 tools/probe-clamp.js 覆盖。
  console.log('[P3] 单元格 2 行封顶（切到计划监控页测量）...');
  await p.evaluate(() => { window._planTab = 'monitor'; window._planMonitorRetry = 0; renderPlanMonitor(); });
  await sleep(3000);
  const clamp = await p.evaluate(() => {
    const tds = document.querySelectorAll('.data-table td');
    let clamped = 0, wrapped = 0;
    tds.forEach(td => { if (td.hasAttribute('data-clamped')) clamped++; if (td.querySelector('.td-clamp')) wrapped++; });
    return { totalTd: tds.length, clamped, wrapped };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  console.log('  ' + JSON.stringify(clamp));

  // ── P4 监控 tab 回归（明细表+图都在）──
  console.log('[P4] 计划监控 tab 回归...');
  await p.evaluate(() => { window._planTab = 'monitor'; window._planMonitorRetry = 0; renderPlanMonitor(); });
  await sleep(3000);
  const mon = await p.evaluate(() => {
    const page = document.getElementById('page-plan-monitor');
    const s = (page.textContent || '').replace(/\s+/g, ' ');
    return { len: s.length, hasFunnel: s.includes('进度漏斗'), hasTable: !!document.getElementById('pm-sku-detail-table'), hasTrend: !!document.getElementById('pm-rdc-trend') };
  }).catch(e => ({ err: e.message.slice(0, 150) }));
  console.log('  ' + JSON.stringify(mon));

  // ── P5 转储页（v204 修复回归）──
  console.log('[P5] 转储页回归...');
  await p.evaluate(() => navigateTo('transship'));
  await sleep(4000);
  const ts5 = await p.evaluate(() => ({ rows: (dataStore.transship || []).length, len: (document.getElementById('page-transship').textContent || '').length })).catch(e => ({ err: e.message.slice(0, 150) }));
  console.log('  ' + JSON.stringify(ts5));

  // ── P6 reload 缓存路径回归 ──
  console.log('[P6] reload 缓存路径...');
  await p.reload({ waitUntil: 'domcontentloaded' });
  let ok6 = false;
  for (let i = 0; i < 90; i++) {
    const s = await state();
    if (s.loaded && s.cov7 > 100 && s.orders > 100000) { ok6 = true; console.log(`  ✅ 缓存就绪 (${i * 2}s): ` + JSON.stringify(s)); break; }
    await sleep(2000);
  }
  if (!ok6) console.log('  ❌ 缓存路径失败: ' + JSON.stringify(await state()));

  console.log('\n═══ 汇总 ═══');
  console.log('页面错误数: ' + errs.length);
  errs.slice(0, 6).forEach(e => console.log('  └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  const pass = ok1 && ok6 && errs.length === 0 && adv.hasTypeChart && adv.hasRdcChart && adv.hasTopChart && adv.detailsExists && clamp.wrapped > 0 && mon.hasTable && ts5.rows > 10000;
  console.log(pass ? '✅ ALL PASS' : '❌ 存在失败项');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
