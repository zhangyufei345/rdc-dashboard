// 补货调整跟踪页 DOM 普查：找出节点/耗时主要来源（哪张表、各多少行）
const fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.xlsx': 'application/octet-stream' };
function findC() { const b = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : 'C:/Users/zhangyufei1/AppData/Local/ms-playwright'; const c = []; for (const d of fs.readdirSync(b)) { c.push(path.join(b, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(b, d, 'chrome-win64', 'chrome.exe')); } return c.find(p => fs.existsSync(p)); }
function srv() { const s = http.createServer((q, r) => { const rel = decodeURIComponent(q.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html'; const f = path.join(ROOT, rel); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('nf'); return; } r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }); return new Promise(x => s.listen(0, '127.0.0.1', () => x(s))); }
(async () => {
  const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
  const s = await srv(); const port = s.address().port;
  const b = await chromium.launch({ headless: true, executablePath: findC(), args: ['--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e && e.message)));
  await p.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.fill('#login-user', 'admin').catch(() => {}); await p.fill('#login-pass', 'admin123').catch(() => {});
  await p.click('#login-page button').catch(() => {});
  await p.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).catch(() => {});
  await p.waitForTimeout(6000);
  await p.evaluate(() => { if (typeof ensureInventoryPlan === 'function') ensureInventoryPlan(); });
  await p.waitForFunction(() => window._invPlanReady === true, { timeout: 90000 }).catch(() => {});
  await p.waitForTimeout(1500);
  await p.evaluate(() => navigateTo('adjust-track'));
  await p.waitForTimeout(2500);

  const r = await p.evaluate(() => {
    const page = document.getElementById('page-adjust-track');
    // 每张表：行数 + 单元格数 + 所在卡片标题
    const tables = [...page.querySelectorAll('table.data-table')].map(t => ({
      rows: t.querySelectorAll('tbody tr').length,
      cells: t.querySelectorAll('tbody td').length,
      nodes: t.getElementsByTagName('*').length,
      title: (t.closest('.card') ? (t.closest('.card').querySelector('.card-title') || {}).textContent || '' : '').slice(0, 26)
    }));
    // 按直接子卡片算节点分布
    const zones = [...page.children].map(el => ({
      tag: el.className || el.tagName,
      nodes: el.getElementsByTagName('*').length,
      head: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 22)
    })).sort((a, b2) => b2.nodes - a.nodes).slice(0, 10);
    return {
      pageNodes: page.getElementsByTagName('*').length,
      tables,
      zones,
      cdn: !!window.echarts
    };
  });
  console.log('page-adjust-track 节点总数 =', r.pageNodes);
  console.log('--- 各表 ---');
  r.tables.forEach(t => console.log('  行 ' + String(t.rows).padStart(5) + ' ｜ 单元格 ' + String(t.cells).padStart(6) + ' ｜ 节点 ' + String(t.nodes).padStart(6) + ' ｜ ' + t.title));
  console.log('--- 展开控制条 ---');
  const barTxt = await p.evaluate(() => [...document.querySelectorAll('#page-adjust-track button')].map(b => b.textContent.trim()).join(' | ') || '(无按钮)');
  const cdTxt = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('#page-adjust-track .card')];
    const c = cards.find(x => (x.textContent || '').indexOf('砍量冗余验证') === 0 || (x.querySelector('.card-title') || {}).textContent && x.querySelector('.card-title').textContent.indexOf('砍量冗余验证') >= 0);
    if (!c) return '(未找到卡片)';
    const m = (c.textContent || '').match(/共 \d+ 条，已显示前 \d+ 条/);
    return m ? m[0] : '(无控制条文本)';
  });
  console.log('  冗余表控制条 =', cdTxt);
  console.log('  页面上所有按钮 =', barTxt);
  console.log('--- 节点最多的前 10 个区块 ---');
  r.zones.forEach(z => console.log('  节点 ' + String(z.nodes).padStart(6) + ' ｜ ' + z.tag + ' ｜ ' + z.head));
  console.log('运行时错误 ' + errs.length + (errs.length ? ': ' + errs.slice(0, 2).join(' || ') : ''));
  await b.close(); s.close(); process.exit(0);
})().catch(e => { console.error('异常', e && e.message); process.exit(2); });
