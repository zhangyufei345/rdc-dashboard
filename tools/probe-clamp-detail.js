// 抓取「视觉超 2 行」单元格的原始 HTML，用于定位根因（不猜）
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8926;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 5 分钟'); process.exit(3); }, 300000);
const TARGETS = (process.argv[2] || 'inventory-structure,plan-monitor').split(',');

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext()).newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const cdn = path.join(__dirname, '.cdn-cache');
  await p.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'echarts.min.js')) }).catch(() => {}));
  await p.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'xlsx.full.min.js')) }).catch(() => {}));
  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 90; i++) {
    const ok = await p.evaluate(() => !!(dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(() => false);
    if (ok) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  for (const pg of TARGETS) {
    await p.evaluate(x => navigateTo(x), pg);
    await new Promise(r => setTimeout(r, 3500));
    const out = await p.evaluate(() => {
      const res = [];
      Array.prototype.forEach.call(document.querySelectorAll('.data-table td'), td => {
        if (!(td.textContent || '').trim()) return;
        const cl = td.querySelector('.td-clamp');
        const el = cl || td;
        const cs = getComputedStyle(el);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 17;
        const visual = Math.round(el.clientHeight / lh);
        if (visual <= 2) return;
        res.push({
          visual,
          h: Math.round(el.clientHeight),
          hasClamp: !!cl,
          html: td.innerHTML.slice(0, 420),
          kids: Array.prototype.map.call(td.children, c => c.tagName + '.' + (c.className || '') + '[' + getComputedStyle(c).display + ']').join(' '),
          th: (function(){ const tr = td.parentElement; const i = Array.prototype.indexOf.call(tr.children, td); const ths = tr.parentElement.parentElement ? tr.parentElement.parentElement.querySelectorAll('thead th') : []; return ths[i] ? ths[i].textContent.trim() : ('col' + i); })()
        });
      });
      return res.slice(0, 4);
    }).catch(e => [{ err: e.message.slice(0, 150) }]);
    console.log('\n########## ' + pg + ' ##########');
    out.forEach(o => {
      if (o.err) { console.log('  ERR ' + o.err); return; }
      console.log(`  ── 列「${o.th}」 视觉${o.visual}行/${o.h}px  有clamp=${o.hasClamp}`);
      console.log('     子元素: ' + o.kids);
      console.log('     HTML: ' + o.html.replace(/\s+/g, ' ').slice(0, 300));
    });
    if (!out.length) console.log('  ✅ 无超高单元格');
  }
  clearTimeout(HARD);
  await b.close(); server.close(); process.exit(0);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
