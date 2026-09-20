// 导出「分仓计划优化建议」CSV，检查 81014·东北RDC 的订单(支) 导出值
// 用法：node tools/probe-exportadvice-81014.cjs
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript' };
function serve() { return new Promise(res => { const s = http.createServer((req, rq) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rq.writeHead(404); rq.end('nf'); return; } rq.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' }); fs.createReadStream(f).pipe(rq); }); s.listen(0, '127.0.0.1', () => res(s)); }); }
(async () => {
  const srv = await serve(); const port = srv.address().port;
  const exe = (() => { const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'); const c = []; for (const d of fs.readdirSync(base)) { c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(base, d, 'chrome-win64', 'chrome.exe')); } return c.find(p => fs.existsSync(p)); })();
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {}); await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 120000 });
  await page.evaluate(async () => { if (typeof ensureDemandMerged === 'function') await ensureDemandMerged(); });
  await page.waitForTimeout(2500);

  console.log('BUILD_VERSION =', await page.evaluate(() => (typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : 'ERR')));

  // 抓取 exportPlanAdvice 生成的 csv 字符串（劫持 downloadFile）
  const csv = await page.evaluate(() => {
    let captured = null;
    const orig = window.downloadFile;
    window.downloadFile = function (name, content) { captured = { name: name, content: content }; };
    try { if (typeof exportPlanAdvice === 'function') exportPlanAdvice(); } catch (e) { return 'ERR:' + e.message; }
    window.downloadFile = orig;
    return captured ? captured.content : 'ERR:no-capture';
  });
  if (typeof csv === 'string' && csv.startsWith('ERR:')) { console.log('❌', csv); }
  else {
    const lines = csv.split('\n');
    console.log('CSV 行数 =', lines.length, ' 表头 =', lines[0].slice(0, 120));
    const hits = lines.filter(l => l.startsWith('81014,'));
    console.log('\n81014 全部行（共 ' + hits.length + ' 条）:');
    hits.forEach(h => console.log('  ' + h.slice(0, 130)));
    // 解析东北RDC行
    const ne = hits.filter(l => l.indexOf(',东北RDC,') >= 0);
    console.log('\n>>> 81014·东北RDC 导出行:');
    ne.forEach(l => {
      const c = l.split(',');
      console.log('    SKU=' + c[0] + ' 计划(支)=' + c[6] + ' 订单(支)=' + c[7] + ' 完成率=' + c[8] + '% 时间进度=' + c[9] + '%');
    });
    if (!ne.length) console.log('    (无东北RDC行)');
  }

  console.log('\n运行时错误', errs.length, '条');
  errs.slice(0, 8).forEach(e => console.log('  ' + e));
  await browser.close(); srv.close(); process.exit(0);
})();
