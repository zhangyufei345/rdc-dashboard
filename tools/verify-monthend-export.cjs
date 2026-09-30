#!/usr/bin/env node
// v388 导出 CSV 真实验证：真实点击「导出CSV」按钮 → 捕获下载 → 解析校验内容
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const c = [];
  for (const d of fs.readdirSync(base)) {
    c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    c.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  return c.find(p => fs.existsSync(p));
}
const R = { pass: 0, fail: 0 };
function chk(n, c, d) { c ? R.pass++ : R.fail++; console.log((c ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); }

(async () => {
  const { chromium } = require('playwright-core');
  const b = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const url = (process.env.RDC_BASE || 'https://rdc-dashboard.pages.dev') + '/rdc-dashboard.html';
  console.log('目标:', url);
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.fill('#login-user', 'admin').catch(() => {});
  await p.fill('#login-pass', 'admin123').catch(() => {});
  await p.click('#login-page button').catch(() => {});
  await p.waitForFunction(() => window._bootLoading === false && typeof dataStore !== 'undefined' && dataStore.loaded === true, { timeout: 240000 });

  await p.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('shortage'); });
  await p.waitForTimeout(1000);
  await p.evaluate(() => {
    const t = [...document.querySelectorAll('#page-shortage button')].find(x => (x.textContent || '').indexOf('月底压货商品分析') >= 0);
    if (t) t.click();
  });
  await p.waitForTimeout(3000);

  // A 象限导出
  await p.evaluate(() => { window._meQuad = 'A'; window._mePage = 1; renderShortage(); });
  await p.waitForTimeout(1500);

  const dl = p.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  await p.evaluate(() => {
    const btn = [...document.querySelectorAll('#page-shortage button')].find(x => (x.textContent || '').indexOf('导出CSV') >= 0);
    if (btn) btn.click();
  });
  const d = await dl;
  chk('点击「导出CSV」触发下载', !!d, d ? d.suggestedFilename() : 'no download');

  if (d) {
    const out = path.join(ROOT, 'tools', '_out', '_me_export_A.csv');
    await d.saveAs(out);
    const buf = fs.readFileSync(out);
    const txt = buf.toString('utf8');
    chk('CSV 带 UTF-8 BOM', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF);
    const lines = txt.replace(/^\uFEFF/, '').trim().split('\n');
    chk('CSV 行数 >= 2（表头 + 数据）', lines.length >= 2, 'lines=' + lines.length);
    const head = lines[0];
    chk('表头含「象限」「压货达标率」「缺货率」「归因」',
      ['象限', '压货达标率', '缺货率', '归因'].every(k => head.indexOf(k) >= 0), head.slice(0, 120));
    // 🔴 与页面同源对拍：导出条数必须 == 页面 A 象限条数
    const nA = await p.evaluate(() => (getMonthendProfile().rows || []).filter(r => r.quad === 'A').length);
    chk('导出数据行数 == 页面 A 象限条数', lines.length - 1 === nA, `csv=${lines.length - 1} page=${nA}`);
    chk('数据行均为 A 象限', lines.slice(1).every(l => l.split(',')[3] === 'A'));
    // 归因列非空（A 象限必有归因）
    const attrCol = lines.slice(1).map(l => l.split(',')[15]);
    chk('每行「归因」列非空', attrCol.every(v => v && v.trim().length > 0), attrCol.slice(0, 2).join(' | '));
    console.log('\n  首行样例:', lines[1].slice(0, 160));
  }

  // 切到「全部」再导一次，验证筛选联动
  await p.evaluate(() => { window._meQuad = 'all'; window._mePage = 1; renderShortage(); });
  await p.waitForTimeout(1500);
  const dl2 = p.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  await p.evaluate(() => {
    const btn = [...document.querySelectorAll('#page-shortage button')].find(x => (x.textContent || '').indexOf('导出CSV') >= 0);
    if (btn) btn.click();
  });
  const d2 = await dl2;
  if (d2) {
    const out2 = path.join(ROOT, 'tools', '_out', '_me_export_all.csv');
    await d2.saveAs(out2);
    const l2 = fs.readFileSync(out2, 'utf8').replace(/^\uFEFF/, '').trim().split('\n');
    const nAll = await p.evaluate(() => (getMonthendProfile().rows || []).length);
    chk('「全部」导出条数 == 清单总条数', l2.length - 1 === nAll, `csv=${l2.length - 1} page=${nAll}`);
    chk('「全部」导出文件名含「全部」', d2.suggestedFilename().indexOf('全部') >= 0, d2.suggestedFilename());
  } else chk('「全部」导出触发下载', false);

  await b.close();
  console.log('\n合计 ' + (R.pass + R.fail) + ' 项，通过 ' + R.pass + '，失败 ' + R.fail);
  process.exit(R.fail ? 1 : 0);
})();
