#!/usr/bin/env node
/**
 * v453 验证探针：E「计划口径变动」
 *  ① dp-history.json 能加载（否则 console 有 warn）
 *  ② 2026-10 归因分布应为 A1 9 / A2 6 / C1 18 / C2 8 / D 9 / E 8（清单仍 58 行）
 *  ③ E 的 8 行必须与我离线算出的 8 个 SKU×RDC 完全一致
 *  ④ 归因卡片出现第 7 张 E、下拉出现 E 选项、单元格出现「计划 MM-DD ↑N.Nx」
 *  ⑤ 2026-09 也应出现 E（该月归档同样有分仓需求）
 *  ⑥ 零 pageerror
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
const EXPECT_E = ['9859|华中RDC', '20881|华南RDC', '20881|华北RDC', '20956|华北RDC',
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
  const dp = await page.evaluate(() => ({
    ok: !!window._dpHist, err: window._dpHistError,
    months: window._dpHist ? Object.keys(window._dpHist.months || {}) : [],
    n10: window._dpHist && window._dpHist.months['2026-10'] ? Object.keys(window._dpHist.months['2026-10']).length : 0
  }));
  ck(dp.ok && !dp.err, 'dp-history.json 已加载', dp.err || '');
  console.log('     月份:', JSON.stringify(dp.months), '| 2026-10 键数:', dp.n10);
  ck(dp.n10 > 2000, '2026-10 键数 > 2000', String(dp.n10));

  console.log('\n【B】buildHiAttribution 归因分布');
  for (const m of ['2026-10', '2026-09']) {
    const r = await page.evaluate(mm => {
      window._msMonth = mm; window._msPage = 1; window._attrFilter = 'all'; window._msDrill = null;
      renderShortage();
      const a = window._msFocusAttr;
      if (!a) return null;
      const by = {};
      a.results.forEach(x => { by[x.type] = (by[x.type] || 0) + 1; });
      const eRows = a.results.filter(x => x.type === 'E')
        .map(x => String(x.sku).replace(/^0+/, '') + '|' + x.rdc).sort();
      const sample = a.results.find(x => x.type === 'E');
      return { hi: a.results.length, by, eRows, nE: eRows.length,
               sample: sample ? { sku: sample.sku, rdc: sample.rdc, txt: window._dpRevText(sample.planRev),
                                  rv: sample.planRev } : null };
    }, m);
    if (!r) { ck(false, m + ' 归因数据可读'); continue; }
    console.log('     ' + m + ' 清单 ' + r.hi + ' 行 →', JSON.stringify(r.by));
    if (m === '2026-10') {
      ck(r.hi === 58, '2026-10 清单仍为 58 行', String(r.hi));
      ck(r.by.D === 9, 'D 由 17 → 9', String(r.by.D));
      ck(r.by.E === 8, 'E = 8', String(r.by.E));
      ck(r.by.C1 === 18 && r.by.A1 === 9 && r.by.A2 === 6 && r.by.C2 === 8, '其余类型条数未变',
         JSON.stringify(r.by));
      const got = r.eRows.join(','), exp = EXPECT_E.slice().sort().join(',');
      ck(got === exp, 'E 的 8 个组合与离线复算完全一致', '\n        得到: ' + got + '\n        期望: ' + exp);
      ck(!!r.sample && /计划于 \d{4}-\d\d-\d\d 由 [\d,]+ 上调至 [\d,]+（[\d.]+ 倍）；缺货发生时计划 [\d,]+/.test(r.sample.txt),
         '证据文案格式正确', r.sample ? r.sample.txt : '无 E 样本');
      if (r.sample) console.log('        样例 ' + r.sample.sku + '·' + r.sample.rdc + '：' + r.sample.txt +
        '  | 完成率 ' + (r.sample.rv.compLow * 100).toFixed(1) + '% → ' + (r.sample.rv.compEnd * 100).toFixed(1) + '%');
    } else {
      // 9 月清单 74 行里没有 D 类（C1/A2/A1），E 只从 D 改判而来 → 该月 E 必然为 0，这是预期
      ck(r.by.E === undefined || r.by.E === 0, m + ' E=0（该月无 D 行，E 只从 D 改判）', JSON.stringify(r.by));
    }
  }

  console.log('\n【C】UI 呈现');
  const ui = await page.evaluate(() => {
    window._msMonth = '2026-10'; window._msPage = 1; window._attrFilter = 'all';
    renderShortage();
    const host = document.getElementById('page-shortage');
    const txt = host ? host.innerText : '';
    const cards = host ? Array.from(host.querySelectorAll('div')).filter(d => {
      const t = d.innerText || '';
      return /^\s*[A-Z]{1,2}\d?\s*·/.test(t) && d.style.borderLeft;
    }).length : 0;
    const sel = host ? host.querySelector('select[onchange*="_attrFilter"]') : null;
    const opts = sel ? Array.from(sel.options).map(o => o.value) : [];
    const badge = host ? Array.from(host.querySelectorAll('div')).filter(d => /^计划 \d\d-\d\d ↑[\d.]+x$/.test((d.innerText || '').trim())).length : 0;
    return { hasE: /E\s*·\s*📋\s*计划口径变动/.test(txt), hasECard: txt.indexOf('E · 📋 计划口径变动') >= 0,
             opts, badge, cards };
  });
  ck(ui.opts.includes('E'), '归因下拉含 E 选项', JSON.stringify(ui.opts));
  ck(ui.hasECard || ui.cards >= 7, '归因卡片出现第 7 张（E）', 'cards=' + ui.cards);
  ck(ui.hasE, '页面文本出现「E 计划口径变动」');
  ck(ui.badge >= 1, '归因单元格出现「计划 MM-DD ↑N.Nx」小字', 'badge=' + ui.badge);

  console.log('\n【D】降级路径（dp-history.json 不可用时应保持 v452 行为）');
  const deg = await page.evaluate(() => {
    const bak = window._dpHist; window._dpHist = null;
    window._msMonth = '2026-10'; window._msPage = 1; window._attrFilter = 'all';
    renderShortage();
    const a = window._msFocusAttr; const by = {};
    (a ? a.results : []).forEach(x => { by[x.type] = (by[x.type] || 0) + 1; });
    window._dpHist = bak; renderShortage();
    return by;
  });
  console.log('     dp-history 缺失时分布:', JSON.stringify(deg));
  ck(deg.E === undefined && deg.D === 17, '无 dp-history → E 消失、D 回到 17（诚实降级）', JSON.stringify(deg));

  console.log('\n【E】运行时错误');
  ck(errs.length === 0, 'pageErrors = 0', errs.slice(0, 4).join(' | '));

  console.log('\n============================');
  console.log('PASS ' + PASS + ' / FAIL ' + FAIL);
  await browser.close(); server.close();
  process.exit(FAIL ? 1 : 0);
})();
