#!/usr/bin/env node
/**
 * v388「月底压货商品分析」TAB 自检探针
 *
 * 用法（项目根执行）：
 *   NODE_PATH="C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules" \
 *   "C:/Users/zhangyufei1/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" tools/verify-monthend-tab.cjs
 *   # 直连线上： RDC_BASE=https://rdc-dashboard.pages.dev ... tools/verify-monthend-tab.cjs
 *
 * 设计铁律（本项目踩过的坑，一条都不能违反）：
 *  ① 顶层 let/const 不挂 window → page.evaluate 里裸写变量名（不能写 window.dataStore）
 *  ② 断言读「页面同源数据入口」（getMonthendProfile()），不在 DOM 里搜行（分页/筛选下假失败）
 *  ③ 断言不许硬编码会随数据增长的量 → 一律「与同源复算对拍」或 >=
 *  ④ 跨期量必须同源对拍（不要拿"单月源值"当"跨月合计"的上界）
 *  ⑤ 必须 waitForFunction(() => window._bootLoading === false) 再导航（否则被强制抢回总览）
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.RDC_BASE || '').replace(/\/$/, '');

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const cands = [];
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      cands.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
      cands.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
    }
  }
  const hit = cands.find(p => fs.existsSync(p));
  if (!hit) throw new Error('未找到 chromium');
  return hit;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
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

const R = { pass: 0, fail: 0, lines: [] };
function chk(name, cond, detail) {
  if (cond) { R.pass++; R.lines.push('  ✅ ' + name + (detail ? '  ' + detail : '')); }
  else { R.fail++; R.lines.push('  ❌ ' + name + (detail ? '  ' + detail : '')); }
}

(async () => {
  let chromium;
  try { chromium = require('playwright-core').chromium; }
  catch (e) { console.error('需要 playwright-core'); process.exit(2); }

  let server = null, URL;
  if (BASE) { URL = BASE + '/rdc-dashboard.html'; }
  else { server = await startServer(); URL = 'http://127.0.0.1:' + server.address().port + '/rdc-dashboard.html'; }
  console.log('目标:', URL);

  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + (e.message || e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text().slice(0, 240)); });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});

  // 🔴 铁律⑤：必须等 _bootLoading 结束，否则 handleLogin 收尾会强制 navigateTo('overview') 抢回总览
  const booted = await page.waitForFunction(() => window._bootLoading === false && typeof dataStore !== 'undefined' && dataStore.loaded === true,
    { timeout: 240000 }).then(() => true).catch(() => false);
  chk('数据装载完成（_bootLoading=false 且 dataStore.loaded）', booted);
  if (!booted) { await browser.close(); if (server) server.close(); console.log(R.lines.join('\n')); process.exit(1); }

  // ── 版本 ─────────────────────────────────────────────────────────────
  const ver = await page.evaluate(() => (typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : -1));
  chk('BUILD_VERSION >= 388', ver >= 388, 'actual=' + ver);

  // ── 导航到缺货分析 → 切月底压货 TAB ───────────────────────────────────
  await page.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('shortage'); });
  await page.waitForTimeout(1200);

  const tabBtnExists = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#page-shortage button')];
    return btns.some(b => (b.textContent || '').indexOf('月底压货商品分析') >= 0);
  });
  chk('缺货分析 TAB 栏出现「月底压货商品分析」按钮', tabBtnExists);

  // 点按钮（走真实用户路径，验证 onclick 路由）
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#page-shortage button')];
    const b = btns.find(x => (x.textContent || '').indexOf('月底压货商品分析') >= 0);
    if (!b) return false;
    b.click();
    return true;
  });
  await page.waitForTimeout(2600);
  chk('点击 TAB 按钮成功', clicked);

  const pageHtmlLen = await page.evaluate(() => {
    const el = document.getElementById('page-shortage');
    return el ? el.innerHTML.length : -1;
  });
  chk('页面渲染非空（htmlLen > 5000）', pageHtmlLen > 5000, 'htmlLen=' + pageHtmlLen);

  const tabActive = await page.evaluate(() => window._shortageTab);
  chk('_shortageTab === monthend', tabActive === 'monthend', 'actual=' + tabActive);

  // ── 核心口径断言：与页面同源数据入口对拍 ─────────────────────────────
  // 🔴 铁律①：顶层 let/const 不挂 window → 裸写名字
  const prof = await page.evaluate(() => {
    const p = getMonthendProfile();
    const rows = p.rows || [];
    const cnt = { A: 0, B: 0, C: 0, D: 0 };
    rows.forEach(r => { cnt[r.quad] = (cnt[r.quad] || 0) + 1; });
    const A = rows.filter(r => r.quad === 'A');
    const B = rows.filter(r => r.quad === 'B');
    const avg = arr => arr.length ? arr.reduce((s, r) => s + (r.shortRate || 0), 0) / arr.length : null;
    // 象限定义自洽性复核（不硬编码条数）
    let quadOk = true;
    rows.forEach(r => {
      const exp = r.xHigh && r.yHigh ? 'A' : r.xHigh ? 'B' : r.yHigh ? 'C' : 'D';
      if (r.quad !== exp) quadOk = false;
    });
    // A 象限归因覆盖率
    const attrOk = A.every(r => r.attr && r.attr.length > 0);
    return {
      total: rows.length, cnt,
      shortTh: p.shortTh, rho: p.rho,
      aAvg: avg(A), bAvg: avg(B),
      whMonths: ME_PARAMS.WH_MONTHS.slice(),
      hitTh: ME_PARAMS.HIT_TH,
      quadOk, attrOk,
      aAllWhBadOrOk: A.every(r => r.whConcl),
      // X/Y 门槛方向复核
      hitGeTh: rows.filter(r => r.xHigh).every(r => r.hitRate >= ME_PARAMS.HIT_TH),
      yGeTh: rows.filter(r => r.yHigh).every(r => r.shortRate >= p.shortTh),
      nWhKeys: Object.keys(p.wh || {}).length
    };
  });

  chk('SKU×RDC 清单非空（>= 100 条）', prof.total >= 100, 'total=' + prof.total);
  chk('四象限计数之和 = 总数', prof.cnt.A + prof.cnt.B + prof.cnt.C + prof.cnt.D === prof.total,
    `${prof.cnt.A}+${prof.cnt.B}+${prof.cnt.C}+${prof.cnt.D}=${prof.total}`);
  chk('A 象限非空（关键产出）', prof.cnt.A > 0, 'A=' + prof.cnt.A);
  chk('象限判定自洽（xHigh/yHigh → quad 一一对应）', prof.quadOk);
  chk('xHigh 全部满足 hitRate >= HIT_TH(' + prof.hitTh + ')', prof.hitGeTh);
  chk('yHigh 全部满足 shortRate >= shortTh', prof.yGeTh, 'shortTh=' + (prof.shortTh === null ? 'null' : prof.shortTh.toFixed(4)));

  // 结论①：A 缺货率显著高于 B（不硬编码倍数，只断言"显著高"）
  chk('结论① A 象限缺货率均值 > B 象限均值', prof.aAvg !== null && prof.bAvg !== null && prof.aAvg > prof.bAvg * 1.5,
    `A=${(prof.aAvg * 100).toFixed(2)}%  B=${(prof.bAvg * 100).toFixed(2)}%  倍数=${prof.bAvg ? (prof.aAvg / prof.bAvg).toFixed(2) : '—'}x`);

  // 结论③：ρ 接近 0（|ρ| < 0.15）→ 两因素独立，必须取交集
  chk('结论③ |Spearman ρ| < 0.15（压货与缺货无线性关系）', prof.rho !== null && Math.abs(prof.rho) < 0.15,
    'rho=' + (prof.rho === null ? 'null' : prof.rho.toFixed(4)));

  // A 象限全部有归因
  chk('A 象限每条都有归因文案', prof.attrOk);
  chk('总仓画像表非空（wh keys > 0）', prof.nWhKeys > 0, 'nWhKeys=' + prof.nWhKeys);

  // ── 结论②：总仓受限 vs 正常，限定 5-9 月内比较 ────────────────────────
  const whCmp = await page.evaluate(() => {
    const p = getMonthendProfile();
    const set = {}; ME_PARAMS.WH_MONTHS.forEach(m => set[m] = 1);
    let bo = 0, bs = 0, oo = 0, os2 = 0, bn = 0, on = 0;
    Object.keys(p.cells).forEach(k => {
      const c = p.cells[k];
      if (!c.eligible) return;
      if (!set[c.ym]) return;                       // 🔴 限定 5-9 月：消除月份混淆
      const w = p.wh[c.ym + '|' + c.sku];
      if (!w || w.level === '样本不足') return;
      const bad = (w.level === '总仓缺货' || w.level === '总仓紧张');
      if (bad) { bo += c.oq; bs += c.shortQty; bn++; }
      else { oo += c.oq; os2 += c.shortQty; on++; }
    });
    // Censored 语义复核：level==='总仓正常' && censored===true 的必须有 winDays===0
    let cenOk = true, cenN = 0;
    Object.keys(p.wh).forEach(k => {
      const w = p.wh[k];
      if (w.censored === true) { cenN++; if (w.winDays !== 0) cenOk = false; }
    });
    return {
      badRate: bo > 0 ? bs / bo : null, okRate: oo > 0 ? os2 / oo : null,
      bn, on, ratio: (bo > 0 && oo > 0 && bs / bo) ? (bs / bo) / (os2 / oo) : null,
      cenOk, cenN
    };
  });

  chk('结论② 总仓受限格缺货率 > 总仓正常格缺货率', whCmp.badRate !== null && whCmp.okRate !== null && whCmp.badRate > whCmp.okRate,
    `受限=${(whCmp.badRate * 100).toFixed(2)}% (n=${whCmp.bn})  正常=${(whCmp.okRate * 100).toFixed(2)}% (n=${whCmp.on})  倍数=${whCmp.ratio ? whCmp.ratio.toFixed(2) : '—'}x`);
  chk('结论② 倍数 >= 1.15（信号有效）', whCmp.ratio !== null && whCmp.ratio >= 1.15);
  chk('🔴 Censored 语义：censored=true 必须 winDays===0', whCmp.cenOk, 'censoredN=' + whCmp.cenN);

  // ── 门槛方向：压货只算经销商、压货脉冲不过滤双休日 ────────────────────
  const cellMeta = await page.evaluate(() => {
    const p = getMonthendProfile();
    const keys = Object.keys(p.cells);
    let nElig = 0, idxNull = 0, daysOk = true;
    const months = {};
    keys.forEach(k => {
      const c = p.cells[k];
      months[c.ym] = 1;
      if (c.eligible) {
        nElig++;
        if (c.idx === null) idxNull++;
        if (c.winDaysN < ME_PARAMS.TAIL_DAYS_MIN) daysOk = false;
      }
    });
    return { nCells: keys.length, nElig, idxNull, daysOk, nMonths: Object.keys(months).length, months: Object.keys(months).sort() };
  });
  chk('eligible 格子均满足 winDaysN >= TAIL_DAYS_MIN(' + 3 + ')', cellMeta.daysOk);
  chk('eligible 格子 idx 均非 null', cellMeta.idxNull === 0, 'idxNull=' + cellMeta.idxNull);
  chk('月份覆盖 >= 5 个月', cellMeta.nMonths >= 5, cellMeta.months.join(','));

  // ── 图表实例化（4 个）────────────────────────────────────────────────
  const charts = await page.evaluate(() => {
    const ids = ['chart-me-quad', 'chart-me-wh', 'chart-me-month', 'chart-me-rdc'];
    return ids.map(id => {
      const el = document.getElementById(id);
      if (!el) return { id, exists: false, hasInst: false };
      const inst = (typeof echarts !== 'undefined') ? echarts.getInstanceByDom(el) : null;
      let seriesN = 0;
      try { if (inst) seriesN = (inst.getOption().series || []).length; } catch (e) {}
      return { id, exists: true, hasInst: !!inst, seriesN, w: el.clientWidth, h: el.clientHeight };
    });
  });
  charts.forEach(c => chk('图表 ' + c.id + ' 已实例化且有 series', c.exists && c.hasInst && c.seriesN > 0,
    `exists=${c.exists} inst=${c.hasInst} series=${c.seriesN} ${c.w}x${c.h}`));

  // ── 表格与分页 ───────────────────────────────────────────────────────
  const tbl = await page.evaluate(() => {
    const t = document.querySelector('#page-shortage table.data-table');
    if (!t) return { ok: false };
    const th = [...t.querySelectorAll('thead th')].map(x => x.textContent.trim());
    const tr = t.querySelectorAll('tbody tr').length;
    return { ok: true, th, tr, firstRow: t.querySelector('tbody tr') ? t.querySelector('tbody tr').innerText.slice(0, 200) : '' };
  });
  chk('清单表格存在', tbl.ok);
  if (tbl.ok) {
    chk('表头含「象限」「压货达标率」「缺货率」「总仓供应」「归因」',
      ['象限', '压货达标率', '缺货率', '总仓供应', '归因'].every(k => tbl.th.some(x => x.indexOf(k) >= 0)),
      tbl.th.join('|'));
    chk('表体有数据行（<= 20/页）', tbl.tr > 0 && tbl.tr <= 20, 'rows=' + tbl.tr);
  }

  // ── 交互：切换象限 A → all ────────────────────────────────────────────
  const quadSwitch = await page.evaluate(async () => {
    const before = window._meQuad;
    window._meQuad = 'all'; window._mePage = 1; renderShortage();
    await new Promise(r => setTimeout(r, 400));
    const afterAll = window._meQuad;
    window._meQuad = 'A'; window._mePage = 1; renderShortage();
    await new Promise(r => setTimeout(r, 400));
    return { before, afterAll, backToA: window._meQuad };
  });
  chk('象限筛选状态可切换（A→all→A）', quadSwitch.afterAll === 'all' && quadSwitch.backToA === 'A');

  // ── 设置只读状态：确保导出函数存在 ────────────────────────────────────
  const fnOk = await page.evaluate(() => ({
    render: typeof window.renderMonthendAnalysis === 'function',
    exp: typeof window.exportMonthendCSV === 'function',
    prof: typeof window.getMonthendProfile === 'function'
  }));
  chk('renderMonthendAnalysis 已挂 window', fnOk.render);
  chk('exportMonthendCSV 已挂 window', fnOk.exp);
  chk('getMonthendProfile 已挂 window', fnOk.prof);

  // ── 末态：回到 A 象限后截图前的稳定性 ─────────────────────────────────
  await page.evaluate(() => { window._meQuad = 'A'; window._mePage = 1; renderShortage(); });
  await page.waitForTimeout(1500);

  // ── 运行时错误 ───────────────────────────────────────────────────────
  const realErrs = errs.filter(e => !/favicon|404|net::ERR/.test(e));
  chk('无 JS 运行时错误', realErrs.length === 0, realErrs.length ? realErrs.slice(0, 3).join(' || ') : '');

  // ── 截图（真实滚动后 boundingBox，避免 clip 越界）─────────────────────
  const shotDir = path.join(ROOT, 'tools', '_out');
  if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shotDir, '_me_top.png'), clip: await page.evaluate(() => {
      const el = document.getElementById('page-shortage');
      const r = el.getBoundingClientRect();
      return { x: 0, y: Math.max(0, r.top), width: Math.min(1500, r.width), height: Math.min(950, Math.max(200, window.innerHeight - r.top)) };
    }) }).catch(() => {});
    for (const id of ['chart-me-quad', 'chart-me-wh', 'chart-me-month', 'chart-me-rdc']) {
      const el = await page.$('#' + id);
      if (!el) continue;
      await el.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      const box = await el.boundingBox();
      if (box && box.width > 10 && box.height > 10) {
        await page.screenshot({ path: path.join(shotDir, '_me_' + id + '.png'), clip: box });
      }
    }
    R.lines.push('  📸 截图已保存到 tools/_out/_me_*.png');
  } catch (e) { R.lines.push('  ⚠ 截图失败: ' + (e.message || e)); }

  await browser.close();
  if (server) server.close();

  console.log('\n===== 自检结果 =====');
  console.log(R.lines.join('\n'));
  console.log('\n合计 ' + (R.pass + R.fail) + ' 项，通过 ' + R.pass + '，失败 ' + R.fail);
  process.exit(R.fail ? 1 : 0);
})().catch(e => { console.error('探针异常:', e && e.stack || e); process.exit(2); });
