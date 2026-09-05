// 验证 v205 修复：boot（首拉全量）期间点击「转储数据」，boot 完成后应
//   ① 停在转储页（而不是被踢回 overview）② 自动渲染出数据
// 修复前：init() 里 bootLoad().then 无条件 navigateTo('overview')，把用户刚点的页面顶掉，
//   表现为「点了转储没反应、还被弹回首页」。
// 用法：node tools/e2e-boot-pending.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8935;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 5 分钟'); process.exit(3); }, 300000);

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext()).newPage(); // 全新 context = 冷加载，无 IDB 缓存
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const cdn = path.join(__dirname, '.cdn-cache');
  await p.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'echarts.min.js')) }).catch(() => {}));
  await p.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'xlsx.full.min.js')) }).catch(() => {}));
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0, 160)));

  // 本地静态服务太快（实测 1.5s 就 boot 完），必须限速才造得出「boot 进行中」的点击窗口
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 50, downloadThroughput: 500 * 1024, uploadThroughput: 200 * 1024,
  });
  console.log('限速 500KB/s（42MB 全量约 85s，用于营造 boot 窗口）');

  const st = () => p.evaluate(() => ({
    loaded: !!(typeof dataStore !== 'undefined' && dataStore.loaded),
    bootLoading: !!window._bootLoading,
    pending: window._bootPendingPage || null,
    active: (document.querySelector('.page.active') || {}).id || null,
    transship: (typeof dataStore !== 'undefined' && (dataStore.transship || []).length) || 0,
  })).catch(e => ({ err: e.message.slice(0, 120) }));

  console.log('冷加载（全新 context，无缓存）...');
  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 1500));

  const s0 = await st();
  console.log('[1.5s] boot 中状态: ' + JSON.stringify(s0));
  if (s0.loaded) { console.log('❌ boot 太快已结束，本用例失效（需冷加载首拉窗口）'); clearTimeout(HARD); await b.close(); server.close(); process.exit(1); }

  console.log('→ 在 boot 进行中点击「转储数据」');
  await p.evaluate(() => navigateTo('transship'));
  await new Promise(r => setTimeout(r, 1000));
  console.log('[点击后1s] ' + JSON.stringify(await st()));

  console.log('→ 等待 boot 完成...');
  let ok = false;
  for (let i = 0; i < 90; i++) {
    const s = await st();
    if (s.loaded && !s.bootLoading) { ok = true; console.log('  boot 完成 (等待' + (1.5 + 1 + i * 2) + 's)'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!ok) console.log('  ⚠️ 180s 内 boot 未完成');

  // 给重新渲染（renderPage 走 setTimeout）+ 按需加载留出时间
  await new Promise(r => setTimeout(r, 8000));
  const s1 = await st();
  const txt = await p.evaluate(() => { const el = document.getElementById('page-transship'); return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }).catch(() => '');

  console.log('\n═══ boot 完成后 ═══');
  console.log('  当前活动页: ' + s1.active);
  console.log('  转储行数  : ' + s1.transship);
  console.log('  页面文本长度: ' + txt.length);
  console.log('  文本摘要  : ' + txt.slice(0, 150));
  console.log('  页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('    └ ' + e));

  const onTransship = s1.active === 'page-transship';
  console.log('\n  ① ' + (onTransship ? '✅ 停在转储页（未被踢回 overview）' : '❌ 被踢到了 ' + s1.active));
  console.log('  ② ' + (s1.transship > 1000 ? ('✅ 转储数据已加载 ' + s1.transship + ' 行') : ('❌ 转储数据为空 (' + s1.transship + ')')));
  console.log('  ③ ' + (txt.length > 200 ? '✅ 页面已渲染出内容' : '❌ 页面无内容'));

  const pass = onTransship && s1.transship > 1000 && txt.length > 200 && errs.length === 0;
  console.log('\n' + (pass ? '✅ 修复生效：boot 期间点的页面会被保留并自动渲染' : '❌ 未达预期'));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
