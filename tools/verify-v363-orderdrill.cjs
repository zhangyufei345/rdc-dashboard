#!/usr/bin/env node
/**
 * v363 运行态探针：「严重度高重点跟进清单」点击 SKU 编码 → 订单明细下钻弹层
 * 验证点：
 *  ① 点击第一行 SKU 编码后弹框 #order-drill-modal-root 出现
 *  ② 弹框表格逐单明细行存在，且带红底行 = 有首日缺货的单
 *  ③ 弹框顶部「订单合计/首日缺货」与清单行「订单量/首日缺货量」完全相等（同口径自证）
 *  ④ 独立复算：在 Node 侧用同一口径（orderDetail + isWorkday + normalizeRdcName + 月份前缀）
 *     从 dataStore 直接聚合，与弹框渲染值比对
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(base)) throw new Error('未找到 ms-playwright 目录：' + base);
  const cands = [];
  for (const d of fs.readdirSync(base)) {
    cands.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    cands.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  const hit = cands.find(p => fs.existsSync(p));
  if (!hit) throw new Error('ms-playwright 下未找到 chromium 可执行文件');
  return hit;
}
function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  const chromium = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core').chromium;
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, { timeout: 240000 });
  await page.waitForFunction(() => window._bootLoading === false, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // 进入缺货分析页（默认 TAB 应为月度画像，含严重度高重点跟进清单）
  await page.evaluate(() => { try { navigateTo('shortage'); window._shortageTab = 'monthly'; renderShortage(); } catch (e) {} });
  await page.waitForTimeout(3500);

  // 诊断：09865 华中 各月 profile 真值
  const diag = await page.evaluate(() => {
    const prof = getMonthlyShortageProfile();
    const out = [];
    Object.keys(prof.byKey).forEach(k => {
      if (k.indexOf('09865|') >= 0) { const q = prof.byKey[k]; out.push(k + ' -> 订单 ' + q.orderQty + ' / 缺货 ' + q.shortQty + ' / 有单天 ' + q.orderDayCnt); }
    });
    return out;
  });
  console.log('DIAG 09865 各月:', JSON.stringify(diag, null, 1));
  console.log('BUILD_VERSION(页面):', await page.evaluate(() => (typeof BUILD_VERSION !== 'undefined') ? BUILD_VERSION : 'n/a').catch(() => 'n/a'));


  const dbg = await page.evaluate(() => {
    const pg = document.getElementById('page-shortage');
    if (!pg) return { noPage: true };
    const tabs = window._shortageTab || '(unset)';
    const tbls = Array.from(pg.querySelectorAll('table')).map((t, i) => ({
      i,
      ths: Array.from(t.querySelectorAll('thead th')).slice(0, 6).map(x => x.textContent.trim()).join('|'),
      rows: t.querySelectorAll('tbody tr').length
    }));
    return { tab: tabs, tblCount: tbls.length, tbls: tbls.slice(0, 12) };
  });
  console.log('DBG:', JSON.stringify(dbg, null, 1));

  // 定位清单第一行的 SKU 编码链接
  const rowInfo = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#page-shortage .card'));
    const tbl = cards.map(c => c.querySelector('.data-table')).find(t => t && t.querySelector('thead th') && Array.from(t.querySelectorAll('thead th')).some(th => th.textContent.indexOf('SKU编码') >= 0 && Array.from(t.querySelectorAll('thead th')).some(th2 => th2.textContent.indexOf('长期标记') >= 0)));
    if (!tbl) return null;
    const firstRow = tbl.querySelector('tbody tr');
    if (!firstRow) return null;
    const tds = Array.from(firstRow.querySelectorAll('td'));
    const link = tds[1] && tds[1].querySelector('span[onclick*="openOrderDrillModal"]');
    if (!link) return { found: false, rowText: tds.map(t => t.textContent.trim()).slice(0, 10) };
    return {
      found: true,
      onclick: link.getAttribute('onclick'),
      sku: tds[1].textContent.trim(),
      orderQty: tds[6] ? tds[6].textContent.trim() : '',
      shortQty: tds[7] ? tds[7].textContent.trim() : ''
    };
  });
  if (!rowInfo) { console.log('❌ 未找到严重度高重点跟进清单表格'); process.exit(1); }
  if (!rowInfo.found) { console.log('❌ 第一行 SKU 编码格无 openOrderDrillModal 点击绑定；行内容:', JSON.stringify(rowInfo.rowText)); process.exit(1); }
  console.log('第一行 SKU:', rowInfo.sku, '| onclick:', rowInfo.onclick);
  console.log('清单行 订单量:', rowInfo.orderQty, '| 首日缺货量:', rowInfo.shortQty);

  // 点击并等待弹框
  await page.evaluate(rowInfo.onclick);
  await page.waitForSelector('#order-drill-modal-root', { timeout: 10000 });
  await page.waitForTimeout(400);

  const modalInfo = await page.evaluate(() => {
    const m = document.getElementById('order-drill-modal-root');
    if (!m) return null;
    const title = m.querySelector('div > div > span').textContent.trim();
    const bodyText = m.textContent;
    const num = (re) => { const x = bodyText.match(re); return x ? parseFloat(x[1].replace(/,/g, '')) : null; };
    const tbl = m.querySelector('table.data-table');
    let rowCount = 0, redRows = 0;
    if (tbl) {
      tbl.querySelectorAll('tbody tr').forEach(tr => { rowCount++; if (tr.getAttribute('style') && tr.getAttribute('style').indexOf('FEF2F2') >= 0) redRows++; });
    }
    return {
      title,
      totalOrder: num(/订单合计\s*([\d,\.]+)\s*支/),
      totalShort: num(/首日缺货\s*([\d,\.]+)\s*支/),
      shortCnt: num(/（([\d,\.]+)\s*单有缺货）/),
      mr: num(/首日缺货率\s*([\d,\.]+)%/),
      rowCount, redRows
    };
  });
  if (!modalInfo) { console.log('❌ 弹框未渲染'); process.exit(1); }
  console.log('弹框标题:', modalInfo.title);
  console.log('弹框合计: 订单', modalInfo.totalOrder, '| 首日缺货', modalInfo.totalShort, '| 缺货单数', modalInfo.shortCnt, '| 缺货率', modalInfo.mr + '%');
  console.log('弹框明细行数:', modalInfo.rowCount, '| 红底(有缺货)行:', modalInfo.redRows);

  // 独立复算：同口径从 dataStore 聚合
  const recheck = await page.evaluate(() => {
    const m = document.getElementById('order-drill-modal-root');
    const titleTxt = m.querySelector('span').textContent;
    const mm = titleTxt.match(/^📋\s*(\S+)\s+.*·\s*(\S+RDC)\s+·\s*(\d{4}-\d{2})/);
    if (!mm) return { err: '标题解析失败: ' + titleTxt };
    const sku = mm[1], rdc = mm[2], period = mm[3];
    let totO = 0, totS = 0, cnt = 0;
    (dataStore.orderDetail || []).forEach(od => {
      if (!od || !od.dateStr || String(od.skuCode || '') !== sku) return;
      if (normalizeRdcName(od.warehouse || '') !== rdc) return;
      if (od.dateStr.slice(0, 7) !== period) return;
      if (!isWorkday(od.dateStr)) return;
      totO += od.orderQty || 0; totS += od.firstDayShort || 0; cnt++;
    });
    return { sku, rdc, period, totO, totS, cnt };
  });
  console.log('独立复算:', JSON.stringify(recheck));

  let pass = true;
  const eq = (a, b, label) => { const ok = a === b; if (!ok) pass = false; console.log((ok ? '✅' : '❌') + ' ' + label + ': 弹框=' + a + ' 清单行=' + b); };
  const eq2 = (a, b, label) => { const ok = a === b; if (!ok) pass = false; console.log((ok ? '✅' : '❌') + ' ' + label + ': 弹框=' + a + ' 复算=' + b); };

  eq(modalInfo.totalOrder, parseFloat(rowInfo.orderQty.replace(/,/g, '')), '订单合计 vs 清单行订单量');
  eq(modalInfo.totalShort, parseFloat(rowInfo.shortQty.replace(/,/g, '')), '首日缺货 vs 清单行首日缺货量');
  if (!recheck.err) {
    eq2(modalInfo.totalOrder, recheck.totO, '订单合计 vs Node复算');
    eq2(modalInfo.totalShort, recheck.totS, '首日缺货 vs Node复算');
    eq2(modalInfo.rowCount, recheck.cnt, '明细行数 vs 复算单数');
    if (modalInfo.redRows !== modalInfo.shortCnt) { pass = false; console.log('❌ 红底行数(' + modalInfo.redRows + ') ≠ 缺货单数(' + modalInfo.shortCnt + ')'); }
    else console.log('✅ 红底行数 = 缺货单数 = ' + modalInfo.shortCnt);
  } else { pass = false; console.log('❌ ' + recheck.err); }

  // 关闭弹框验证
  await page.evaluate(() => closeOrderDrillModal());
  const gone = await page.evaluate(() => !document.getElementById('order-drill-modal-root'));
  console.log(gone ? '✅ 关闭弹框正常' : '❌ 关闭后弹框仍存在');
  if (!gone) pass = false;


  // 用例2：用户截图行 09865（0 开头 SKU）——直接调弹框并对账
  await page.evaluate(() => openOrderDrillModal('09865', '华北RDC', '2026-09'));
  await page.waitForSelector('#order-drill-modal-root', { timeout: 10000 });
  await page.waitForTimeout(300);
  const m2 = await page.evaluate(() => {
    const m = document.getElementById('order-drill-modal-root');
    const t = m.textContent;
    const num = (re) => { const x = t.match(re); return x ? parseFloat(x[1].replace(/,/g, '')) : null; };
    return { title: m.querySelector('span').textContent.trim(), totalOrder: num(/订单合计\s*([\d,\.]+)\s*支/), totalShort: num(/首日缺货\s*([\d,\.]+)\s*支/) };
  });
  console.log('用例2(09865):', JSON.stringify(m2));
  const ok2 = m2.totalOrder === 22680 && m2.totalShort === 9036;
  if (!ok2) pass = false;
  console.log(ok2 ? '✅ 09865 订单=22,680 / 首日缺货=9,036 与截图行一致' : '❌ 09865 对账失败（期望 22,680 / 9,036）');
  await page.evaluate(() => closeOrderDrillModal());

  console.log('页面运行时错误:', errs.length === 0 ? '0' : errs.join(' ; '));
  if (errs.length > 0) pass = false;
  console.log(pass ? '=== v363 探针全部通过 ===' : '=== v363 探针存在失败项 ===');

  await browser.close();
  server.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
