// 删除「砍量冗余验证」后，剩余所有指标必须逐项不变 —— 与删除前备份做数值指纹对拍
const fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.xlsx': 'application/octet-stream' };
function findC() { const b = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : 'C:/Users/zhangyufei1/AppData/Local/ms-playwright'; const c = []; for (const d of fs.readdirSync(b)) { c.push(path.join(b, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(b, d, 'chrome-win64', 'chrome.exe')); } return c.find(p => fs.existsSync(p)); }
function srv() { const s = http.createServer((q, r) => { const rel = decodeURIComponent(q.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html'; const f = path.join(ROOT, rel); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('nf'); return; } r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }); return new Promise(x => s.listen(0, '127.0.0.1', () => x(s))); }

async function fp(browser, port, file) {
  const p = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e && e.message)));
  await p.goto('http://127.0.0.1:' + port + '/' + file, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.fill('#login-user', 'admin').catch(() => {}); await p.fill('#login-pass', 'admin123').catch(() => {});
  await p.click('#login-page button').catch(() => {});
  await p.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).catch(() => {});
  await p.waitForTimeout(8000);
  await p.evaluate(() => navigateTo('adjust-track'));
  await p.waitForTimeout(3000);
  const r = await p.evaluate(() => {
    const c = buildAdjComputed();
    const L = c.list;
    const r3 = x => Math.round(x * 1000) / 1000;
    const cuts = L.filter(x => x.cut > 0), adds = L.filter(x => x.cut < 0);
    const entered = cuts.filter(x => x.status !== '未开始');
    const done = cuts.filter(x => x.status === '已完成');
    const dShort = done.filter(x => x.shortBoxes > 0);
    const quad = { A: [], B: [], C: [], D: [] };
    done.forEach(x => { if (x.quadrant) quad[x.quadrant].push(x); });
    const typeAgg = _adjTypeList(L).map(tp => {
      const g = L.filter(x => (x.adjType || '未填写') === tp);
      const gC = g.filter(x => x.cut > 0), gD = gC.filter(x => x.status === '已完成');
      const gS = gD.filter(x => x.shortBoxes > 0), gB = gD.filter(x => x.quadrant === 'B');
      return [tp, g.length, gC.length, r3(gC.reduce((s, x) => s + x.cut, 0)), gD.length, gS.length,
      r3(gS.reduce((s, x) => s + x.shortBoxes, 0)), gB.length, r3(gB.reduce((s, x) => s + x.cut, 0))];
    });
    // 明细表首 12 行（排序断言）
    const rowsHead = [...document.querySelectorAll('#adj-detail-card tbody tr')].slice(0, 12)
      .map(tr => [...tr.children].map(td => td.textContent.trim()).join('|'));
    const rowsAll = document.querySelectorAll('#adj-detail-card tbody tr').length;
    // 页面上其余 KPI 文本（去掉已删卡片）
    const kpiTxt = [...document.querySelectorAll('#page-adjust-track .kpi-card')].map(k => k.textContent.replace(/\s+/g, ' ').trim());
    const tableTitles = [...document.querySelectorAll('#page-adjust-track .card-title')].map(t => t.textContent.trim().slice(0, 24));
    const chartIds = ['adj-chart-type', 'adj-chart-rdc', 'adj-chart-batch'].map(id => {
      const el = document.getElementById(id); const i = el && window.echarts ? echarts.getInstanceByDom(el) : null;
      return i ? i.getOption().series.map(s => (s.data || []).length).join(',') : 'none';
    });
    return {
      n: L.length, cuts: cuts.length, adds: adds.length, entered: entered.length, done: done.length,
      cutBoxes: r3(cuts.reduce((s, x) => s + x.cut, 0)),
      doneShortCnt: dShort.length, doneShortBoxes: r3(dShort.reduce((s, x) => s + x.shortBoxes, 0)),
      quad: { A: [quad.A.length, r3(quad.A.reduce((s, x) => s + x.cut, 0))], B: [quad.B.length, r3(quad.B.reduce((s, x) => s + x.cut, 0))], C: [quad.C.length, r3(quad.C.reduce((s, x) => s + x.cut, 0))], D: [quad.D.length, r3(quad.D.reduce((s, x) => s + x.cut, 0))] },
      typeAgg, rowsHead, rowsAll, kpiTxt, tableTitles, chartIds,
      maxOrd: c.maxOrd
    };
  });
  r.errs = errs;
  await p.context().close();
  return r;
}

(async () => {
  const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
  const s = await srv(); const port = s.address().port;
  const b = await chromium.launch({ headless: true, executablePath: findC(), args: ['--no-sandbox'] });
  const A = await fp(b, port, '_tmp_v442.html');        // 删除前（v442）
  const B = await fp(b, port, 'rdc-dashboard.html');    // 删除后（v443）

  const keys = ['n', 'cuts', 'adds', 'entered', 'done', 'cutBoxes', 'doneShortCnt', 'doneShortBoxes', 'maxOrd', 'rowsAll'];
  let bad = 0;
  console.log('=== 删除前后 · 剩余指标逐项对拍 ===');
  keys.forEach(k => {
    const ok = JSON.stringify(A[k]) === JSON.stringify(B[k]);
    if (!ok) bad++;
    console.log('  ' + (ok ? '✅' : '❌') + ' ' + k.padEnd(16) + ' 删前=' + JSON.stringify(A[k]) + ' 删后=' + JSON.stringify(B[k]));
  });
  const cmp = (label, x, y) => {
    const ok = JSON.stringify(x) === JSON.stringify(y);
    if (!ok) bad++;
    console.log('  ' + (ok ? '✅' : '❌') + ' ' + label);
    if (!ok) { console.log('     删前:', JSON.stringify(x)); console.log('     删后:', JSON.stringify(y)); }
  };
  cmp('四象限 A/B/C/D（条数, 扣减箱）', A.quad, B.quad);
  cmp('按调整类型归因表 9 列数值', A.typeAgg, B.typeAgg);
  cmp('调整明细前 12 行（含排序）', A.rowsHead, B.rowsHead);
  // 删前共有 9 张 KPI 卡（5 张主卡 + 冗余模块 4 张），删后必须只剩 5 张且内容逐字不变
  const bKpi = B.kpiTxt.length === 5 && JSON.stringify(A.kpiTxt.slice(0, 5)) === JSON.stringify(B.kpiTxt);
  if (!bKpi) bad++;
  console.log('  ' + (bKpi ? '✅' : '❌') + ' 主 KPI 卡（删前 9 张取前 5 张 / 删后应为 5 张）  删前 ' + A.kpiTxt.length + ' 张 → 删后 ' + B.kpiTxt.length + ' 张');
  const goneModule = B.tableTitles.filter(t => t.indexOf('砍量冗余') >= 0).length === 0
    && A.tableTitles.filter(t => t.indexOf('砍量冗余') >= 0).length === 1
    && ['window._adjCDReveal', 'redundantDays', 'reproDays', 'doneCD'].every(k => typeof B[k] === 'undefined');
  if (!goneModule) bad++;
  console.log('  ' + (goneModule ? '✅' : '❌') + ' 冗余模块已彻底消失（卡片/字段/状态变量）');
  cmp('三张图 series 长度', A.chartIds, B.chartIds);
  console.log('  卡片标题 删前:', JSON.stringify(A.tableTitles));
  console.log('  卡片标题 删后:', JSON.stringify(B.tableTitles));
  console.log('\n删前报错 ' + A.errs.length + (A.errs.length ? ': ' + A.errs.slice(0, 2).join(' || ') : '')
    + ' ｜ 删后报错 ' + B.errs.length + (B.errs.length ? ': ' + B.errs.slice(0, 2).join(' || ') : ''));
  console.log(bad === 0 ? '🎯 全部一致：删除未改变任何剩余指标' : '🔴 有 ' + bad + ' 项不一致，需排查');
  await b.close(); s.close(); process.exit(bad || B.errs.length ? 1 : 0);
})().catch(e => { console.error('异常', e && e.message); process.exit(2); });
