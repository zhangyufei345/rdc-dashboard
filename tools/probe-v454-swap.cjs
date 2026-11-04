#!/usr/bin/env node
/**
 * v454 验证探针：D / E 字母互换
 *   期望：D = 📋 计划口径变动（原 E）；E = ⚠️ 需重点排查（原 D）
 *  ① dp-history.json 已加载
 *  ② 2026-10 分布 = A1 9 / A2 6 / C1 18 / C2 8 / D 8 / E 9（清单仍 58 行）
 *     —— D 的 8 个组合 == 原 E 的 8 个组合（离线复算值）
 *  ③ 归因卡片/下拉的字母-标签绑定已互换（D·计划口径变动、E·需重点排查）+ 徽章仍在
 *  ④ 降级：删掉 _dpHist → 不再出现 D(计划口径变动)，需重点排查回到 17 条
 *  ⑤ 零 pageerror
 */
const fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const c = [];
  for (const d of fs.readdirSync(base)) { c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(base, d, 'chrome-win64', 'chrome.exe')); }
  return c.find(p => fs.existsSync(p));
}
function startServer() {
  const s = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(s)));
}
// v453 离线复算出的「计划口径变动」8 个组合（v454 起归到 D）
const EXPECT_REV = ['9859|华中RDC', '20881|华南RDC', '20881|华北RDC', '20956|华北RDC',
  '40057|华北RDC', '40334|东北RDC', '56000|西北RDC', '72048|华北RDC'];
