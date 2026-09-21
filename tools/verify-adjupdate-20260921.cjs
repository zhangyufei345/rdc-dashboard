#!/usr/bin/env node
/**
 * 「更新RDC补货调整记录」专项验证（2026-09-21，纯数据更新）
 *
 * 源：C:/Users/zhangyufei1/Desktop/更新部署/RDC补货调整记录.xlsx
 * 动作：_update_adjustments.mjs → 重写 adjustments.json + manifest 单项哈希（不改代码/不 bump 版本号）
 *
 * 断言：
 *  A. Excel 有效行数 == adjustments.json 条数 == 1658；15 个补货日逐日条数一致
 *  B. 新增 5 个补货日：9/15(120) 9/17(189) 9/18(156) 9/20(188) 9/21(95)
 *  C. 字段体检：无缺 date/rdc/sku 行；RDC 恰为 6 大标准仓
 *  D. 新调整类型「超销预警」被 v344 动态派生捕获（下拉可见 + 归因表出行）
 *  E. 页面运行：adjust-track 零运行时错误；KPI「调整记录」== 1658
 *  F. manifest 隔离：只有 adjustments.json 一项哈希变化，其余 12 项与 git HEAD 版本相同
 *
 * 用法（项目根）：
 *   NODE_PATH=".../node/workspace/node_modules" "<node>" tools/verify-adjupdate-20260921.cjs
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_XLSX = 'C:/Users/zhangyufei1/Desktop/更新部署/RDC补货调整记录.xlsx';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

const RESULTS = [];
function check(name, ok, detail) {
  RESULTS.push({ name, ok, detail });
  console.log((ok ? '✅ ' : '❌ ') + name + (detail ? '  — ' + detail : ''));
}
function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  for (const d of fs.readdirSync(base)) {
    for (const c of [path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
                     path.join(base, d, 'chrome-win64', 'chrome.exe')]) {
      if (fs.existsSync(c)) return c;
    }
  }
  throw new Error('未找到 chromium');
}
function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

(async () => {
  // ---------- A~C：数据层 ----------
  const XLSX = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/xlsx');
  const wb = XLSX.read(fs.readFileSync(SRC_XLSX), { type: 'array' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: true });
  const ser2iso = n => {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    const d = new Date(Math.round((n - 25569) * 86400000));
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  };
  const xlDates = {}; let xlValid = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r[0] === null || r[0] === undefined || r[0] === '') continue;
    const d = ser2iso(typeof r[0] === 'number' ? r[0] : null) || (typeof r[0] === 'string' ? r[0].slice(0, 10) : null);
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    xlValid++; xlDates[d] = (xlDates[d] || 0) + 1;
  }

  const adj = JSON.parse(fs.readFileSync(path.join(ROOT, 'adjustments.json'), 'utf8'));
  const list = adj.adjust || [];
  const jsonDates = {};
  list.forEach(x => { jsonDates[x.date] = (jsonDates[x.date] || 0) + 1; });

  check('A1 Excel 有效行 == adjustments.json 条数',
    xlValid === list.length && list.length === 1658 && adj.count === 1658,
    'Excel ' + xlValid + ' / json ' + list.length + '（count 字段 ' + adj.count + '）');
  check('A2 全部补货日逐日条数一致',
    JSON.stringify(xlDates) === JSON.stringify(Object.fromEntries(Object.keys(jsonDates).sort().map(k => [k, jsonDates[k]]))),
    Object.keys(xlDates).length + ' 个补货日');

  const NEWD = { '2026-09-15': 120, '2026-09-17': 189, '2026-09-18': 156, '2026-09-20': 188, '2026-09-21': 95 };
  const badNew = Object.keys(NEWD).filter(d => jsonDates[d] !== NEWD[d]);
  check('B 新增 5 个补货日条数正确', badNew.length === 0,
    Object.keys(NEWD).map(d => d.slice(5) + '=' + NEWD[d]).join(' ') + (badNew.length ? ' ✗' + badNew.join(',') : ''));

  const badRows = list.filter(x => !x.date || !x.rdc || !x.sku);
  const rdcSet = [...new Set(list.map(x => x.rdc))].sort().join(',');
  check('C 字段体检（无缺 date/rdc/sku；RDC=6 大标准仓）',
    badRows.length === 0 && rdcSet === '东北,华中,华北,华南,西北,西南',
    '坏行 ' + badRows.length + ' ｜ RDC=' + rdcSet);

  // ---------- D：新类型 ----------
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'rdc-dashboard.html'), 'utf8');
  function grabFn(name) {
    const i = htmlSrc.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('fn not found: ' + name);
    let d = 0;
    for (let k = htmlSrc.indexOf('{', i); k < htmlSrc.length; k++) {
      if (htmlSrc[k] === '{') d++; else if (htmlSrc[k] === '}') { d--; if (d === 0) return htmlSrc.slice(i, k + 1); }
    }
    throw new Error('unbalanced ' + name);
  }
  function grabLine(needle) {
    const i = htmlSrc.indexOf(needle);
    if (i < 0) throw new Error('line not found: ' + needle);
    return htmlSrc.slice(htmlSrc.lastIndexOf('\n', i) + 1, htmlSrc.indexOf('\n', i));
  }
  const parts = [grabLine('const ADJ_TYPE_ORDER'), grabLine('const ADJ_TYPE_COLORS')].concat(
    ['_adjTypeList', '_adjTypeKind', '_adjTypeColor'].map(grabFn));
  const fns = new Function(parts.join('\n') + '\nreturn {_adjTypeList,_adjTypeKind,_adjTypeColor};')();
  const typeList = fns._adjTypeList(list);
  check('D1 「超销预警」被动态派生捕获', typeList.indexOf('超销预警') >= 0,
    typeList.length + ' 类：' + typeList.join(' / '));
  check('D2 既有 6 类未因新类型丢失',
    ['超大仓10%', '补货后超大仓20%', '总仓缺货', '计划员调整', '低销预警', '其他'].every(t => typeList.indexOf(t) >= 0),
    '超销预警性质标签 = 「' + fns._adjTypeKind('超销预警').label + '」（未登记则回落"其他"）');

  // ---------- F：manifest 隔离 ----------
  const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  let headMan = null;
  try {
    headMan = JSON.parse(execFileSync('git', ['-C', ROOT, 'show', 'HEAD:manifest.json'], { encoding: 'utf8' }));
  } catch (e) { /* ignore */ }
  check('F1 manifest 中 adjustments.json 哈希 == 实际文件',
    man.files['adjustments.json'] === sha(path.join(ROOT, 'adjustments.json')),
    man.files['adjustments.json'].slice(0, 12));
  if (headMan) {
    const diff = Object.keys(man.files).filter(k => man.files[k] !== headMan.files[k]);
    check('F2 仅 adjustments.json 一项哈希变化（其余 ' + (Object.keys(man.files).length - 1) + ' 项未动）',
      diff.length === 1 && diff[0] === 'adjustments.json', '变化项：' + diff.join(', ') + ' ｜ 文件数 ' + Object.keys(man.files).length);
  } else {
    check('F2 仅一项哈希变化', false, '取不到 HEAD:manifest.json，跳过');
  }

  // ---------- E：页面运行 ----------
  const chromium = require('playwright-core').chromium;
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 980 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e && e.message ? e.message : String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 300)); });

  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(
    () => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true && window._bootLoading === false,
    null, { timeout: 120000 });

  await page.evaluate(() => { window.location.hash = '#adjust-track'; });
  await page.waitForTimeout(500);
  await page.evaluate(() => { if (typeof renderAdjustTrack === 'function') renderAdjustTrack(); });
  await page.waitForTimeout(1200);

  const info = await page.evaluate(() => {
    const out = { kpi: {}, selects: [], tableRows: [], computedLen: null, adjLoaded: null };
    out.computedLen = (typeof buildAdjComputed === 'function') ? buildAdjComputed().list.length : null;
    out.adjLoaded = (typeof dataStore !== 'undefined' && dataStore.adjustRecords) ? dataStore.adjustRecords.length : null;
    document.querySelectorAll('.kpi-card').forEach(c => {
      const l = c.querySelector('.kpi-label'), v = c.querySelector('.kpi-value');
      if (l) out.kpi[l.textContent.trim()] = v ? v.textContent.trim() : '';
    });
    document.querySelectorAll('select').forEach(s => {
      // ⚠️ 必须读 option 的 **文本**（value 是 'all'/'超销预警' 混用），读 value 会把「全部调整类型」错判为 'all'
      const opts = [...s.options].map(o => o.textContent.trim());
      if (opts.indexOf('全部调整类型') >= 0) out.selects.push(opts);
    });
    const tbl = [...document.querySelectorAll('table')].find(t => t.textContent.indexOf('调整类型') >= 0 && t.textContent.indexOf('B象限') >= 0);
    if (tbl) [...tbl.querySelectorAll('tbody tr')].forEach(tr => {
      const tds = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
      if (tds.length) out.tableRows.push([tds[0], tds[1], tds[2], tds[7]]);
    });
    return out;
  });

  check('E1 adjust-track 零运行时错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '无');
  check('E2 dataStore.adjustRecords 已加载 1658 条', info.adjLoaded === 1658, 'adjustRecords=' + info.adjLoaded);
  check('E3 KPI「调整记录」== 1658', info.kpi['调整记录'] === '1658条', JSON.stringify(info.kpi['调整记录']) + ' ｜ 扣减 ' + (info.kpi['累计扣减量'] || '?'));
  check('E4 类型筛选下拉含「超销预警」',
    info.selects.length > 0 && info.selects[0].indexOf('超销预警') >= 0,
    '下拉选项：' + (info.selects[0] || []).join(' / '));
  const rowHit = info.tableRows.find(r => r[0] === '超销预警');
  check('E5 归因表出行「超销预警」', !!rowHit, rowHit ? ('性质=' + rowHit[1] + ' 扣减条=' + rowHit[2] + ' 缺货箱=' + rowHit[3]) : '未找到行');
  console.log('\n【归因表实际渲染】');
  info.tableRows.forEach(r => console.log('  ' + r[0].padEnd(18) + ' 性质=' + r[1].padEnd(6) + ' 扣减条=' + String(r[2]).padStart(4) + ' 缺货箱=' + r[3]));

  await browser.close();
  server.close();

  const fail = RESULTS.filter(r => !r.ok);
  console.log('\n===== ' + (RESULTS.length - fail.length) + '/' + RESULTS.length + ' 通过 =====');
  if (fail.length) { console.log('失败项：'); fail.forEach(f => console.log('  ✗ ' + f.name + ' — ' + f.detail)); process.exit(1); }
})();
