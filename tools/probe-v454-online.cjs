#!/usr/bin/env node
/**
 * v454 线上端到端核验：D / E 字母互换
 *  ① BUILD_VERSION=454
 *  ② dp-history.json 加载成功
 *  ③ 2026-10 分布 A1 9 / A2 6 / C1 18 / C2 8 / D(计划口径变动) 8 / E(需重点排查) 9，清单 58 行
 *  ④ D 的 8 个组合 == 离线复算；40057·华北 证据文案正确
 *  ⑤ UI：出现「D · 📋 计划口径变动」「E · ⚠️ 需重点排查」，反例不出现
 *  ⑥ 零 pageerror
 */
const fs = require('fs'), path = require('path');
function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const c = [];
  for (const d of fs.readdirSync(base)) { c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(base, d, 'chrome-win64', 'chrome.exe')); }
  return c.find(p => fs.existsSync(p));
}
const EXPECT_REV = ['9859|华中RDC', '20881|华南RDC', '20881|华北RDC', '20956|华北RDC',
  '40057|华北RDC', '40334|东北RDC', '56000|西北RDC', '72048|华北RDC'];
let PASS = 0, FAIL = 0;
function ck(cond, name, extra) {
  if (cond) { PASS++; console.log('  ✅ ' + name); }
  else { FAIL++; console.log('  ❌ ' + name + (extra ? '  →  ' + extra : '')); }
}
(async () => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('https://rdc-dashboard.pages.dev/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 240000 });
  await page.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('shortage'); window._shortageTab = 'monthly'; });
  await page.waitForFunction(() => typeof _demandReady === 'function' && _demandReady(), { timeout: 120000 }).catch(() => {});
  await page.waitForFunction(() => !!window._dpHist || !!window._dpHistError, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1800);

  const r = await page.evaluate(() => {
    window._msMonth = '2026-10'; window._msPage = 1; window._attrFilter = 'all'; window._msDrill = null;
    renderShortage();
    const a = window._msFocusAttr; const by = {};
    (a ? a.results : []).forEach(x => { by[x.type] = (by[x.type] || 0) + 1; });
    const revRows = (a ? a.results : []).filter(x => x.type === 'D')
      .map(x => String(x.sku).replace(/^0+/, '') + '|' + x.rdc).sort();
    const s = (a ? a.results : []).find(x => x.type === 'D');
    const host = document.getElementById('page-shortage');
    const txt = host ? host.innerText : '';
    return { title: document.title, dpOk: !!window._dpHist, dpErr: window._dpHistError,
             hi: a ? a.results.length : -1, by, revRows,
             sample: s ? (s.sku + '·' + s.rdc + '  ' + window._dpRevText(s.planRev)) : null,
             txtD: txt.indexOf('D · 📋 计划口径变动') >= 0,
             txtE: txt.indexOf('E · ⚠️ 需重点排查') >= 0,
             wrong: (txt.indexOf('D · ⚠️ 需重点排查') >= 0) || (txt.indexOf('E · 📋 计划口径变动') >= 0) };
  });
  console.log('线上 title:', r.title);
  console.log('dp-history 加载:', r.dpOk, '| 错误:', r.dpErr || '无');
  console.log('2026-10 清单行数:', r.hi, '| 归因分布:', JSON.stringify(r.by));
  console.log('D(计划口径变动) 组合 (' + r.revRows.length + '):', r.revRows.join(', '));
  console.log('样例:', r.sample);
  console.log('pageErrors =', errs.length, errs.slice(0, 3).join(' | '));

  console.log('\n断言：');
  ck(/454/.test(r.title), 'BUILD_VERSION = 454', r.title);
  ck(r.dpOk && !r.dpErr, 'dp-history.json 已加载', r.dpErr || '');
  ck(r.hi === 58, '2026-10 清单 58 行', String(r.hi));
  ck(r.by.D === 8, 'D(计划口径变动) = 8', String(r.by.D));
  ck(r.by.E === 9, 'E(需重点排查) = 9', String(r.by.E));
  ck(r.by.C1 === 18 && r.by.A1 === 9 && r.by.A2 === 6 && r.by.C2 === 8, '其余类型条数未变', JSON.stringify(r.by));
  ck(r.revRows.join(',') === EXPECT_REV.slice().sort().join(','), 'D 的 8 个组合与离线复算一致', r.revRows.join(','));
  ck(/40057·华北RDC[\s\S]*计划于 2026-10-27 由 3,500 上调至 13,000（3\.7 倍）；缺货发生时计划 2,000/.test(r.sample || ''),
     '40057 证据文案正确', r.sample || '');
  ck(r.txtD, '页面出现「D · 📋 计划口径变动」');
  ck(r.txtE, '页面出现「E · ⚠️ 需重点排查」');
  ck(!r.wrong, '反例：旧绑定已不存在');
  ck(errs.length === 0, 'pageErrors = 0', errs.slice(0, 3).join(' | '));

  console.log('\n============================');
  console.log('PASS ' + PASS + ' / FAIL ' + FAIL);
  await browser.close();
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('异常:', e && e.message); process.exit(2); });
