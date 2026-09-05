// 诊断：线上「转储行数已到 23790，但页面范围仍显示 2026-01 至 2026-06」。
// 目的：确认 ensureInventoryExtra 完成后的 renderPage() 到底有没有重渲染。
// 抓全部 console 日志 + 每 5s 打点（行数 / 页面范围 / currentPage / _bootLoading）。
// 用法：node tools/probe-transship-rerender.js [live|local]   默认 live
const path = require('path'), fs = require('fs'), http = require('http');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const MODE = (process.argv[2] || 'live');
const ROOT = path.resolve(__dirname, '..'), PORT = 8941;
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 10 分钟'); process.exit(3); }, 600000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let server = null, URL;
  if (MODE === 'local') {
    const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };
    server = http.createServer((q, s) => {
      const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
      s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(s);
    });
    await new Promise(r => server.listen(PORT, '127.0.0.1', r));
    URL = `http://127.0.0.1:${PORT}/rdc-dashboard.html`;
  } else URL = 'https://rdc-dashboard.pages.dev/';

  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext()).newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  if (MODE === 'local') {
    const cdn = path.join(__dirname, '.cdn-cache');
    await p.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'echarts.min.js')) }).catch(() => {}));
    await p.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'xlsx.full.min.js')) }).catch(() => {}));
  }
  const logs = [];
  p.on('console', m => {
    const t = m.text();
    if (/ensureInventoryExtra|ensureTransship|转储|renderPage|boot/i.test(t)) logs.push((m.type() === 'error' ? 'ERR ' : '') + t.slice(0, 160));
  });
  p.on('pageerror', e => logs.push('PAGEERROR ' + e.message.slice(0, 160)));

  const t0 = Date.now();
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 150; i++) {
    const ok = await p.evaluate(() => !!(window.dataStore && dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(() => false);
    if (ok) break;
    await sleep(2000);
  }
  console.log('[' + MODE + '] boot 就绪，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  logs.length = 0;

  await p.evaluate(() => navigateTo('transship'));
  console.log('\n打点（每 5s）：');
  console.log('   t(s) |   行数 | 页面显示范围        | currentPage | _bootLoading | _invExtraReady | _transshipReady');
  for (let i = 0; i < 40; i++) {
    const s = await p.evaluate(() => {
      const el = document.getElementById('page-transship');
      const t = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
      const m = t.match(/(\d+)条记录\s*·\s*(\d{4}-\d{2})\s*至\s*(\d{4}-\d{2})/);
      return {
        rows: (dataStore.transship || []).length,
        range: m ? (m[2] + '→' + m[3]) : '(无)',
        cur: (typeof currentPage === 'string') ? currentPage : '?',
        boot: !!window._bootLoading,
        extra: !!window._invExtraReady,
        ts: !!window._transshipReady,
      };
    }).catch(e => ({ err: e.message.slice(0, 100) }));
    console.log('  ' + String(((Date.now() - t0) / 1000).toFixed(0)).padStart(6) + ' | ' +
      String(s.rows).padStart(6) + ' | ' + String(s.range).padEnd(19) + ' | ' +
      String(s.cur).padEnd(11) + ' | ' + String(s.boot).padEnd(12) + ' | ' +
      String(s.extra).padEnd(14) + ' | ' + s.ts);
    if (i >= 3 && s.rows > 23000 && /→2026-08/.test(s.range)) { console.log('  → 已收敛（行数满 + 范围到 8 月）'); break; }
    await sleep(5000);
  }

  console.log('\n相关 console 日志（最近 25 条）：');
  logs.slice(-25).forEach(l => console.log('  ' + l));

  clearTimeout(HARD);
  await b.close(); if (server) server.close();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
