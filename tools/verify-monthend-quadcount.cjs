#!/usr/bin/env node
/**
 * v392「月底压货商品分析」筛选栏数字联动 验证探针
 *
 * 用户报（2026-09-30，截图）：「这里如果选了RDC，希望筛选框的数字能和RDC实际对齐，而不是整体数据」
 *   现象：RDC=东北RDC 时，象限按钮仍显示全局 全部345 / A15 / B66 / C72 / D192，
 *         右下角仍写「共 345 个 SKU×RDC」，而列表实际只有 14 个。
 *
 * 覆盖五层：
 *   A. 无筛选基线：按钮数字 == rowsAll / prof.counts（全局）
 *   B. 🔴 逐个 RDC：按钮数字 == 该 RDC 同源复算（不硬编码）＋ 与全局不同（证明确实联动了）
 *   C. 🔴 RDC + 只看总仓受限：两者叠加口径正确
 *   D. 不误伤：页面级「全量口径」区（4 张象限卡 / 三条结论）必须仍是全局数字
 *   E. 自洽 + 无副作用：A+B+C+D == 全部、共 N 与清单一致、无 JS 错误
 *
 * 用法：
 *   NODE_PATH=... node tools/verify-monthend-quadcount.cjs
 *   RDC_BASE=https://rdc-dashboard.pages.dev ... node tools/verify-monthend-quadcount.cjs
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.RDC_BASE || '').replace(/\/$/, '');

function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const c = [];
  for (const d of fs.readdirSync(base)) {
    c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    c.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  return c.find(p => fs.existsSync(p));
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
function startServer() {
  const s = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(s)));
}

const R = { pass: 0, fail: 0 };
function chk(n, c, d) { c ? R.pass++ : R.fail++; console.log((c ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); }

// ── 页面内注入：读筛选栏数字 + 读同源 profile 复算 ────────────────────────
const READ_BAR = () => {
  const inPage = document.getElementById('page-shortage');
  if (!inPage) return { err: 'page-shortage 不存在' };
  // 只取「筛选栏」的 5 个象限按钮：BUTTON 且 onclick 含 _meQuad=
  const btns = Array.from(inPage.querySelectorAll('button'))
    .filter(b => /_meQuad=/.test(b.getAttribute('onclick') || ''));
  const map = {};
  const raw = [];
  btns.forEach(b => {
    const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
    raw.push(t);
    const m = t.match(/^(全部|A 重点|B 可放|C 另有原因|D 忽略)\s+([\d,]+)$/);
    if (m) map[m[1]] = parseInt(m[2].replace(/,/g, ''), 10);
  });
  // 「共 N 个 SKU×RDC（口径） → 筛选后 M 个」
  const span = Array.from(inPage.querySelectorAll('span'))
    .find(s => /个 SKU×RDC/.test(s.innerText || ''));
  const scopeText = span ? (span.innerText || '').replace(/\s+/g, ' ').trim() : null;
  const mScope = scopeText && scopeText.match(/共\s*([\d,]+)\s*个 SKU×RDC\s*(（[^）]*）)?\s*→\s*筛选后\s*([\d,]+)\s*个/);
  // 页面级「全量口径」区的 4 张象限卡：非 BUTTON 且 onclick 含 _meQuad=
  //   ⚠️ 卡片文本形如 "15 A · 重点关注 …"，但 innerText 是否在数字与字母之间插换行
  //   取决于渲染，故用 `\s*` 而非 `\s+`（首版写 `\s+` 导致 4 张卡一张都解析不到）。
  const cardEls = Array.from(inPage.querySelectorAll('[onclick*="_meQuad="]')).filter(e => e.tagName !== 'BUTTON');
  const cardRaw = cardEls.map(e => (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40));
  const cards = cardEls.map(e => {
    const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
    const m = t.match(/^([\d,]+)\s*([ABCD])\s*·/) || t.match(/([\d,]+)\s*([ABCD])\s*·/);
    return m ? { quad: m[2], n: parseInt(m[1].replace(/,/g, ''), 10) } : null;
  }).filter(Boolean);
  return {
    buttons: map,
    buttonsRaw: raw,
    scopeN: mScope ? parseInt(mScope[1].replace(/,/g, ''), 10) : null,
    scopeTag: mScope && mScope[2] ? mScope[2] : '',
    afterN: mScope ? parseInt(mScope[3].replace(/,/g, ''), 10) : null,
    scopeText: scopeText,
    cards: cards,
    cardRaw: cardRaw,
  };
};

(async () => {
  const { chromium } = require('playwright-core');
  let server = null, URL;
  if (BASE) URL = BASE + '/rdc-dashboard.html';
  else { server = await startServer(); URL = 'http://127.0.0.1:' + server.address().port + '/rdc-dashboard.html'; }
  console.log('目标:', URL);

  const b = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('[pageerror] ' + (e.message || e)));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('[console] ' + m.text().slice(0, 200)); });

  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.fill('#login-user', 'admin').catch(() => {});
  await p.fill('#login-pass', 'admin123').catch(() => {});
  await p.click('#login-page button').catch(() => {});
  await p.waitForFunction(() => window._bootLoading === false && typeof dataStore !== 'undefined' && dataStore.loaded === true, { timeout: 240000 });
  console.log('数据装载完成');

  // 进入「月底压货商品分析」TAB
  //   🔴 必须先 navigateTo('shortage') —— handleLogin 收尾会强制 navigateTo('overview')，
  //   只设 _shortageTab 的话 renderShortage 渲染进 #page-shortage 但该页不是激活页（实测截图是总览）。
  const enter = async () => {
    await p.evaluate(() => {
      if (typeof navigateTo === 'function') navigateTo('shortage');
      window._shortageTab = 'monthend';
      if (typeof renderShortage === 'function') renderShortage();
    });
    await p.waitForTimeout(1200);
    // 若被其它渲染抢走，重试一次
    const ok = await p.evaluate(() => !!document.querySelector('#page-shortage button[onclick*="_meQuad="]'));
    if (!ok) {
      await p.evaluate(() => { navigateTo('shortage'); window._shortageTab = 'monthend'; renderShortage(); });
      await p.waitForTimeout(1500);
    }
  };
  // 🔴 统一重渲染入口：每次都确保「在缺货分析页 + 月底压货 TAB」再应用筛选状态。
  //   只设 window._shortageTab 而不 navigateTo，会渲染进**未激活**的 #page-shortage
  //   （handleLogin 收尾强制 navigateTo('overview') → 实测截图看到的是总览页）。
  const rerender = async () => {
    await p.evaluate(() => {
      if (typeof currentPage === 'undefined' || currentPage !== 'shortage') {
        if (typeof navigateTo === 'function') navigateTo('shortage');
      }
      window._shortageTab = 'monthend';
      if (typeof renderShortage === 'function') renderShortage();
    });
    await p.waitForTimeout(700);
  };
  const setRdc = async (rdc) => {
    await p.evaluate((v) => { window._meRdc = v; window._mePage = 1; }, rdc);
    await rerender();
  };
  const setWhOnly = async (v) => {
    await p.evaluate((val) => { window._meWhBadOnly = !!val; window._mePage = 1; }, v);
    await rerender();
  };
  const setQuad = async (q) => {
    await p.evaluate((v) => { window._meQuad = v; window._mePage = 1; }, q);
    await rerender();
  };

  await enter();
  await setQuad('all');
  await setWhOnly(false);
  await setRdc('all');

  // 同源复算入口：getMonthendProfile()
  const expectFor = async (rdc, whOnly) => p.evaluate(([rd, wh]) => {
    const prof = getMonthendProfile();
    const rows = (prof.rows || []).filter(r => {
      if (rd !== 'all' && r.rdc !== rd) return false;
      if (wh && r.whConcl !== '总仓受限') return false;
      return true;
    });
    const c = { A: 0, B: 0, C: 0, D: 0 };
    rows.forEach(r => { if (c[r.quad] != null) c[r.quad]++; });
    return { total: rows.length, counts: c, globalTotal: (prof.rows || []).length, globalCounts: prof.counts || null,
             rdcs: Array.from(new Set((prof.rows || []).map(r => r.rdc))).sort() };
  }, [rdc, whOnly]);

  // ── A. 无筛选基线 ────────────────────────────────────────────────────
  console.log('\n===== A. 无筛选基线（RDC=全部，未开总仓受限）=====');
  const curPage = await p.evaluate(() => (typeof currentPage === 'undefined' ? '(undefined)' : currentPage));
  chk('确实停在「缺货分析」页（防止渲染进未激活容器 → 断言全是"看不见的 DOM"）', curPage === 'shortage', 'currentPage=' + curPage);
  const expAll = await expectFor('all', false);
  let bar = await p.evaluate(READ_BAR);
  chk('筛选栏 5 个象限按钮都能解析出数字', bar.buttons['全部'] != null && bar.buttons['A 重点'] != null && bar.buttons['D 忽略'] != null,
    JSON.stringify(bar.buttonsRaw));
  chk('「全部」== 同源 rowsAll 条数 ' + expAll.total, bar.buttons['全部'] === expAll.total, '页面=' + bar.buttons['全部']);
  chk('A/B/C/D == 同源各象限条数', bar.buttons['A 重点'] === expAll.counts.A && bar.buttons['B 可放'] === expAll.counts.B
    && bar.buttons['C 另有原因'] === expAll.counts.C && bar.buttons['D 忽略'] === expAll.counts.D,
    '页面=' + JSON.stringify(bar.buttons) + ' 同源=' + JSON.stringify(expAll.counts));
  chk('「共 N」== 同源 rowsAll 条数 ' + expAll.total, bar.scopeN === expAll.total, '页面=' + bar.scopeN);
  chk('无筛选时「共 N」不带口径标注', !bar.scopeTag, JSON.stringify(bar.scopeTag));

  // ── B. 逐个 RDC ──────────────────────────────────────────────────────
  console.log('\n===== B. 逐个 RDC：数字必须与该 RDC 对齐（用户报的核心）=====');
  const rdcs = expAll.rdcs;
  chk('至少 2 个 RDC（否则「与全局不同」无从验证）', rdcs.length >= 2, JSON.stringify(rdcs));
  for (const rd of rdcs) {
    const exp = await expectFor(rd, false);
    await setRdc(rd);
    const got = await p.evaluate(READ_BAR);
    const same = got.buttons['全部'] === exp.total
      && got.buttons['A 重点'] === exp.counts.A && got.buttons['B 可放'] === exp.counts.B
      && got.buttons['C 另有原因'] === exp.counts.C && got.buttons['D 忽略'] === exp.counts.D;
    chk('🔴 ' + rd + '：按钮数字 == 该仓同源复算（全部' + exp.total + ' / A' + exp.counts.A + ' B' + exp.counts.B
      + ' C' + exp.counts.C + ' D' + exp.counts.D + '）', same,
      '页面=' + JSON.stringify(got.buttons));
    chk('🔴 ' + rd + '：「共 N」== 该仓条数 ' + exp.total + '（不再是全局 ' + expAll.total + '）',
      got.scopeN === exp.total, '页面=' + got.scopeN);
    chk('🔴 ' + rd + '：按钮数字与「全局口径」确实不同（证明真联动了）',
      exp.total !== expAll.total, '本仓=' + exp.total + ' 全局=' + expAll.total);
    chk('🔴 ' + rd + '：「共 N」带口径标注 ' + JSON.stringify(rd), got.scopeTag.indexOf(rd) >= 0, JSON.stringify(got.scopeTag));
    chk(rd + '：A+B+C+D == 全部（自洽）',
      got.buttons['A 重点'] + got.buttons['B 可放'] + got.buttons['C 另有原因'] + got.buttons['D 忽略'] === got.buttons['全部'],
      JSON.stringify(got.buttons));
  }

  // ── C. RDC + 只看总仓受限 ────────────────────────────────────────────
  console.log('\n===== C. RDC + 只看总仓受限（叠加口径）=====');
  // 选「总仓受限条数最多」的 RDC，保证叠加口径不是空集（空集下断言会无意义地通过）
  const whRank = await p.evaluate(() => {
    const rows = (getMonthendProfile().rows || []);
    const m = {};
    rows.forEach(r => { if (r.whConcl === '总仓受限') m[r.rdc] = (m[r.rdc] || 0) + 1; });
    return Object.keys(m).sort((a, b2) => m[b2] - m[a]).map(k => ({ rdc: k, n: m[k] }));
  });
  const rd2 = whRank.length ? whRank[0].rdc : rdcs[0];
  console.log('  选定 RDC=' + rd2 + '（总仓受限 ' + (whRank.length ? whRank[0].n : 0) + ' 条）｜全部候选=' + JSON.stringify(whRank));
  const expC = await expectFor(rd2, true);
  await setRdc(rd2);
  await setWhOnly(true);
  const gotC = await p.evaluate(READ_BAR);
  chk('C 层样本非空（否则断言无意义）', expC.total > 0, '叠加条数=' + expC.total);
  chk('🔴 ' + rd2 + ' + 只看总仓受限：全部 == 同源叠加条数 ' + expC.total,
    gotC.buttons['全部'] === expC.total, '页面=' + gotC.buttons['全部']);
  chk('🔴 ' + rd2 + ' + 只看总仓受限：各象限 == 同源复算',
    gotC.buttons['A 重点'] === expC.counts.A && gotC.buttons['B 可放'] === expC.counts.B
    && gotC.buttons['C 另有原因'] === expC.counts.C && gotC.buttons['D 忽略'] === expC.counts.D,
    '页面=' + JSON.stringify(gotC.buttons) + ' 同源=' + JSON.stringify(expC.counts));
  chk('🔴 「共 N」带「只看总仓受限」标注', gotC.scopeTag.indexOf('只看总仓受限') >= 0, JSON.stringify(gotC.scopeTag));
  const expRd2Only = await expectFor(rd2, false);
  chk('叠加后条数 <= 仅 RDC 筛选条数（单调收窄）', expC.total <= expRd2Only.total,
    expC.total + ' <= ' + expRd2Only.total);
  await setWhOnly(false);

  // ── D. 不误伤：页面级「全量口径」区必须仍是全局 ──────────────────────
  console.log('\n===== D. 不误伤：页面级「全量口径」区仍是全局数字 =====');
  // 此时仍选中 rd2 → 检验 4 张象限卡没被联动
  const gotD = await p.evaluate(READ_BAR);
  const expGlobal = await expectFor('all', false);
  const cardMap = {};
  gotD.cards.forEach(c => { cardMap[c.quad] = c.n; });
  chk('4 张象限卡都被解析到', gotD.cards.length === 4, JSON.stringify(gotD.cards) + ' 原始文本=' + JSON.stringify(gotD.cardRaw));
  chk('🔴 4 张象限卡仍是「全量口径」（选 ' + rd2 + ' 时不变）',
    cardMap.A === expGlobal.counts.A && cardMap.B === expGlobal.counts.B
    && cardMap.C === expGlobal.counts.C && cardMap.D === expGlobal.counts.D,
    '卡片=' + JSON.stringify(cardMap) + ' 全局=' + JSON.stringify(expGlobal.counts));
  chk('🔴 象限卡（全局）与筛选栏（' + rd2 + '）确实是两套数字，各自都对',
    gotD.buttons['全部'] === expRd2Only.total && cardMap.A + cardMap.B + cardMap.C + cardMap.D === expGlobal.total,
    '筛选栏全部=' + gotD.buttons['全部'] + '（应=' + expRd2Only.total + '）｜卡片合计=' +
    (cardMap.A + cardMap.B + cardMap.C + cardMap.D) + '（应=' + expGlobal.total + '）');
  await setRdc('all');

  // ── E. 自洽 + 无副作用 ───────────────────────────────────────────────
  console.log('\n===== E. 自洽与无副作用 =====');
  await setQuad('all');
  const gotE = await p.evaluate(READ_BAR);
  chk('quad=all 且无筛选时「筛选后 N」== 「共 N」== 全部',
    gotE.afterN === gotE.scopeN && gotE.scopeN === gotE.buttons['全部'],
    '共=' + gotE.scopeN + ' 筛选后=' + gotE.afterN + ' 全部按钮=' + gotE.buttons['全部']);
  // 切象限：共 N 不变、筛选后变小
  await setQuad('A');
  const gotE2 = await p.evaluate(READ_BAR);
  chk('切到 A 象限后「共 N」不变（scope 与象限按钮无关）', gotE2.scopeN === gotE.scopeN,
    '前=' + gotE.scopeN + ' 后=' + gotE2.scopeN);
  chk('切到 A 象限后「筛选后 N」== A 的条数', gotE2.afterN === gotE2.buttons['A 重点'],
    '筛选后=' + gotE2.afterN + ' A=' + gotE2.buttons['A 重点']);
  // 切到按 RDC 维度：RDC 下拉仍列出全部 RDC（选项不能被自己筛掉）
  await setQuad('all');
  const rdcOpts = await p.evaluate(() => Array.from(document.querySelectorAll('#page-shortage select option')).map(o => o.value));
  chk('RDC 下拉仍列出全部 RDC（不清空）', rdcOpts.length >= rdcs.length + 1, JSON.stringify(rdcOpts));
  const sizes = await p.evaluate(() => ({
    orderDetail: (dataStore.orderDetail || []).length,
    shortage: (dataStore.shortage || []).length,
    cov7: ((dataStore.inventory && dataStore.inventory.cov7) || []).length,
    meRows: (typeof getMonthendProfile === 'function' ? (getMonthendProfile().rows || []).length : -1),
  }));
  chk('orderDetail 未被误伤（>=100000）', sizes.orderDetail >= 100000, 'orderDetail=' + sizes.orderDetail);
  chk('shortage 未被误伤（>0）', sizes.shortage > 0, 'shortage=' + sizes.shortage);
  chk('cov7 未被误伤（>=100）', sizes.cov7 >= 100, 'cov7=' + sizes.cov7);
  chk('月底压货画像规模正常（>0）', sizes.meRows > 0, 'meRows=' + sizes.meRows);
  chk('无 JS 运行时错误', errs.length === 0, errs.slice(0, 3).join(' | '));

  await p.screenshot({ path: path.join(ROOT, 'tools', '_out', '_me_quadcount_ok.png'), fullPage: false }).catch(() => {});

  console.log('\n合计 ' + (R.pass + R.fail) + ' 项，通过 ' + R.pass + '，失败 ' + R.fail);
  await b.close();
  if (server) server.close();
  process.exit(R.fail ? 1 : 0);
})().catch(e => { console.error('异常:', e && e.message || e); process.exit(2); });
