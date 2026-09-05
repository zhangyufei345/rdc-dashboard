// 复现用户场景：慢网络（模拟国内访问 Cloudflare）+ 启动过程中点击菜单
// 场景A：boot 中点「转储数据」→ 再点其他菜单，检查是否失效
// 场景B：boot 中点「分仓计划监控」→ 观察重试是否耗尽成死错误页
// 用法：
//   node tools/e2e-slow-net.js             线上站点 + 限速（默认）
//   node tools/e2e-slow-net.js --local     本地文件 + 限速（验证未部署的改动）
//   node tools/e2e-slow-net.js --fast      不限速对照
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const LOCAL = process.argv.includes('--local');
const FAST = process.argv.includes('--fast');
// 限速下全量 42MB 需 ~4 分钟，两个场景各有一段长轮询，给足 15 分钟
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 15 分钟'); process.exit(3); }, 900000);

const ROOT = path.resolve(__dirname, '..'), PORT = 8931;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const URL = LOCAL ? `http://127.0.0.1:${PORT}/rdc-dashboard.html` : 'https://rdc-dashboard.pages.dev/index.html';

function ts() { return new Date().toTimeString().slice(0, 8); }

(async () => {
  if (LOCAL) {
    await new Promise(r => server.listen(PORT, '127.0.0.1', r));
    console.log('本地静态服务 127.0.0.1:' + PORT + '（测的是工作区文件，非线上）');
  }
  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const errs = [];
  p.on('pageerror', (e) => errs.push(ts() + ' pageerror: ' + e.message.slice(0, 150)));

  if (LOCAL) {
    // 沙箱访问 CDN 不稳 → 喂本地缓存副本，否则图表页全渲染空壳，回归结果全是假阳性
    const cdn = path.join(__dirname, '.cdn-cache');
    await p.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'echarts.min.js')) }).catch(() => {}));
    await p.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'xlsx.full.min.js')) }).catch(() => {}));
  }

  // 慢网络：带宽限到 ~180KB/s，延迟 180ms（模拟国内访问 pages.dev）
  const cdp = await ctx.newCDPSession(p);
  if (!FAST) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 180, downloadThroughput: 180 * 1024, uploadThroughput: 100 * 1024,
    });
    console.log('限速: 180KB/s, 延迟180ms（模拟慢网）');
  } else console.log('不限速对照');

  console.log('\n[' + ts() + '] 打开页面，2 秒后（boot 进行中）开始点击菜单...');
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);

  const bootState = async () => p.evaluate(() => ({
    loaded: !!dataStore.loaded,
    cov7: (dataStore.inventory && dataStore.inventory.cov7 ? dataStore.inventory.cov7.length : 0),
    orders: (dataStore.orderDetail || []).length,
    transship: (dataStore.transship || []).length,
  })).catch(e => ({ err: e.message.slice(0, 100) }));

  console.log('  点击时 boot 状态: ' + JSON.stringify(await bootState()));

  // ── 场景A：boot 中点 转储数据 ──
  console.log('\n─── 场景A: boot中点击「转储数据」───');
  await p.evaluate(() => navigateTo('transship'));
  await p.waitForTimeout(3000);
  let txt = await p.evaluate(() => { const el = document.getElementById('page-transship'); return el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '(无元素)'; });
  console.log('  [3s后] 转储页文本: ' + txt);
  console.log('  状态: ' + JSON.stringify(await bootState()));

  let ok = false;
  for (let i = 0; i < 60; i++) {
    const s = await bootState();
    if (s.transship > 1000) { ok = true; console.log('  [' + ts() + '] 转储数据就绪: ' + s.transship + ' 行 (等待' + (i * 2) + 's)'); break; }
    await p.waitForTimeout(2000);
  }
  if (!ok) console.log('  [' + ts() + '] ⚠️ 120s 内转储数据未就绪');
  await p.waitForTimeout(1000);
  txt = await p.evaluate(() => { const el = document.getElementById('page-transship'); return el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 130) : '(无元素)'; });
  console.log('  [就绪后] 转储页文本: ' + txt);

  console.log('  转储后点击其他菜单（验证导航没被带坏）...');
  for (const pg of ['shortage', 'overview']) {
    const e0 = errs.length;
    await p.evaluate(x => navigateTo(x), pg);
    await p.waitForTimeout(2500);
    const t = await p.evaluate(x => { const el = document.getElementById('page-' + x); return el && el.classList.contains('active') ? (el.textContent || '').replace(/\s+/g, ' ').trim().length : -1; }, pg);
    console.log('    ' + (t > 100 && errs.length === e0 ? '✅' : '❌') + ' ' + pg + ' 文本长度=' + t + ' 新增错误=' + (errs.length - e0));
  }

  // ── 场景B：点 分仓计划监控 ──
  console.log('\n─── 场景B: 点击「分仓计划监控」（观察重试窗口）───');
  await p.evaluate(() => { window._planMonitorRetry = 0; navigateTo('plan-monitor'); });
  await p.waitForTimeout(2500);
  txt = await p.evaluate(() => { const el = document.getElementById('page-plan-monitor'); return el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '(无元素)'; });
  console.log('  [2.5s后] 文本: ' + txt);
  for (let i = 0; i < 150; i++) {
    const s = await bootState();
    if (s.loaded && s.cov7 > 100 && s.orders > 100000) { console.log('  [' + ts() + '] boot 就绪: ' + JSON.stringify(s) + ' (等待' + (i * 2) + 's)'); break; }
    await p.waitForTimeout(2000);
  }
  await p.waitForTimeout(6000); // 给重试循环（2s/次）时间自动恢复
  txt = await p.evaluate(() => { const el = document.getElementById('page-plan-monitor'); return el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '(无元素)'; });
  console.log('  [boot就绪后] plan-monitor 页文本: ' + txt);
  const retryN = await p.evaluate(() => window._planMonitorRetry);
  console.log('  ⭐ 关键判定：数据就绪后页面是否自动恢复（还是停在死错误页）');
  console.log('  当前 _planMonitorRetry=' + retryN + '（旧版 >3 即判死；新版上限 90）');
  const recovered = !/暂无数据|cov7=0行/.test(txt);
  console.log('  ' + (recovered ? '✅ 已自动恢复渲染' : '❌ 仍停在错误页'));

  console.log('\n═══ 汇总 ═══');
  console.log('总错误数: ' + errs.length);
  errs.slice(0, 8).forEach(e => console.log('  └ ' + e));
  clearTimeout(HARD);
  await b.close();
  if (server) server.close();
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
