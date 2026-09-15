#!/usr/bin/env node
/**
 * v346 验证：「按 RDC」堆叠图的「缺货率(条)」折线
 *   ① 页面运行时零报错
 *   ② ECharts 里确有 line series「缺货率(条)」+ 顶部第二 x 轴（max 100）
 *   ③ 折线每点值 == 页面自身 buildAdjComputed() 复算的 缺货条数 ÷ 已走完条数（同源核对）
 *   ④ 顺带核对离线沙箱 orderDetail 构造口径（raw / norm）与页面 dataStore 的差异
 *
 * 用法（项目根执行，输出重定向到文件避免 coreutils 缺失）：
 *   NODE_PATH=... node tools/verify-adjrdc-line.cjs > tools/_out/adjrdc.txt 2>&1
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const cands = [];
  for (const d of fs.readdirSync(base)) {
    cands.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    cands.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  const hit = cands.find(p => fs.existsSync(p));
  if (!hit) throw new Error('ms-playwright 下未找到 chromium');
  return hit;
}
function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// ---------- 离线沙箱：raw / norm 两种 skuCode 口径 ----------
const html = fs.readFileSync(path.join(ROOT, 'rdc-dashboard.html'), 'utf8');
function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('fn not found: ' + name);
  let d = 0;
  const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
function grabLine(src, needle) {
  const i = src.indexOf(needle);
  if (i < 0) throw new Error('line not found: ' + needle);
  return src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i));
}
const parts = [];
['const ADJ_TRANSPORT', 'const ADJ_WINDOW_DAYS', 'const ADJ_RDC_FULL', 'const ADJ_TYPE_ORDER', 'const ADJ_TYPE_COLORS']
  .forEach(k => parts.push(grabLine(html, k)));
parts.push(/const CN_PUBLIC_HOLIDAYS = new Set\(\[[\s\S]*?\]\);/.exec(html)[0]);
['isWorkday', '_adjDateAdd', '_adjFmtNum', '_adjBoxSpec', '_adjIsH', '_adjTypeColor', '_adjTypeList', '_adjTypeKind', 'buildAdjComputed']
  .forEach(n => parts.push(grabFn(html, n)));

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const adj = JSON.parse(fs.readFileSync(path.join(ROOT, 'adjustments.json'), 'utf8')).adjust;
const boxspec = data.boxSpecMap || {};
const od = data.sheets['订单明细'], H = od[0];
const i_d = H.indexOf('SAP放行日期'), i_s = H.indexOf('SKU编码'), i_w = H.indexOf('仓库名称'),
      i_q = H.indexOf('订单支数'), i_sh = H.indexOf('首日缺货量');
const EPOCH = Date.UTC(1899, 11, 30);
function offRun(mode) {
  const list = [];
  for (let i = 1; i < od.length; i++) {
    const r = od[i];
    if (!r || r[i_d] == null) continue;
    const ds = new Date(EPOCH + r[i_d] * 86400000).toISOString().slice(0, 10);
    let sk = String(r[i_s] == null ? '' : r[i_s]).trim();
    if (mode === 'norm') sk = sk.replace(/\.0$/, '').replace(/^0+/, '') || '0';
    list.push({ dateStr: ds, skuCode: sk, warehouse: r[i_w], orderQty: r[i_q] || 0, firstDayShort: r[i_sh] || 0 });
  }
  const specMap = {};
  Object.keys(boxspec).forEach(k => {
    let kk = String(k).trim();
    if (mode === 'norm') kk = kk.replace(/\.0$/, '').replace(/^0+/, '') || '0';
    specMap[kk] = boxspec[k];
  });
  global.window = { _boxSpec: specMap, _skuIsHainan: {} };
  global.dataStore = { adjustRecords: adj, orderDetail: list };
  const c = new Function(parts.join('\n') + '\nreturn buildAdjComputed();')();
  return { c, first3: list.slice(0, 3) };
}
const offRaw = offRun('raw');
const offNorm = offRun('norm');
const BUILD = /const BUILD_VERSION = (\d+)/.exec(html)[1];
console.log('源码 BUILD_VERSION =', BUILD, '| 离线 maxOrd(raw) =', offRaw.c.maxOrd, '| 离线 maxOrd(norm) =', offNorm.c.maxOrd);

function perRdc(c, cats) {
  return cats.map(rd => {
    const gCuts = c.list.filter(r => r.rdc === rd && r.cut > 0);
    const gDone = gCuts.filter(r => r.status === '已完成');
    const gShort = gDone.filter(r => r.shortBoxes > 0);
    return { rd, cuts: gCuts.length, done: gDone.length, short: gShort.length };
  });
}

(async () => {
  let chromium;
  try { chromium = require('playwright-core').chromium; }
  catch (e) { console.error('需要 playwright-core（设置 NODE_PATH）'); process.exit(2); }
  const liveUrl = process.env.LIVE_URL || '';
  const server = liveUrl ? null : await startServer();
  const port = server ? server.address().port : 0;
  const baseUrl = liveUrl || ('http://127.0.0.1:' + port);
  const entry = liveUrl ? (liveUrl.replace(/\/+$/, '') + '/') : (baseUrl + '/rdc-dashboard.html');
  if (liveUrl) console.log('直连线上：', entry);
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e && e.message ? e.message : String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 300)); });

  await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  const loaded = await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 })
    .then(() => true).catch(() => false);
  console.log('数据装载:', loaded ? 'OK' : '超时');
  await page.evaluate(() => navigateTo('adjust-track'));
  await page.waitForTimeout(3000);

  const live = await page.evaluate(() => {
    const dom = document.getElementById('adj-chart-rdc');
    const inst = window.echarts && window.echarts.getInstanceByDom(dom);
    if (!inst) return { err: 'echarts instance missing' };
    const o = inst.getOption();
    const cats = (o.yAxis && o.yAxis[0] ? o.yAxis[0].data : []).slice();
    const line = (o.series || []).find(s => s.name === '缺货率(条)');
    const c = window.buildAdjComputed();
    const per = cats.map(rd => {
      const gCuts = c.list.filter(r => r.rdc === rd && r.cut > 0);
      const gDone = gCuts.filter(r => r.status === '已完成');
      const gShort = gDone.filter(r => r.shortBoxes > 0);
      return { rd, cuts: gCuts.length, done: gDone.length, short: gShort.length };
    });
    const cuts = c.list.filter(r => r.cut > 0);
    const doneAll = cuts.filter(r => r.status === '已完成');
    const ods = (typeof dataStore !== 'undefined' && dataStore && dataStore.orderDetail) ? dataStore.orderDetail : [];
    return {
      cats, per,
      cutTotal: cuts.length, doneTotal: doneAll.length,
      allTotal: c.list.length, maxOrd: c.maxOrd,
      lineType: line ? line.type : null, lineData: line ? line.data : null,
      xAxes: (o.xAxis || []).map(a => ({ name: a.name, pos: a.position, max: a.max })),
      seriesCount: (o.series || []).length,
      kpi: Array.from(document.querySelectorAll('#page-adjust-track .kpi-card')).map(e => e.innerText.replace(/\s+/g, ' ')),
      title: (Array.from(document.querySelectorAll('#page-adjust-track .card-title')).map(e => e.textContent).find(t => /按 RDC/.test(t)) || '(未找到 RDC 卡片标题)'),
      od3: ods.slice(0, 3).map(d => ({ d: d.dateStr, sku: d.skuCode, wh: d.warehouse, fds: d.firstDayShort, oq: d.orderQty })),
      odTotal: ods.length, skuSample: Array.from(new Set(ods.slice(0, 3000).map(d => d.skuCode))).slice(0, 6)
    };
  });
  // 视觉留证：① ECharts 自身导出（最可靠，不依赖截图渲染）② 滚动到图表后整屏截图（看布局/图例是否折行）
  const shotDir = path.join(ROOT, 'tools', '_out');
  fs.mkdirSync(shotDir, { recursive: true });
  const dataUrl = await page.evaluate(() => {
    const dom = document.getElementById('adj-chart-rdc');
    const inst = window.echarts && window.echarts.getInstanceByDom(dom);
    return inst ? inst.getDataURL({ pixelRatio: 2, backgroundColor: '#fff' }) : null;
  }).catch(() => null);
  if (dataUrl && dataUrl.indexOf(',') > 0) {
    fs.writeFileSync(path.join(shotDir, 'adjrdc-chart.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('图表已导出 tools/_out/adjrdc-chart.png');
  } else console.log('图表导出失败（getDataURL 为空）');
  await page.evaluate(() => { const el = document.getElementById('adj-chart-rdc'); if (el) el.scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shotDir, 'adjrdc-viewport.png') })
    .then(() => console.log('整屏截图已存 tools/_out/adjrdc-viewport.png')).catch(e => console.log('整屏截图失败:', e.message));

  await browser.close();
  if (server) server.close();

  if (live.err) { console.log('❌ 页面侧取不到图：', live.err); process.exit(1); }

  console.log('\n卡片标题 =', live.title);
  console.log('系列数 =', live.seriesCount, '| x 轴 =', JSON.stringify(live.xAxes), '| 折线类型 =', live.lineType);
  console.log('页面 KPI 卡 =', JSON.stringify(live.kpi, null, 0));
  console.log('页面内复算：记录 ' + live.allTotal + ' / 扣减 ' + live.cutTotal + ' / 走完 ' + live.doneTotal + ' / maxOrd ' + live.maxOrd);
  console.log('orderDetail 行数 =', live.odTotal, '| 前3条 =', JSON.stringify(live.od3));
  console.log('skuCode 样本 =', JSON.stringify(live.skuSample));
  console.log('离线前3条(raw) =', JSON.stringify(offRaw.first3.map(d => ({ d: d.dateStr, sku: d.skuCode, wh: d.warehouse, fds: d.firstDayShort, oq: d.orderQty }))));

  const cats = live.cats;
  const a = perRdc(offRaw.c, cats), b = perRdc(offNorm.c, cats);
  console.log('\nRDC'.padEnd(7) + '│ 页面 分母/分子/率 │ raw 分母/分子/率 │ norm 分母/分子/率 │ 折线值');
  let badLive = 0, badRaw = 0, badNorm = 0;
  cats.forEach((rd, i) => {
    const L = live.per[i];
    const lr = L.done ? Math.round(L.short / L.done * 100) : null;
    const A = a[i]; const B = b[i];
    const ar = A.done ? Math.round(A.short / A.done * 100) : null;
    const br = B.done ? Math.round(B.short / B.done * 100) : null;
    const raw = live.lineData[i];
    const got = (raw === null || raw === undefined || raw === '-' || raw === '') ? null : Number(raw);
    const okL = (lr === null && got === null) || (lr !== null && lr === got);
    if (!okL) badLive++;
    if (!(A.done === L.done && A.short === L.short)) badRaw++;
    if (!(B.done === L.done && B.short === L.short)) badNorm++;
    console.log(rd.padEnd(7) + '│ ' + (L.done + '/' + L.short + '/' + (lr == null ? '—' : lr + '%')).padEnd(18) +
      '│ ' + (A.done + '/' + A.short + '/' + (ar == null ? '—' : ar + '%')).padEnd(18) +
      '│ ' + (B.done + '/' + B.short + '/' + (br == null ? '—' : br + '%')).padEnd(18) +
      '│ ' + (got == null ? '—' : got + '%') + (okL ? ' ✓' : ' ✗'));
  });

  console.log('\n① 页面运行时错误:', errs.length ? errs.slice(0, 3) : '无');
  console.log('② 折线 = 页面内复算：' + (badLive === 0 ? '全部一致 ✓' : badLive + ' 个不一致 ✗'));
  console.log('③ 离线 raw 口径与页面一致：' + (badRaw === 0 ? '是 ✓' : badRaw + ' 个 RDC 不一致 ✗'));
  console.log('④ 离线 norm 口径与页面一致：' + (badNorm === 0 ? '是 ✓' : badNorm + ' 个 RDC 不一致 ✗'));
  const ok = errs.length === 0 && badLive === 0 && live.xAxes.length === 2 && live.lineType === 'line';
  console.log(ok ? '\n✅ 功能验证通过（折线数值经页面同源复算核对）' : '\n❌ 未通过');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('工具异常:', e && e.message); process.exit(2); });
