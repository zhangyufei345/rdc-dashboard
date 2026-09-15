#!/usr/bin/env node
/**
 * v347 验证：补货调整跟踪「下钻联动 + 两图 tooltip 跨维度分布」
 *   ① 页面运行时零报错
 *   ② 归因表点行 → 该类型被筛选（下拉同步）+ 明细表行全部属于该类型 + 行数 == 页面内复算值
 *   ③ 点行后自动滚到「调整明细」且该卡片短暂高亮；标题出现「筛选后 N 条 · M 个 SKU」徽标
 *   ④ 类型图 tooltip 含「缺货条来自哪些 RDC」，且各 RDC 条数 == 页面内同源复算
 *   ⑤ RDC图 tooltip 含「缺货条来自哪些调整类型」，且各类型条数 == 页面内同源复算
 *   ⑥ 再次点击同一行 → 筛选清除（不跳转）
 *
 * 用法（项目根执行，输出重定向避免 coreutils 缺失）：
 *   NODE_PATH=<node/workspace/node_modules> node tools/verify-adjdrill.cjs > tools/_out/adjdrill.txt 2>&1
 *   直连线上：LIVE_URL=https://rdc-dashboard.pages.dev NODE_PATH=... node tools/verify-adjdrill.cjs
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
console.log('源码 BUILD_VERSION =', BUILD);

const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail.push(msg); };

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
  const loaded = await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 })
    .then(() => true).catch(() => false);
  console.log('数据装载:', loaded ? 'OK' : '超时');
  // ⚠️ 陷阱：登录流程在 window._bootLoad() resolve 后会【强制】navigateTo('overview')（源码 L2035-2038），
  //   而 dataStore.loaded 比它早置位 —— 若只等 loaded 就导航，稍后会被"抢"回总览页（截图会拍错页）。
  //   必须先等 _bootLoading 变 false（登录流程收尾），再导航。
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.evaluate(() => navigateTo('adjust-track'));
  await page.waitForTimeout(3000);
  const onPage = await page.evaluate(() => (typeof currentPage !== 'undefined' ? currentPage : '?'));
  console.log('当前页(sidebar 高亮) =', onPage);
  ok(onPage === 'adjust-track', '⓪ 已稳定停在「补货调整跟踪」页（未被登录收尾的 navigateTo 抢走）');

  const shotDir = path.join(ROOT, 'tools', '_out');
  fs.mkdirSync(shotDir, { recursive: true });

  // ---------- 0) 页面基线 ----------
  const base = await page.evaluate(() => {
    const c = window.buildAdjComputed();
    const cards = Array.from(document.querySelectorAll('#page-adjust-track table.data-table'));
    const rowsOf = t => t ? t.querySelectorAll('tbody tr').length : -1;
    const typeCnt = {};
    c.list.forEach(r => { const t = r.adjType || '未填写'; typeCnt[t] = (typeCnt[t] || 0) + 1; });
    return {
      allTotal: c.list.length, maxOrd: c.maxOrd, typeCnt,
      tableCount: cards.length,
      typeTableRows: rowsOf(cards[0]), detailRows: rowsOf(cards[1]),
      detailId: !!document.getElementById('adj-detail-card'),
      detailCardIdx: cards.findIndex(t => t.closest('.card') && t.closest('.card').id === 'adj-detail-card'),
      detailIdOnCard: (cards[1].closest('.card') || {}).id || '(无)',
      detailHead: (cards[1].querySelector('thead') || {}).innerText || '',
      detailHeader: (document.getElementById('adj-detail-card') || {}).innerText
    };
  });
  console.log('\n[基线] 记录 ' + base.allTotal + ' 条 / maxOrd ' + base.maxOrd + ' / 页内表 ' + base.tableCount + ' 张');
  console.log('      归因表行数 =', base.typeTableRows, '| 明细表行数 =', base.detailRows, '| 各类型记录数 =', JSON.stringify(base.typeCnt));
  console.log('      明细卡 id =', base.detailId, '| id 落在页内第 ' + (base.detailCardIdx + 1) + ' 张表的卡片上(' + base.detailIdOnCard + ') | 标题含筛选徽标 =', /筛选后/.test(base.detailHeader || ''));
  ok(base.detailId && base.detailIdOnCard === 'adj-detail-card', '① 页内第 2 张表（调整明细）所在卡片带 id="adj-detail-card"');
  ok(/SKU名称/.test(base.detailHead) && /窗口缺货/.test(base.detailHead), '① 该卡片确实装的是「调整明细」表（表头含 SKU名称/窗口缺货）');
  ok(base.detailRows === base.allTotal, '① 初始明细表行数 = 全部记录 ' + base.allTotal + '（未被筛选）');
  ok(!/筛选后/.test(base.detailHeader || ''), '① 初始标题无筛选徽标');

  // ---------- 1) 点归因表行 → 下钻 ----------
  const pick = await page.evaluate(() => {
    const t = document.querySelectorAll('#page-adjust-track table.data-table')[0];
    const trs = Array.from(t.querySelectorAll('tbody tr'));
    const withB = trs.find(tr => /无谓损失/.test(tr.innerText));
    const tr = withB || trs[0];
    return { type: tr.children[0].innerText.trim(), idx: trs.indexOf(tr), bBox: (tr.children[8] || {}).innerText };
  });
  console.log('\n[下钻] 点击归因表第 ' + (pick.idx + 1) + ' 行：' + pick.type + '（B象限 ' + pick.bBox + '）');

  await page.evaluate(i => document.querySelectorAll('#page-adjust-track table.data-table')[0].querySelectorAll('tbody tr')[i].click(), pick.idx);
  // 高亮持续 ~1.7s：先在 500ms 时抓高亮（滚动是 smooth，此时可能还没到位）
  await page.waitForTimeout(500);
  const shadow = await page.evaluate(() => (document.getElementById('adj-detail-card') || {}).style.boxShadow || '');
  // 滚动到位是异步动画 → 轮询等待（最多 8s），再取最终位置与表格内容
  const scrolled = await page.waitForFunction(() => {
    const el = document.getElementById('adj-detail-card');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top >= -20 && r.top < 400;
  }, { timeout: 8000 }).then(() => true).catch(() => false);
  const hl = await page.evaluate(() => {
    const el = document.getElementById('adj-detail-card');
    const r = el.getBoundingClientRect();
    const sel = document.querySelector('#page-adjust-track select:nth-of-type(3)');
    const t = document.querySelectorAll('#page-adjust-track table.data-table')[1];
    const rows = Array.from(t.querySelectorAll('tbody tr'));
    const types = Array.from(new Set(rows.map(x => (x.children[4] || {}).innerText || '').map(s => s.trim())));
    return {
      rectTop: Math.round(r.top), rectBottom: Math.round(r.bottom), vh: window.innerHeight,
      header: el.innerText.split('\n').slice(0, 4),
      selType: sel ? sel.value : '(未取到下拉)', rowCount: rows.length, typesInTable: types,
      emptyRow: /无记录/.test(t.innerText)
    };
  });
  console.log('      类型下拉当前值 =', hl.selType, '| 明细行数 =', hl.rowCount, '| 表内出现的类型 =', JSON.stringify(hl.typesInTable));
  console.log('      明细卡位置 top/bottom = ' + hl.rectTop + '/' + hl.rectBottom + '（视口高 ' + hl.vh + '）| 高亮 =', shadow || '(无)');
  console.log('      明细卡头部 =', JSON.stringify(hl.header));
  ok(hl.selType === pick.type, '② 类型下拉已同步为「' + pick.type + '」');
  ok(hl.rowCount === base.typeCnt[pick.type], '② 明细行数 ' + hl.rowCount + ' == 页面复算该类型记录数 ' + base.typeCnt[pick.type]);
  ok(hl.typesInTable.length === 1 && hl.typesInTable[0] === pick.type, '② 明细表内只含该类型（无混入）');
  ok(!hl.emptyRow, '② 明细表非空态');
  ok(scrolled, '③ 已自动滚动到明细卡（top=' + hl.rectTop + '，落在视口内）');
  ok(/252,\s*165,\s*165|FCA5A5/i.test(shadow), '③ 明细卡出现下钻高亮');
  ok(/筛选后/.test(hl.header.join(' ')), '③ 明细卡标题出现「筛选后 N 条 · M 个 SKU」徽标');

  // ---------- 2) 查清筛选徽标数字是否与页面复算一致 ----------
  const badge = await page.evaluate(tp => {
    const c = window.buildAdjComputed();
    const f = c.list.filter(r => (r.adjType || '未填写') === tp);
    const cuts = f.filter(r => r.cut > 0);
    const short = cuts.filter(r => r.shortBoxes > 0);
    const el = document.getElementById('adj-detail-card');
    return {
      want: { n: f.length, sku: new Set(f.map(r => r.sku)).size, cut: Math.round(cuts.reduce((s, r) => s + r.cut, 0)), shortN: short.length, shortBox: Math.round(short.reduce((s, r) => s + r.shortBoxes, 0)) },
      txt: el.innerText.replace(/\s+/g, ' ').slice(0, 160)
    };
  }, pick.type);
  console.log('      徽标文案 =', badge.txt);
  const bOk = badge.txt.includes(String(badge.want.n)) && badge.txt.includes(String(badge.want.sku)) &&
    badge.txt.includes(badge.want.cut.toLocaleString('zh-CN')) && badge.txt.includes(String(badge.want.shortN));
  ok(bOk, '③ 徽标数字（条数/SKU数/扣减箱/缺货条）与页面复算一致 ' + JSON.stringify(badge.want));

  fs.writeFileSync(path.join(shotDir, 'adjdrill-detail.png'), Buffer.from(await page.screenshot({ fullPage: false })));

  // ---------- 3) 两图 tooltip 跨维度分布 ----------
  console.log('\n[Tooltip] 触发并读取两张图的自定义 tooltip');
  async function tooltipOf(chartId, tag) {
    const pickI = await page.evaluate(id => {
      const inst = echarts.getInstanceByDom(document.getElementById(id));
      const o = inst.getOption();
      const cats = (o.xAxis[0].type === 'category' ? o.xAxis[0].data : (o.yAxis[0] && o.yAxis[0].data) || []).slice();
      // 选「缺货率(条)」数据非 null 且有量的第一个点
      const line = (o.series || []).find(s => s.name === '缺货率(条)');
      const data = line ? line.data : [];
      let i = data.findIndex(v => v != null && v > 0);
      if (i < 0) i = data.findIndex(v => v != null);
      if (i < 0) i = 0;
      return { i, cat: cats[i], cats, rate: data[i], xType: o.xAxis[0].type };
    }, chartId);
    await page.evaluate(([id, i]) => {
      const inst = echarts.getInstanceByDom(document.getElementById(id));
      inst.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: i });
    }, [chartId, pickI.i]);
    await page.waitForTimeout(400);
    const txt = await page.evaluate(id => {
      const root = document.getElementById(id);
      const cand = Array.from(root.querySelectorAll('div')).filter(d => /缺货条来自哪些/.test(d.textContent));
      return cand.length ? cand[cand.length - 1].innerText.replace(/\n+/g, ' | ') : '(未捕获到 tooltip)';
    }, chartId);
    console.log('      【' + tag + '】点 = ' + pickI.cat + '（缺货率 ' + pickI.rate + '%）');
    console.log('      tooltip = ' + txt);
    // 视觉留证：canvas 的元素截图在 headless-shell 下是空白，改为滚动到图后整屏截图（tooltip 是 DOM，会一起入镜）
    const drift = await page.evaluate(() => (typeof currentPage !== 'undefined' ? currentPage : '?'));
    if (drift !== 'adjust-track') {
      console.log('      ⚠ 页面漂移到「' + drift + '」，重新导航回补货调整跟踪再截图');
      await page.evaluate(() => navigateTo('adjust-track'));
      await page.waitForTimeout(2500);
    }
    await page.evaluate(id => { const el = document.getElementById(id); if (el) el.scrollIntoView({ block: 'center' }); }, chartId);
    await page.waitForTimeout(200);
    await page.locator('#' + chartId).hover({ timeout: 3000 }).catch(() => {});
    await page.evaluate(([id, i]) => {
      const inst = echarts.getInstanceByDom(document.getElementById(id));
      inst.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: i });
    }, [chartId, pickI.i]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shotDir, 'adjdrill-tt-' + tag + '.png') })
      .then(() => console.log('      截图 tools/_out/adjdrill-tt-' + tag + '.png')).catch(e => console.log('      截图失败:', e.message));
    return { pickI, txt };
  }
  const tt1 = await tooltipOf('adj-chart-type', 'type');
  const tt2 = await tooltipOf('adj-chart-rdc', 'rdc');

  // 同源复算对拍
  const expect = await page.evaluate(() => {
    const c = window.buildAdjComputed();
    const brk = (rows) => {
      const g = rows.filter(r => r.cut > 0 && r.status === '已完成');
      const sh = g.filter(r => r.shortBoxes > 0);
      return { done: g.length, shortCnt: sh.length, boxes: Math.round(sh.reduce((s, r) => s + r.shortBoxes, 0)) };
    };
    const rdcList = ['华中', '华南', '华北', '东北', '西北', '西南'];
    const t1 = {}, t2 = {};
    const types = Array.from(new Set(c.list.map(r => r.adjType || '未填写')));
    types.forEach(tp => rdcList.forEach(rd => {
      const o = brk(c.list.filter(r => (r.adjType || '未填写') === tp && r.rdc === rd));
      t1[tp + '|' + rd] = o;
      t2[rd + '|' + tp] = o;
    }));
    return { t1, t2 };
  });
  // 从 tooltip 文本里抽出「名字 N 条 · 走完 M 条 · X 箱」逐条与复算比对（只取分布段落之后的文本）
  function parseHits(txt, marker) {
    const seg = txt.indexOf(marker) >= 0 ? txt.slice(txt.indexOf(marker) + marker.length) : txt;
    const out = [];
    // ⚠️ 分隔符是「 · 」（来自 tooltip 里的 <span> · 走完 ...</span>），不是「|」
    const re = /([\u4e00-\u9fa5A-Za-z0-9%（）]+)\s+(\d+)\s*条\s*·\s*走完\s*(\d+)\s*条\s*·\s*([\d,]+)\s*箱/g;
    let m;
    while ((m = re.exec(seg))) out.push({ name: m[1], shortCnt: +m[2], done: +m[3], boxes: +m[4].replace(/,/g, '') });
    return out;
  }
  const hits1 = parseHits(tt1.txt, '缺货条来自哪些 RDC'), hits2 = parseHits(tt2.txt, '缺货条来自哪些调整类型');
  // 防"假通过"：tooltip 里确实列出了「N 条 · 走完 M 条」的行时，解析结果不能为空
  const raw1 = /条\s*·\s*走完/.test(tt1.txt), raw2 = /条\s*·\s*走完/.test(tt2.txt);
  ok(!raw1 || hits1.length > 0, '④ tooltip 已列出 RDC 明细行，解析非空（防解析器静默失败）');
  ok(!raw2 || hits2.length > 0, '⑤ tooltip 已列出类型明细行，解析非空（防解析器静默失败）');
  console.log('\n【对拍·类型图 tooltip】' + tt1.pickI.cat + ' → RDC 拆解');
  if (!hits1.length) console.log(raw1 ? '  ⚠ 解析失败（tooltip 有明细行但未解析出来）' : '  · 该类型各 RDC 均零缺货 / 窗口未走完，tooltip 给结论文案');
  hits1.forEach(h => {
    const w = expect.t1[tt1.pickI.cat + '|' + h.name];
    const good = w && w.shortCnt === h.shortCnt && w.done === h.done && w.boxes === h.boxes;
    console.log('  ' + h.name + '：tooltip ' + h.shortCnt + ' 条/走完 ' + h.done + ' 条/' + h.boxes + ' 箱  ‖ 页面复算 ' +
      (w ? w.shortCnt + ' 条/走完 ' + w.done + ' 条/' + w.boxes + ' 箱' : '—') + (good ? ' ✓' : ' ✗'));
  });
  console.log('\n【对拍·RDC图 tooltip】' + tt2.pickI.cat + ' → 调整类型拆解');
  if (!hits2.length) console.log(raw2 ? '  ⚠ 解析失败（tooltip 有明细行但未解析出来）' : '  · 该 RDC 各类型均零缺货 / 窗口未走完，tooltip 给结论文案');
  hits2.forEach(h => {
    const w = expect.t2[tt2.pickI.cat + '|' + h.name];
    const good = w && w.shortCnt === h.shortCnt && w.done === h.done && w.boxes === h.boxes;
    console.log('  ' + h.name + '：tooltip ' + h.shortCnt + ' 条/走完 ' + h.done + ' 条/' + h.boxes + ' 箱  ‖ 页面复算 ' +
      (w ? w.shortCnt + ' 条/走完 ' + w.done + ' 条/' + w.boxes + ' 箱' : '—') + (good ? ' ✓' : ' ✗'));
  });
  const allGood1 = (!raw1 || hits1.length > 0) && hits1.every(h => { const w = expect.t1[tt1.pickI.cat + '|' + h.name]; return w && w.shortCnt === h.shortCnt && w.done === h.done && w.boxes === h.boxes; });
  const allGood2 = (!raw2 || hits2.length > 0) && hits2.every(h => { const w = expect.t2[tt2.pickI.cat + '|' + h.name]; return w && w.shortCnt === h.shortCnt && w.done === h.done && w.boxes === h.boxes; });
  ok(/缺货条来自哪些 RDC/.test(tt1.txt), '④ 类型图 tooltip 含「缺货条来自哪些 RDC」');
  ok(/缺货条来自哪些调整类型/.test(tt2.txt), '⑤ RDC图 tooltip 含「缺货条来自哪些调整类型」');
  ok(tt1.txt !== '(未捕获到 tooltip)' && allGood1, '④ 类型图 tooltip 的 RDC 条数 == 页面同源复算（' + hits1.length + ' 行逐条对拍）');
  ok(tt2.txt !== '(未捕获到 tooltip)' && allGood2, '⑤ RDC图 tooltip 的类型条数 == 页面同源复算（' + hits2.length + ' 行逐条对拍）');

  // ---------- 4) 再点同一行 → 清除筛选且不跳转 ----------
  await page.evaluate(() => { const el = document.getElementById('adj-detail-card'); if (el) el.scrollIntoView({ block: 'start' }); });
  await page.evaluate(i => document.querySelectorAll('#page-adjust-track table.data-table')[0].querySelectorAll('tbody tr')[i].click(), pick.idx);
  await page.waitForTimeout(700);
  const cleared = await page.evaluate(() => {
    const sel = document.querySelector('#page-adjust-track select:nth-of-type(3)');
    const t = document.querySelectorAll('#page-adjust-track table.data-table')[1];
    const el = document.getElementById('adj-detail-card');
    return {
      selType: sel ? sel.value : '?', rows: t.querySelectorAll('tbody tr').length,
      rectTop: Math.round(el.getBoundingClientRect().top),
      header: el.innerText.split('\n').slice(0, 4).join(' '),
      jumpFlag: window._adjJumpDetail
    };
  });
  console.log('\n[取消筛选] 下拉=' + cleared.selType + ' | 明细行数=' + cleared.rows + ' | 明细卡 top=' + cleared.rectTop + ' | jump 标志=' + cleared.jumpFlag);
  ok(cleared.selType === 'all' && cleared.rows === base.allTotal, '⑥ 再点同一行 → 筛选清除，明细恢复 ' + base.allTotal + ' 行');
  ok(cleared.jumpFlag === false, '⑥ 取消筛选时未置位跳转标志（不会把页面甩到底部）');
  ok(!/筛选后/.test(cleared.header), '⑥ 标题筛选徽标已消失');

  // ---------- 5) 整页签运行时自检（回归：本改动不破坏其它页） ----------
  await browser.close();
  if (server) server.close();

  console.log('\n① 页面运行时错误:', errs.length ? errs.slice(0, 3) : '无');
  ok(errs.length === 0, '⓪ 全程零 pageerror / console.error');
  console.log('\n' + (fail.length ? '❌ 未通过 ' + fail.length + ' 项：\n  - ' + fail.join('\n  - ') : '✅ v347 全部验证通过'));
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('工具异常:', e && e.message, e && e.stack ? e.stack.split('\n')[1] : ''); process.exit(2); });