let PASS = 0, FAIL = 0;
function ck(cond, name, extra) {
  if (cond) { PASS++; console.log('  ✅ ' + name); }
  else { FAIL++; console.log('  ❌ ' + name + (extra ? '  →  ' + extra : '')); }
}
(async () => {
  const { chromium } = require('playwright-core');
  const server = await startServer(); const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1700, height: 1000 } })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 180000 });
  await page.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('shortage'); window._shortageTab = 'monthly'; });
  await page.waitForFunction(() => typeof _demandReady === 'function' && _demandReady(), { timeout: 90000 }).catch(() => {});
  await page.waitForFunction(() => !!window._dpHist || !!window._dpHistError, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1200);

  console.log('\n【A】dp-history.json 加载');
  const dp = await page.evaluate(() => ({ ok: !!window._dpHist, err: window._dpHistError }));
  ck(dp.ok && !dp.err, 'dp-history.json 已加载', dp.err || '');

  console.log('\n【B】2026-10 归因分布（D 与 E 互换）');
  const r = await page.evaluate(() => {
    window._msMonth = '2026-10'; window._msPage = 1; window._attrFilter = 'all'; window._msDrill = null;
    renderShortage();
    const a = window._msFocusAttr; if (!a) return null;
    const by = {};
    a.results.forEach(x => { by[x.type] = (by[x.type] || 0) + 1; });
    const revRows = a.results.filter(x => x.type === 'D')
      .map(x => String(x.sku).replace(/^0+/, '') + '|' + x.rdc).sort();
    const sample = a.results.find(x => x.type === 'D');
    return { hi: a.results.length, by, revRows, sample: sample ? { sku: sample.sku, rdc: sample.rdc, txt: window._dpRevText(sample.planRev), rv: sample.planRev } : null };
  });
  if (!r) { ck(false, '归因数据可读'); }
  else {
    console.log('     清单 ' + r.hi + ' 行 →', JSON.stringify(r.by));
    ck(r.hi === 58, '2026-10 清单仍为 58 行', String(r.hi));
    ck(r.by.D === 8, 'D(计划口径变动) = 8', String(r.by.D));
    ck(r.by.E === 9, 'E(需重点排查) = 9（原 D 的 9 条真 D）', String(r.by.E));
    ck(r.by.C1 === 18 && r.by.A1 === 9 && r.by.A2 === 6 && r.by.C2 === 8, '其余类型条数未变', JSON.stringify(r.by));
    const got = r.revRows.join(','), exp = EXPECT_REV.slice().sort().join(',');
    ck(got === exp, 'D 的 8 个组合与离线复算完全一致', '\n        得到: ' + got + '\n        期望: ' + exp);
    if (r.sample) console.log('        样例 ' + r.sample.sku + '·' + r.sample.rdc + '：' + r.sample.txt +
      '  | 完成率 ' + (r.sample.rv.compLow * 100).toFixed(1) + '% → ' + (r.sample.rv.compEnd * 100).toFixed(1) + '%');
    ck(!!r.sample, 'D 行带 planRev 证据（互换后仍生效）');
  }

  console.log('\n【C】UI：字母-标签绑定');
  const ui = await page.evaluate(() => {
    window._msMonth = '2026-10'; window._msPage = 1; window._attrFilter = 'all';
    renderShortage();
    const host = document.getElementById('page-shortage');
    const txt = host ? host.innerText : '';
    const sel = host ? host.querySelector('select[onchange*="_attrFilter"]') : null;
    const optTxt = sel ? Array.from(sel.options).map(o => o.value + '=' + o.textContent.trim()) : [];
    const badge = host ? Array.from(host.querySelectorAll('div')).filter(d => /^计划 \d\d-\d\d ↑[\d.]+x$/.test((d.innerText || '').trim())).length : 0;
    // 卡片左边框颜色：D=#0369A1(蓝, 计划口径变动) / E=#374151(灰, 需重点排查)
    const cardInfo = {};
    if (host) {
      // 坑：卡片 innerText 以右上角百分比开头（"12.2%\nD · 📋 ..."），不能用 ^字母 匹配；
      // 改为「取左边框为实色的 div，再在文本里找字母 · 标签」，命中即取该 div 的边框色
      Array.from(host.querySelectorAll('div')).forEach(d => {
        const bl = d.style && d.style.borderLeft;
        if (!bl || bl.indexOf('solid') < 0) return;
        const t = d.innerText || '';
        ['A1', 'A2', 'C1', 'C2', 'D', 'E'].forEach(k => {
          if (cardInfo[k]) return;
          if (t.indexOf(k + ' · ') >= 0) cardInfo[k] = { label: (t.split(k + ' · ')[1] || '').split('\n')[0].trim(), border: bl };
        });
      });
    }
    return { txtHasDRev: txt.indexOf('D · 📋 计划口径变动') >= 0, txtHasECheck: txt.indexOf('E · ⚠️ 需重点排查') >= 0,
             txtWrong: (txt.indexOf('D · ⚠️ 需重点排查') >= 0) || (txt.indexOf('E · 📋 计划口径变动') >= 0),
             optTxt, badge, cardInfo };
  });
  console.log('     下拉:', JSON.stringify(ui.optTxt));
  console.log('     卡片:', JSON.stringify(ui.cardInfo).slice(0, 320));
  ck(ui.txtHasDRev, '页面出现「D · 📋 计划口径变动」');
  ck(ui.txtHasECheck, '页面出现「E · ⚠️ 需重点排查」');
  ck(!ui.txtWrong, '反例：不再出现「D · ⚠️ 需重点排查」或「E · 📋 计划口径变动」');
  ck(/D=.*计划口径变动/.test(ui.optTxt.join('|')), '下拉 D 绑定计划口径变动', ui.optTxt.join('|').slice(0, 160));
  ck(/E=.*需重点排查/.test(ui.optTxt.join('|')), '下拉 E 绑定需重点排查', ui.optTxt.join('|').slice(0, 160));
  ck(/rgb\(3,\s*105,\s*161\)|#0369A1/i.test((ui.cardInfo.D || {}).border || ''), 'D 卡片配色=蓝(#0369A1)', (ui.cardInfo.D || {}).border);
  ck(/rgb\(55,\s*65,\s*81\)|#374151/i.test((ui.cardInfo.E || {}).border || ''), 'E 卡片配色=灰(#374151)', (ui.cardInfo.E || {}).border);
  ck(ui.badge >= 1, '归因单元格仍有「计划 MM-DD ↑N.Nx」小字', 'badge=' + ui.badge);

  console.log('\n【D】降级路径（无 dp-history → 不做改判）');
  const deg = await page.evaluate(() => {
    const bak = window._dpHist; window._dpHist = null;
    window._msMonth = '2026-10'; window._msPage = 1; window._attrFilter = 'all';
    renderShortage();
    const a = window._msFocusAttr; const by = {};
    (a ? a.results : []).forEach(x => { by[x.type] = (by[x.type] || 0) + 1; });
    window._dpHist = bak; renderShortage();
    return by;
  });
  console.log('     无 dp-history 时:', JSON.stringify(deg));
  ck((deg.D === undefined || deg.D === 0) && deg.E === 17, '无 dp-history → D(计划口径变动) 消失、E(需重点排查)=17', JSON.stringify(deg));

  console.log('\n【E】运行时错误');
  ck(errs.length === 0, 'pageErrors = 0', errs.slice(0, 4).join(' | '));

  console.log('\n============================');
  console.log('PASS ' + PASS + ' / FAIL ' + FAIL);
  await browser.close(); server.close();
  process.exit(FAIL ? 1 : 0);
})();
