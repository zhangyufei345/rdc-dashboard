// 线上实测：严重度评分是否受未放行量影响（v377 只展示 vs v353 并入）
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
const LIVE = process.env.LIVE_URL || 'https://rdc-dashboard.pages.dev/';

(async () => {
  const exe = (() => {
    const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'); const c = [];
    if (!fs.existsSync(base)) return null;
    for (const d of fs.readdirSync(base)) {
      c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
      c.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
    }
    return c.find(p => fs.existsSync(p));
  })();
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  const noise = t => /Failed to load resource/i.test(t) || /\b404\b/.test(t) || /net::ERR_/.test(t);
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !noise(m.text())) errs.push('console.error: ' + m.text()); });

  await page.goto(LIVE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.fill('#login-user', 'admin').catch(() => { });
  await page.fill('#login-pass', 'admin123').catch(() => { });
  await page.click('#login-page button').catch(() => { });
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore.loaded === true, { timeout: 240000 });
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 180000 });
  console.log('BUILD_VERSION =', await page.evaluate(() => BUILD_VERSION));

  const out = await page.evaluate(() => {
    const p = buildMonthlyShortageProfile();
    const rows = p.list.filter(q => q.month === '2026-09');
    const charged = rows.filter(q => (q.unrelQty || 0) > 0);
    // 复算：把未放行量扣掉 = v377 纯已放行口径；用页面自身阈值判定入选
    const thr = p.dynamicThresholds;
    return {
      total: rows.length,
      thr,
      chargedCnt: charged.length,
      chargedQty: charged.reduce((a, q) => a + q.unrelQty, 0),
      chargedRows: charged.map(q => ({ sku: q.sku, name: q.name, rdc: q.rdc, un: q.unrelQty,
        shortQty: q.shortQty, orderQty: q.orderQty, mr: q.mr, sf: q.sf, sizePct: q.sizePct,
        sev: q.severity, hp: q.isPersistent, sevKeys: Object.keys(q).filter(k => /sev/i.test(k)) })),
      hiCnt: rows.filter(q => q.isPersistent).length,
      hiQty: rows.filter(q => q.isPersistent).reduce((a, q) => a + q.shortQty, 0),
    };
  });

  console.log('\n2026-09 画像组合 =', out.total);
  console.log('动态阈值 =', JSON.stringify(out.thr));
  console.log('「严重度高」入选数 =', out.hiCnt, '| 入选缺货量合计 =', out.hiQty.toLocaleString());
  console.log('★ 挂 unrelQty 的组合 =', out.chargedCnt, '| 未放行量合计 =', out.chargedQty.toLocaleString(), '支');
  console.log('\n--- 挂 unrelQty 的组合（页面真实值）---');
  const f = (v, d) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(d === undefined ? 4 : d) : 'n/a';
  out.chargedRows.sort((a, b) => b.un - a.un).forEach(q => {
    console.log(`  ${q.sku} ${q.name} · ${q.rdc}`);
    console.log(`     未放行 ${q.un.toLocaleString()} | 订单量 ${q.orderQty.toLocaleString()} | 首日缺货 ${q.shortQty.toLocaleString()} | mr ${f(q.mr * 100, 2)}% | sf ${f(q.sf * 100, 1)}% | sizePct ${f(q.sizePct)} | sev ${f(q.severity)} | 入选 ${q.isPersistent ? '是' : '否'}`);
  });

  // 🔴 关键校验：若 v353（并入）会怎样 —— 用页面阈值粗算
  console.log('\n--- 若按 v353 并入（分子分母同加未放行）会怎样 ---');
  out.chargedRows.sort((a, b) => b.un - a.un).slice(0, 8).forEach(q => {
    const s2 = q.shortQty + q.un, o2 = q.orderQty + q.un;
    const mr2 = o2 > 0 ? s2 / o2 : 0;
    console.log(`  ${q.sku} ${q.rdc}: 缺货 ${q.shortQty.toLocaleString()}→${s2.toLocaleString()} | 订单 ${q.orderQty.toLocaleString()}→${o2.toLocaleString()} | mr ${f(q.mr * 100, 2)}%→${f(mr2 * 100, 2)}%`);
  });

  console.log('\n运行时错误 =', errs.length, errs.slice(0, 3));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
