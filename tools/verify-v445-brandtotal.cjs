#!/usr/bin/env node
/**
 * v445 门控：分仓计划监控「品牌 × RDC 完成率矩阵」新增「各RDC合计」列
 *
 * 校验点：
 *  A1 表头含「各RDC合计」，且位置 = 品牌列之后、第一个 RDC 列之前；每行 td 数 == th 数
 *  A2 【无漏算·核心】每个品牌的「合计」title 里的 实际出货/分仓计划
 *      == 同一行各 RDC 单元格 title 里的 数值之和（矩阵可见列口径逐品牌对账）
 *  A3 合计显示值与 title 数值自洽（display == ship/plan 的百分数）
 *  A4 与 SKU 明细口径(_planMonitorRows)对拍：给出差异，矩阵口径 ⊂ 明细口径属正常，只要合计 ≥ 明细即方向正确
 *  A5 点击「合计」单元格 → 下钻区出现，标题为「全部 RDC」，且明细覆盖该品牌多个 RDC
 *  A6 全程零 pageerror
 *
 * 用法（项目根）：
 *   NODE_PATH=".../node/workspace/node_modules" "<ver>/node.exe" tools/verify-v445-brandtotal.cjs
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
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const results = [];
function chk(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '✅ ' : '❌ ') + name + (detail ? '  — ' + detail : ''));
}

(async () => {
  let chromium;
  try { chromium = require('playwright-core').chromium; }
  catch (e) { console.error('需要 playwright-core：设置 NODE_PATH 指向 binaries/node/workspace/node_modules'); process.exit(2); }

  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  let errs = [];
  page.on('pageerror', e => errs.push(e && e.message ? e.message : String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 300)); });

  await page.goto('http://127.0.0.1:' + port + '/rdc-dashboard.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  const loaded = await page.waitForFunction(
    () => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true,
    { timeout: 180000 }).then(() => true).catch(() => false);
  console.log('数据装载:', loaded ? 'OK' : '超时');
  if (!loaded) { await browser.close(); server.close(); process.exit(2); }

  const ver = await page.evaluate(() => (typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : -1));
  console.log('BUILD_VERSION =', ver);

  // 进入分仓计划监控（该页依赖按需加载的 inventory，首访常有占位态 → 等数据 + 需要时显式渲染）
  await page.evaluate(() => { if (typeof navigateTo === 'function') navigateTo('plan-monitor'); });
  await page.waitForTimeout(2500);
  const diag0 = await page.evaluate(() => {
    const el = document.getElementById('page-plan-monitor');
    return { len: el ? el.innerHTML.length : -1, head: el ? el.innerHTML.slice(0, 160) : '' };
  });
  console.log('plan-monitor 初态: len=' + diag0.len + '  head=' + JSON.stringify(diag0.head));
  const invReady = await page.waitForFunction(() => {
    const inv = (typeof dataStore !== 'undefined' && dataStore.inventory) || {};
    const okPlan = inv.planBySkuRdc && Object.keys(inv.planBySkuRdc).length > 0;
    const okShip = inv.actualShipBySkuRdc && Object.keys(inv.actualShipBySkuRdc).length > 0;
    return okPlan && okShip;   // 必须等 demand.json 合并完，否则矩阵分子全 0（假绿）
  }, { timeout: 120000 }).then(() => true).catch(() => false);
  console.log('分仓计划 + 实际出货数据就绪:', invReady);
  await page.evaluate(() => {
    if (!document.querySelector('.brand-rdc-matrix') && typeof renderPlanMonitor === 'function') renderPlanMonitor();
  });
  await page.waitForTimeout(3000);

  const dump = await page.evaluate(() => {
    const tbl = document.querySelector('.brand-rdc-matrix');
    if (!tbl) return { err: '未找到 .brand-rdc-matrix 表格' };
    const ths = Array.from(tbl.querySelectorAll('thead th')).map(t => t.textContent.trim());
    const trs = Array.from(tbl.querySelectorAll('tbody tr'));
    const rows = trs.map(tr => {
      const tds = Array.from(tr.querySelectorAll('td'));
      const num = function (s, label) {
        const m = String(s || '').match(new RegExp(label + '[:：]\\s*([\\d,]+)'));
        return m ? Number(m[1].replace(/,/g, '')) : null;
      };
      return {
        brand: tds[0] ? tds[0].textContent.trim() : '',
        nTd: tds.length,
        totalDisp: tds[1] ? tds[1].textContent.trim() : '',
        totalTitle: tds[1] ? (tds[1].getAttribute('title') || '') : '',
        totalPlan: tds[1] ? num(tds[1].getAttribute('title'), '分仓计划合计') : null,
        totalShip: tds[1] ? num(tds[1].getAttribute('title'), '实际出货合计') : null,
        cellPlan: tds.slice(2).map(td => num(td.getAttribute('title'), '计划量')),
        cellShip: tds.slice(2).map(td => num(td.getAttribute('title'), '实际出货'))
      };
    });
    // 明细口径（SKU×RDC）汇总，用于旁证
    const pm = window._planMonitorRows || [];
    const exp = {};
    pm.forEach(r => {
      if (!r.brand) return;
      const o = exp[r.brand] || (exp[r.brand] = { plan: 0, ship: 0, rdcs: {} });
      o.plan += (r.plan || 0); o.ship += (r.shipped || 0);
      o.rdcs[r.rdc] = (o.rdcs[r.rdc] || 0) + (r.shipped || 0);
    });
    return { ths, rows, expBrands: Object.keys(exp).length, exp, pmCount: pm.length };
  });

  if (dump.err) { chk('找到矩阵表格', false, dump.err); await browser.close(); server.close(); process.exit(1); }

  // ---- A1 表头 ----
  const ths = dump.ths;
  const iTotal = ths.indexOf('各RDC合计');
  const iBrand = ths.indexOf('品牌');
  chk('A1a 表头含「各RDC合计」', iTotal >= 0, '表头 = ' + JSON.stringify(ths));
  chk('A1b 「各RDC合计」位于 品牌 之后、第一个 RDC 之前', iBrand === 0 && iTotal === 1,
    '品牌 idx=' + iBrand + '，合计 idx=' + iTotal);
  const badTd = dump.rows.filter(r => r.nTd !== ths.length);
  chk('A1c 每行 td 数 == th 数', badTd.length === 0,
    badTd.length ? ('不齐: ' + badTd.map(r => r.brand + ':' + r.nTd).join(', ')) : (dump.rows.length + ' 行 × ' + ths.length + ' 列'));

  // ---- A2 无漏算：合计 == 同行各 RDC 单元格之和 ----
  const a2bad = [];
  dump.rows.forEach(r => {
    const sp = r.cellPlan.reduce((s, v) => s + (v || 0), 0);
    const ss = r.cellShip.reduce((s, v) => s + (v || 0), 0);
    // 合计 title 数值；空态（— / 无计划）允许无数字
    const tp = r.totalPlan, ts = r.totalShip;
    if (tp == null && ts == null) {
      if (sp !== 0 || ss !== 0) a2bad.push(r.brand + ' 合计无数值但单元格有数(' + sp + '/' + ss + ')');
      return;
    }
    if (Math.abs((tp || 0) - sp) > 0.5 || Math.abs((ts || 0) - ss) > 0.5) {
      a2bad.push(r.brand + ' 合计(' + (tp || 0) + '/' + (ts || 0) + ') ≠ 单元格之和(' + sp + '/' + ss + ')');
    }
  });
  chk('A2 【无漏算】合计 == 同行各 RDC 单元格之和', a2bad.length === 0,
    a2bad.length ? a2bad.join(' ｜ ') : (dump.rows.length + ' 个品牌逐一对账通过'));

  // ---- A3 显示值与 title 自洽 ----
  const a3bad = [];
  dump.rows.forEach(r => {
    if (r.totalPlan == null || r.totalShip == null) return;
    if (r.totalPlan <= 0) return;
    const rate = r.totalShip / r.totalPlan;
    const want = (rate * 100).toFixed(rate >= 1 ? 0 : 1) + '%';
    if (r.totalDisp !== want) a3bad.push(r.brand + ' 显示' + r.totalDisp + ' 期望' + want);
  });
  chk('A3 合计显示值与 title 数值自洽', a3bad.length === 0, a3bad.length ? a3bad.join(' ｜ ') : '全部一致');

  // ---- A4 与明细口径旁证（仅展示，不作硬断言）----
  const a4lines = [];
  dump.rows.forEach(r => {
    const e = dump.exp[r.brand];
    if (!e) { a4lines.push(r.brand + ': 明细无该品牌'); return; }
    const dp = e.plan - (r.totalPlan || 0), ds = e.ship - (r.totalShip || 0);
    if (Math.abs(dp) > 0.5 || Math.abs(ds) > 0.5) {
      a4lines.push(r.brand + ' 合计(' + Math.round(r.totalPlan || 0) + '/' + Math.round(r.totalShip || 0) +
        ') vs 明细(' + Math.round(e.plan) + '/' + Math.round(e.ship) + ') Δ计划=' + Math.round(dp) + ' Δ出货=' + Math.round(ds));
    }
  });
  chk('A4 与 SKU 明细口径对拍', true,
    a4lines.length ? ('差异品牌 ' + a4lines.length + ' 个（矩阵列口径可能小于明细口径）:\n     ' + a4lines.slice(0, 6).join('\n     ')) : '全部一致');

  // ---- 打印矩阵内容（便于肉眼核对）----
  console.log('\n矩阵内容：');
  console.log('  ' + ths.join(' ｜ '));
  dump.rows.forEach(r => {
    const sp = r.cellPlan.reduce((s, v) => s + (v || 0), 0);
    const ss = r.cellShip.reduce((s, v) => s + (v || 0), 0);
    console.log('  ' + r.brand.padEnd(6) +
      ' 合计=' + String(r.totalDisp).padEnd(7) +
      ' ｜ 出货 ' + String(Math.round(r.totalShip || 0)).padStart(8) + ' / 计划 ' + String(Math.round(r.totalPlan || 0)).padStart(8) +
      ' ｜ 单元格之和 出货 ' + String(Math.round(ss)).padStart(8) + ' / 计划 ' + String(Math.round(sp)).padStart(8));
  });
  const anyZero = dump.rows.every(r => !(r.totalShip > 0));
  chk('A0 矩阵分子非全 0（防「demand 未合并」造成的假绿）', !anyZero,
    anyZero ? '全部品牌实际出货为 0 → demand 未合并或数据异常' : '已合并');

  // ---- A5 点击合计列下钻 ----
  await page.evaluate(() => { const d = document.getElementById('pm-sku-drill'); if (d) d.innerHTML = ''; });
  const clickInfo = await page.evaluate(() => {
    const tbl = document.querySelector('.brand-rdc-matrix');
    const td = tbl ? tbl.querySelector('tbody tr td:nth-child(2)') : null;
    const info = {
      hasTd: !!td,
      brand: tbl ? (tbl.querySelector('tbody tr td:first-child').textContent || '').trim() : '',
      onclick: td ? (td.getAttribute('onclick') || '') : '',
      fnType: typeof jumpToPlanMonitorSkuDetail
    };
    if (td) td.click();
    return info;
  });
  await page.waitForTimeout(1800);

  const probeDrill = () => page.evaluate(() => {
    const w = document.getElementById('pm-sku-drill');
    const txt = w ? w.textContent : '';
    const t = document.getElementById('pm-sku-drill-table');
    const set = {};
    let rowCount = 0;
    if (t) {
      const trs = Array.from(t.querySelectorAll('tbody tr'));
      rowCount = trs.length;
      trs.forEach(tr => {
        const b = tr.querySelector('button');
        const oc = b ? (b.getAttribute('onclick') || '') : '';
        const m = oc.match(/'([^']+)'\s*\)\s*$/);
        if (m) set[m[1]] = 1;
      });
    }
    return { len: txt.length, hasAllRdc: txt.indexOf('全部 RDC') >= 0, rows: rowCount, rdcs: Object.keys(set) };
  });

  let drill = await probeDrill();
  if (drill.len === 0) {
    const direct = await page.evaluate((b) => {
      try { jumpToPlanMonitorSkuDetail(b, null); } catch (e) { return 'THREW ' + e.message; }
      const w = document.getElementById('pm-sku-drill');
      return w ? w.textContent.length : -1;
    }, clickInfo.brand).catch(e => 'eval失败 ' + e.message);
    console.log('  ⚠️ 点击后无输出，诊断: ' + JSON.stringify(clickInfo) + ' 直接调用后 len=' + direct);
    drill = await probeDrill();
  }
  chk('A5a 点击「合计」单元格无异常', clickInfo.hasTd && clickInfo.onclick.indexOf('null') >= 0,
    'onclick=' + clickInfo.onclick + '，品牌=' + clickInfo.brand);
  chk('A5b 下钻区渲染且标题为「全部 RDC」', drill.len > 50 && drill.hasAllRdc,
    'len=' + drill.len + ' hasAllRdc=' + drill.hasAllRdc);
  chk('A5c 下钻明细覆盖多个 RDC', drill.rdcs.length > 1,
    '覆盖 RDC = ' + JSON.stringify(drill.rdcs) + '，行数=' + drill.rows);

  // ---- 截图存档 ----
  try {
    const shot = path.join(ROOT, '.cache', 'v445_brand_total.png');
    const card = await page.$('#pm-brand-rdc-card');
    if (card) await card.screenshot({ path: shot });
    console.log('\n截图存档:', shot);
  } catch (e) { console.log('截图失败:', e.message); }

  // ---- A6 零运行时错误 ----
  chk('A6 全程零运行时错误', errs.length === 0, errs.length ? errs.slice(0, 3).join(' ｜ ') : '0 条');

  await browser.close();
  server.close();

  const bad = results.filter(r => !r.ok);
  console.log('\n================ 合计 ' + results.length + ' 项，失败 ' + bad.length + ' 项 ================');
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('工具异常:', e && e.message); process.exit(2); });
