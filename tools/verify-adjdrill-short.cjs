#!/usr/bin/env node
/**
 * v348 验证：归因表下钻 → 明细表默认只列「走完后有缺货」的记录
 *   ① 基线：明细表 = 全部记录，无筛选徽标
 *   ② 点归因表某类型行 → 明细行数 == 该行「缺货条数」单元格数字（表格数字 ↔ 明细条数一一对应）
 *      且每行都满足 调整类型=该类型 / 状态=已完成 / 窗口缺货>0（无混入、无走完没缺、无窗口未走完）
 *   ③ 明细卡出现可点击取消的徽标「仅看走完后有缺货」，且徽标里的「筛选后 N 条」== 明细行数
 *   ④ 点徽标 ✕ → 恢复该类型全部记录（short 复位为 all，徽标消失）
 *   ⑤ 再次点归因表行 → 取消筛选，明细恢复全部记录
 *   ⑥ 点一个「窗口未走完」的类型行 → 空态，且文案解释「没有走完后有缺货的记录」
 *   ⑦ 全程零 pageerror
 *
 * 用法（项目根执行，输出重定向避免 coreutils 缺失）：
 *   NODE_PATH=<node/workspace/node_modules> node tools/verify-adjdrill-short.cjs > tools/_out/adjshort.txt 2>&1
 *   直连线上：LIVE_URL=https://rdc-dashboard.pages.dev NODE_PATH=... node tools/verify-adjdrill-short.cjs
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
const BUILD = (/const BUILD_VERSION = (\d+)/.exec(fs.readFileSync(path.join(ROOT, 'rdc-dashboard.html'), 'utf8')) || [])[1];
console.log('源码 BUILD_VERSION =', BUILD, '（期望 348）');

const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail.push(msg); };
const num = s => +String(s == null ? '' : s).replace(/[^\d.-]/g, '') || 0;

(async () => {
  let chromium;
  try { chromium = require('playwright-core').chromium; }
  catch (e) { console.error('需要 playwright-core（设置 NODE_PATH）'); process.exit(2); }
  const liveUrl = process.env.LIVE_URL || '';
  const server = liveUrl ? null : await startServer();
  const baseUrl = liveUrl || ('http://127.0.0.1:' + server.address().port);
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
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 }).catch(() => false);
  // ⚠️ 陷阱（v347 踩过）：登录流程 _bootLoad() resolve 后会强制 navigateTo('overview')，必须等它收尾再导航
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.evaluate(() => navigateTo('adjust-track'));
  await page.waitForTimeout(3000);
  const onPage = await page.evaluate(() => (typeof currentPage !== 'undefined' ? currentPage : '?'));
  ok(onPage === 'adjust-track', '⓪ 已稳定停在「补货调整跟踪」页');

  const shotDir = path.join(ROOT, 'tools', '_out');
  fs.mkdirSync(shotDir, { recursive: true });

  const readState = () => page.evaluate(() => {
    const tables = document.querySelectorAll('#page-adjust-track table.data-table');
    const trs = Array.from(tables[1].querySelectorAll('tbody tr'));
    const cells = trs.map(tr => Array.from(tr.children).map(td => td.innerText.trim()));
    const el = document.getElementById('adj-detail-card');
    const c = window.buildAdjComputed();
    return {
      allTotal: c.list.length, rows: trs.length, cells,
      empty: cells.length === 1 && cells[0].length === 1,
      short: window._adjState.short, type: window._adjState.type,
      head: (el ? el.innerText.replace(/\s+/g, ' ') : '').slice(0, 200),
      badgeClickable: !!(el && Array.from(el.querySelectorAll('span')).find(s => /仅看走完后有缺货/.test(s.innerText))),
      selType: (document.querySelector('#page-adjust-track select:nth-of-type(3)') || {}).value
    };
  });

  // ---------- ① 基线 ----------
  const base = await readState();
  console.log('\n[基线] 明细行数 =', base.rows, '| 全部记录 =', base.allTotal, '| short =', base.short, '| 类型下拉 =', base.selType);
  console.log('       明细卡头部 =', base.head.slice(0, 120));
  ok(base.rows === base.allTotal, '① 初始明细表 = 全部 ' + base.allTotal + ' 条');
  ok(!/仅看走完后有缺货/.test(base.head), '① 初始无「仅看走完后有缺货」徽标');
  ok(base.short === 'all', '① 初始 short 状态 = all');

  // ---------- ② 点含缺货的类型行 ----------
  const pick = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('#page-adjust-track table.data-table')[0].querySelectorAll('tbody tr'));
    // 归因表列：0类型 1性质 2扣减条数 3扣减量 4已走完 5缺货条数 6缺货率 7缺货量 8B象限 9结论
    const cand = trs.map(tr => ({
      idx: trs.indexOf(tr),
      type: tr.children[0].innerText.trim(),
      cuts: tr.children[2].innerText.trim(),
      done: tr.children[4].innerText.trim(),
      shortCnt: tr.children[5].innerText.trim(),
      shortBox: tr.children[7].innerText.trim(),
      verdict: tr.children[9].innerText.trim()
    })).filter(o => /^\d+$/.test(o.shortCnt) && +o.shortCnt > 0);
    const wait = trs.map(tr => ({
      idx: trs.indexOf(tr), type: tr.children[0].innerText.trim(),
      done: tr.children[4].innerText.trim(), shortCnt: tr.children[5].innerText.trim()
    })).find(o => o.shortCnt === '—' || +o.done === 0);
    return { hit: cand[0] || null, all: cand, wait: wait || null };
  });
  ok(!!pick.hit, '② 归因表中存在「缺货条数 > 0」的行可测（' + pick.all.map(o => o.type + ':' + o.shortCnt).join(' / ') + '）');
  if (!pick.hit) throw new Error('无缺货行，测试无法继续');
  const P = pick.hit;
  console.log('\n[下钻] 点击「' + P.type + '」（走完 ' + P.done + ' · 缺货 ' + P.shortCnt + ' 条 / ' + P.shortBox + ' 箱）');

  await page.evaluate(i => document.querySelectorAll('#page-adjust-track table.data-table')[0].querySelectorAll('tbody tr')[i].click(), P.idx);
  await page.waitForTimeout(1200);
  const after = await readState();
  console.log('       明细行数 =', after.rows, '| short =', after.short, '| 类型下拉 =', after.selType);
  console.log('       明细卡头部 =', after.head.slice(0, 160));
  ok(after.selType === P.type, '② 类型下拉同步为「' + P.type + '」');
  ok(after.short === 'yes', '② 下钻自动打开 short 筛选');
  ok(after.badgeClickable, '③ 明细卡出现可点击的「仅看走完后有缺货」徽标');
  ok(after.rows === num(P.shortCnt), '② 明细行数 ' + after.rows + ' == 归因表该行「缺货条数」' + P.shortCnt + '（表格数字 ↔ 明细条数一一对应）');
  // 逐行体检
  const bad = after.cells.filter(c => c.length < 12 ? true : (c[4] !== P.type || c[10] !== '已完成' || !(num(c[11]) > 0)));
  console.log('       逐行体检（类型/状态/窗口缺货>0）异常行数 =', bad.length);
  if (bad.length) console.log('       异常样例 =', JSON.stringify(bad.slice(0, 3)));
  ok(bad.length === 0, '② 每行都满足：类型=「' + P.type + '」· 状态=已完成 · 窗口缺货>0（无混入 / 无走完没缺 / 无未走完）');
  const sumBox = after.cells.reduce((s, c) => s + num(c[11]), 0);
  console.log('       明细窗口缺货合计 = ' + sumBox + ' 箱（归因表该行缺货量 = ' + P.shortBox + ' 箱）');
  ok(Math.abs(sumBox - num(P.shortBox)) < 1.5, '② 明细缺货量合计 ' + sumBox + ' ≈ 归因表「缺货量(箱)」' + P.shortBox);
  ok(/筛选后 <b>|\u9009\u7b5b\u540e/.test(after.head) || /筛选后/.test(after.head), '③ 徽标含「筛选后 N 条」摘要');
  ok(after.head.includes(String(after.rows)), '③ 徽标「筛选后 ' + after.rows + ' 条」与实际行数一致');
  // 视觉留证：⚠️ headless-shell 下元素级截图会偏移（实测截到了页面顶栏）、canvas 截图会空白，
  //   因此统一用「把卡片顶到视口上方 → 整屏截图」。scrollIntoView(smooth) 在长卡片上不可靠，
  //   改为直接改最近可滚动祖先的 scrollTop（增量 = 元素 top - 70px 留出呼吸位）。
  await page.evaluate(() => {
    const el = document.getElementById('adj-detail-card');
    if (!el) return;
    const r = el.getBoundingClientRect();
    let sc = el.parentElement;
    while (sc && sc !== document.body && !(sc.scrollHeight > sc.clientHeight + 4)) sc = sc.parentElement;
    const target = (sc && sc !== document.body) ? sc : document.scrollingElement;
    target.scrollTop += (r.top - 70);
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shotDir, 'adjshort-drill.png') }).then(() => console.log('       截图 tools/_out/adjshort-drill.png（明细卡 + 筛选徽标）')).catch(() => {});

  // ---------- ④ 点徽标 ✕ → 恢复该类型全部 ----------
  await page.evaluate(() => {
    const el = document.getElementById('adj-detail-card');
    const s = Array.from(el.querySelectorAll('span')).find(x => /仅看走完后有缺货/.test(x.innerText));
    if (s) s.click();
  });
  await page.waitForTimeout(900);
  const unshort = await page.evaluate(tp => {
    const c = window.buildAdjComputed();
    const n = c.list.filter(r => (r.adjType || '未填写') === tp).length;
    const t = document.querySelectorAll('#page-adjust-track table.data-table')[1];
    return { want: n, rows: t.querySelectorAll('tbody tr').length, short: window._adjState.short, type: window._adjState.type,
      head: document.getElementById('adj-detail-card').innerText.replace(/\s+/g, ' ').slice(0, 120) };
  }, P.type);
  console.log('\n[取消仅看缺货] 明细行数 =', unshort.rows, '（该类型全部 ' + unshort.want + ' 条）| short =', unshort.short);
  ok(unshort.short === 'all', '④ 点 ✕ → short 复位为 all');
  ok(unshort.rows === unshort.want, '④ 明细恢复为该类型全部 ' + unshort.want + ' 条（含走完没缺 / 窗口未走完）');
  ok(!/仅看走完后有缺货/.test(unshort.head), '④ 徽标消失');
  ok(unshort.type === P.type, '④ 类型筛选仍保留（只取消"仅看缺货"这一层）');

  // ---------- ⑤ 再点该行 = 取消全部筛选；再点一次 = 重新下钻 ----------
  // 注意时序：④ 结束时 type 仍 = P.type（只取消了"仅看缺货"这一层），
  //   所以这里的第一次点击按 v347 语义是【取消筛选】，第二次点击才是【重新下钻】。
  await page.evaluate(i => document.querySelectorAll('#page-adjust-track table.data-table')[0].querySelectorAll('tbody tr')[i].click(), P.idx);
  await page.waitForTimeout(1200);
  const cleared = await readState();
  console.log('\n[取消筛选] 明细行数 =', cleared.rows, '| type =', cleared.type, '| short =', cleared.short, '| 期望', base.allTotal + '/all/all');
  ok(cleared.rows === base.allTotal && cleared.type === 'all' && cleared.short === 'all', '⑤ 再点同一行 → type/short 双复位，明细恢复 ' + base.allTotal + ' 条');
  await page.evaluate(i => document.querySelectorAll('#page-adjust-track table.data-table')[0].querySelectorAll('tbody tr')[i].click(), P.idx);
  await page.waitForTimeout(1200);
  const reDrill = await readState();
  console.log('[重新下钻] 明细行数 =', reDrill.rows, '| type =', reDrill.type, '| short =', reDrill.short, '| 期望', num(P.shortCnt) + '/' + P.type + '/yes');
  ok(reDrill.rows === num(P.shortCnt) && reDrill.type === P.type && reDrill.short === 'yes', '⑤ 再点一次 → 又只列 ' + num(P.shortCnt) + ' 条缺货记录（下钻/取消可反复切换）');

  // ---------- ⑥ 点窗口未走完的类型 → 空态 ----------
  if (pick.wait) {
    console.log('\n[空态] 点击「' + pick.wait.type + '」（已走完 ' + pick.wait.done + ' · 缺货条数 ' + pick.wait.shortCnt + '）');
    await page.evaluate(i => document.querySelectorAll('#page-adjust-track table.data-table')[0].querySelectorAll('tbody tr')[i].click(), pick.wait.idx);
    await page.waitForTimeout(1000);
    const empty = await readState();
    console.log('       明细行数 =', empty.rows, '| 文案 =', (empty.cells[0] || [])[0]);
    ok(empty.rows === 1 && /没有「走完后有缺货」的记录/.test((empty.cells[0] || [])[0] || ''), '⑥ 无可用窗口类型 → 空态且文案解释原因');
    ok(empty.short === 'yes', '⑥ 空态下 short 筛选仍开启（可点 ✕ 或再点行取消）');
  } else {
    console.log('\n[空态] 当前数据无「窗口未走完」的类型，跳过 ⑥');
  }

  // ---------- ⑦ 运行时错误 ----------
  await browser.close();
  if (server) server.close();
  console.log('\n⓪ 页面运行时错误:', errs.length ? errs.slice(0, 3) : '无');
  ok(errs.length === 0, '⑦ 全程零 pageerror / console.error');
  console.log('\n' + (fail.length ? '❌ 未通过 ' + fail.length + ' 项：\n  - ' + fail.join('\n  - ') : '✅ v348 全部验证通过'));
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('工具异常:', e && e.message, e && e.stack ? e.stack.split('\n')[1] : ''); process.exit(2); });
