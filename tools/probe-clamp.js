// 检查全看板表格单元格「视觉行数」是否 ≤2 行
// 判定口径：视觉行数 = clientHeight / 行高（用户眼睛看到的行高）← 这才是「行别太高」的判据
//           内容行数 = scrollHeight / 行高（>2 表示已截断、完整内容在 title 悬浮提示里，属预期）
// 用法：node tools/probe-clamp.js [页1,页2,...]
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8924;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 8 分钟'); process.exit(3); }, 480000);
const PAGES = process.argv[2] ? process.argv[2].split(',')
  : ['overview', 'fulfillment', 'order-insight', 'shortage', 'transship', 'replenishment',
     'inventory-structure', 'slow-moving', 'plan-monitor', 'inventory-coverage-detail', 'biz-demand'];

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await (await b.newContext()).newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const cdn = path.join(__dirname, '.cdn-cache');
  await p.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'echarts.min.js')) }).catch(() => {}));
  await p.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'xlsx.full.min.js')) }).catch(() => {}));
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0, 150)));
  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 90; i++) {
    const ok = await p.evaluate(() => !!(dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(() => false);
    if (ok) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('数据就绪，开始逐页检查「视觉行数」\n');
  let worst = 0, badPages = [], tallCells = [];
  for (const pg of PAGES) {
    const e0 = errs.length;
    await p.evaluate(x => navigateTo(x), pg);
    await new Promise(r => setTimeout(r, 3500));
    const r = await p.evaluate(() => {
      const tds = Array.prototype.slice.call(document.querySelectorAll('.data-table td'));
      let maxVisual = 0, maxContent = 0, wrapped = 0, overflow = 0, unclamped = 0, sample = '', tall = [], maxRowH = 0;
      Array.prototype.forEach.call(document.querySelectorAll('.data-table tbody tr'), tr => {
        const h = tr.getBoundingClientRect().height;
        if (h > maxRowH) maxRowH = h;
      });
      tds.forEach(td => {
        if (!(td.textContent || '').trim()) return;
        const cl = td.querySelector('.td-clamp');
        // clientHeight 含 padding（td 上下各 8px ≈ 半行），直接除行高会把未包裹的 td
        // 系统性高估 ~1 行。这里减去纵向 padding 再算，才等于用户看到的文字行数。
        const measure = function(el) {
          const cs = getComputedStyle(el);
          const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 17;
          const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
          const ch = Math.max(0, el.clientHeight - padV);
          const sh = Math.max(0, el.scrollHeight - padV);
          return { visual: Math.round(ch / lh), content: Math.round(sh / lh), px: el.clientHeight };
        };
        if (cl) {
          wrapped++;
          const m = measure(cl);
          if (m.content > 2) overflow++;
          if (m.content > maxContent) maxContent = m.content;
          if (m.visual > maxVisual) { maxVisual = m.visual; sample = (td.textContent || '').trim().slice(0, 40); }
          if (m.visual > 2 && tall.length < 3) tall.push('已包裹但视觉超高 ' + cl.clientHeight + 'px「' + (td.textContent || '').trim().slice(0, 30) + '」');
        } else {
          const m = measure(td);
          if (m.visual > 2) {
            unclamped++;
            if (m.visual > maxVisual) { maxVisual = m.visual; sample = (td.textContent || '').trim().slice(0, 40); }
            if (tall.length < 3) {
              tall.push('【未包裹】' + td.clientHeight + 'px 子=' + (td.firstElementChild ? td.firstElementChild.tagName + '.' + (td.firstElementChild.className || '') : '(纯文本)') + '「' + (td.textContent || '').trim().slice(0, 30) + '」');
            }
          }
        }
      });
      return { tds: tds.length, wrapped, overflow, unclamped, maxVisual, maxContent, sample, tall };
    }).catch(e => ({ err: e.message.slice(0, 120) }));
    const flag = (r.maxVisual <= 2 && errs.length === e0) ? '✅' : '❌';
    console.log(`  ${flag} ${String(pg).padEnd(26)} td=${String(r.tds).padEnd(6)} 已封顶=${String(r.wrapped).padEnd(6)} 内容被截=${String(r.overflow).padEnd(4)} 视觉最大=${String(r.maxVisual).padEnd(2)}行 内容最长=${String(r.maxContent).padEnd(2)}行 未包裹超高=${r.unclamped}`);
    (r.tall || []).forEach(t => console.log('        -> ' + t));
    if (r.err) console.log('        -> ERR ' + r.err);
    if (r.maxVisual > 2) { badPages.push(pg + '(视觉' + r.maxVisual + '行' + (r.sample ? ', 例:' + r.sample : '') + ')'); tallCells = tallCells.concat((r.tall || []).map(t => pg + ' → ' + t)); }
    if (r.maxVisual > worst) worst = r.maxVisual;
  }
  console.log('\n===== 结论 =====');
  console.log('全看板最大视觉行数: ' + worst + ' 行');
  console.log(badPages.length ? ('❌ 视觉超过 2 行的页面: ' + badPages.join(' | ')) : '✅ 所有页面单元格视觉均 ≤ 2 行');
  if (tallCells.length) { console.log('   超高单元格明细:'); tallCells.slice(0, 12).forEach(t => console.log('     · ' + t)); }
  console.log('页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('  └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(badPages.length === 0 && errs.length === 0 ? 0 : 1);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
