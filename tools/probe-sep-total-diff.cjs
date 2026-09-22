/* 一次性核对：页面 dataStore.orderDetail 的 9 月合计 vs data.json 源表合计（定位 190,685 支差额） */
const fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const c = [];
  for (const d of fs.readdirSync(base)) { c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(base, d, 'chrome-win64', 'chrome.exe')); }
  return c.find(p => fs.existsSync(p));
}
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const f = path.join(ROOT, rel);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
(async () => {
  const chromium = require('playwright-core').chromium;
  const srv = await new Promise(r => { const s = server.listen(0, '127.0.0.1', () => r(s)); });
  const port = srv.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin'); await page.fill('#login-pass', 'admin123');
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const r = await page.evaluate(() => {
    const od = dataStore.orderDetail || [];
    const sep = od.filter(d => d.dateStr && d.dateStr.slice(0, 7) === '2026-09');
    const sum = a => a.reduce((s, d) => s + (d.orderQty || 0), 0);
    const byDate = {};
    sep.forEach(d => { byDate[d.dateStr] = byDate[d.dateStr] || { n: 0, q: 0 }; byDate[d.dateStr].n++; byDate[d.dateStr].q += (d.orderQty || 0); });
    const noWh = od.filter(d => d.dateStr && d.dateStr.slice(0, 7) === '2026-09' && !d.warehouse).length;
    return {
      totalRows: od.length,
      months: [...new Set(od.map(d => (d.dateStr || '').slice(0, 7)))].sort(),
      sepRows: sep.length, sepQty: sum(sep), noWh,
      dates: Object.keys(byDate).sort().map(k => k + '=' + byDate[k].q + '(' + byDate[k].n + ')')
    };
  });
  console.log(JSON.stringify(r, null, 1).slice(0, 3000));

  // 源表（data.json）逐日合计
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
  const rows = j.sheets['订单明细'], H = rows[0], I = n => H.indexOf(n);
  const nd = v => { if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10); const m = String(v || '').match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/); return m ? m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0') : String(v || ''); };
  const n = v => { const x = Number(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(x) ? x : 0; };
  const bd = {}; let all = 0;
  for (let i = 1; i < rows.length; i++) { const r2 = rows[i]; if (!r2 || !r2[I('SKU编码')]) continue; const d = nd(r2[I('SAP放行日期')]); const q = n(r2[I('订单支数')]); all += q; bd[d] = bd[d] || { n: 0, q: 0 }; bd[d].n++; bd[d].q += q; }
  console.log('源表 data.json 9月合计 =', all, ' 行数 =', rows.length - 1);
  console.log('源表逐日 =', Object.keys(bd).sort().map(k => k + '=' + bd[k].q + '(' + bd[k].n + ')').join(' '));
  await browser.close(); srv.close();
})().catch(e => { console.error('异常', e.message); process.exit(2); });
