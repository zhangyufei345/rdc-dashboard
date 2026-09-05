// 全页面回归：逐个进入侧边栏页面，抓 pageerror / console.error / 渲染耗时。
// 目的：v204 修复让「拉回数据 / 转储数据 / 分仓计划」三批数据**半年多来第一次真正加载成功**，
//   必须确认没有页面因为「突然有数据了」而崩 —— 这正是用户说的「每次更新功能都会出错」。
// 用法：node tools/e2e-pages-sweep.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8905;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'application/javascript' };
const server = http.createServer((req, res) => {
  const fp = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

const PAGES = ['overview', 'fulfillment', 'shortage', 'shortage-compare', 'replenishment',
  'inventory', 'inventory-structure', 'slow-moving', 'transship', 'plan-monitor',
  'order-insight', 'biz-demand', 'weekend-sim', 'adjust-track', 'data'];

const HARD = setTimeout(() => { console.error('\n❌ 硬超时 10 分钟'); process.exit(3); }, 600000);

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });

  // CDN 拦截：沙箱里浏览器访问 unpkg/jsdelivr 不稳定，控制台会打出
  //   `[v182-debug] CDN 加载状态: echarts=undef, XLSX=undef`，所有图表页渲染成空壳，
  //   导致回归结果全是假阳性（页面 HTML 长度 0）。改为用本地缓存副本喂给浏览器。
  await page.route('**/echarts.min.js', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript',
    body: fs.readFileSync(path.join(__dirname, '.cdn-cache', 'echarts.min.js'))
  }));
  await page.route('**/xlsx.full.min.js', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript',
    body: fs.readFileSync(path.join(__dirname, '.cdn-cache', 'xlsx.full.min.js'))
  }));

  const errs = [];
  page.on('pageerror', (e) => errs.push({ type: 'pageerror', msg: e.message.slice(0, 200) }));
  page.on('console', (m) => { if (m.type() === 'error') errs.push({ type: 'console.error', msg: m.text().slice(0, 200) }); });

  await page.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });

  // 等首屏数据就位
  for (let i = 0; i < 60; i++) {
    const ok = await page.evaluate(() => dataStore && dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100).catch(() => false);
    if (ok) break;
    await page.waitForTimeout(2000);
  }
  console.log('首屏就绪，开始逐页回归\n');

  const rows = [];
  for (const p of PAGES) {
    const before = errs.length;
    let r;
    try {
      // renderPage 内部用 setTimeout 延迟渲染（line 1983），所以必须「导航 → 等待 → 再测量」，
      //   在同一个 evaluate 里同步读 DOM 只会拿到空壳（第一版就是这么全 0 的）。
      r = await Promise.race([
        page.evaluate((pg) => {
          const t0 = performance.now();
          try { navigateTo(pg); } catch (e) { return { err: String(e.message).slice(0, 160) }; }
          return { ms: Math.round(performance.now() - t0) };
        }, p),
        new Promise((_, rj) => setTimeout(() => rj(new Error('navigateTo 超过 30s')), 30000))
      ]);
    } catch (e) { r = { err: e.message.slice(0, 120) }; }

    // 等渲染 + 按需加载（转储/拉回/分仓计划等异步 fetch）落地
    await page.waitForTimeout(3000);
    // 二次渲染兜底：按需数据到位后页面会自己重渲，再等一轮
    await page.waitForTimeout(2000);

    const dom = await page.evaluate((pg) => {
      const el = document.getElementById('page-' + pg);
      if (!el) return { len: 0, empty: true, head: '(页面节点不存在)' };
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        len: txt.length,
        empty: /暂无数据|加载失败|请导入|无数据|数据加载中/.test(txt.slice(0, 600)),
        head: txt.slice(0, 70),
        active: el.classList.contains('active')
      };
    }, p).catch(() => ({ len: 0, empty: true, head: '(读取失败)' }));
    r = Object.assign({}, r, dom);
    const newErrs = errs.slice(before);
    rows.push({ page: p, ...r, errs: newErrs.length });
    const flag = r.err ? '❌' : (newErrs.length ? '⚠️' : (r.empty ? '🟡' : '✅'));
    console.log(`${flag} ${p.padEnd(20)} ${(r.ms != null ? r.ms + 'ms' : '-').padEnd(8)} 文本${String(r.len || 0).padEnd(7)} 错误${newErrs.length}${r.err ? '  ' + r.err : ''}${r.empty && !r.err ? '  ⚠️空态: ' + r.head : ''}`);
    newErrs.forEach((e) => console.log('     └ [' + e.type + '] ' + e.msg));
  }

  console.log('\n═══════════ 汇总 ═══════════');
  const bad = rows.filter((r) => r.err || r.errs > 0);
  const empty = rows.filter((r) => r.empty && !r.err);
  console.log('  页面总数: ' + rows.length + ' | 报错: ' + bad.length + ' | 空态: ' + empty.length);
  if (bad.length) console.log('  报错页面: ' + bad.map((r) => r.page).join(', '));
  if (empty.length) console.log('  空态页面: ' + empty.map((r) => r.page).join(', ') + '（需人工确认是真无数据还是加载失败）');

  clearTimeout(HARD);
  await browser.close();
  server.close();
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('异常:', e.message); clearTimeout(HARD); server.close(); process.exit(2); });
