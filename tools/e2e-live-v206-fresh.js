/**
 * e2e-live-v206-fresh.js — 全新浏览器无缓存验证 v206
 * 
 * 场景：模拟用户第一次打开（或硬刷新后）v206，
 * 确认 DB_VERSION=206 触发 clearIDB → 全量重拉 → cov7/库存结构/分仓监控全部正常。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = process.cwd();
const PORT = 8960;
const MIME = { '.html':'text/html; charset=utf-8', '.json':'application/json; charset=utf-8' };

// 本地静态服务（用本地文件，不走 CDN）
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fs.existsSync(fp)) { s.writeHead(404); s.end(); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(fp).pipe(s);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log('Local static server on :' + PORT);

  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  // 模拟已登录用户（全新浏览器 = 无 IDB 缓存，但有登录态）
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch(e) {} });

  const logs = [];
  p.on('console', m => {
    const t = m.text().slice(0, 200);
    if (t.indexOf('[bootLoad]') >= 0 || t.indexOf('[loadFromIDB]') >= 0 || 
        t.indexOf('[refreshFromManifest]') >= 0 || t.indexOf('clearIDB') >= 0 ||
        t.indexOf('DB_VERSION') >= 0 || t.indexOf('cov7') >= 0 ||
        t.indexOf('ERR') >= 0 || t.indexOf('error') >= 0) {
      logs.push(t);
      console.log('  [LOG]', t);
    }
  });
  p.on('pageerror', e => { logs.push('[PAGE]' + e.message.slice(0,200)); console.log('  [PAGEERR]', e.message.slice(0,200)); });

  // CDN 路由
  const cdn = path.join(__dirname === '' ? 'tools' : __dirname, '..', '.cdn-cache');
  await p.route('**/echarts.min.js', r => r.fulfill({ status:200, contentType:'application/javascript', body:fs.readFileSync(path.join(ROOT,'tools/.cdn-cache/echarts.min.js')) }).catch(()=>{}));
  await p.route('**/xlsx.full.min.js', r => r.fulfill({ status:200, contentType:'application/javascript', body:fs.readFileSync(path.join(ROOT,'tools/.cdn-cache/xlsx.full.min.js')) }).catch(()=>{}));

  const t0 = Date.now();
  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });

  // 检查初始 DB_VERSION
  const initVer = await p.evaluate(() => typeof DB_VERSION !== 'undefined' ? DB_VERSION : '?');
  console.log('\n① 初始 DB_VERSION:', initVer);

  // 等待 boot 完成（cov7 > 100）
  let bootOk = false;
  for (let i = 0; i < 180; i++) { // 最多等 9 分钟
    bootOk = await p.evaluate(() => !!(window.dataStore && dataStore.loaded && 
      dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(() => false);
    if (bootOk) break;
    if (i % 10 === 9) {
      const snap = await p.evaluate(() => ({
        loaded: !!window.dataStore?.loaded,
        cov7: (window.dataStore?.inventory?.cov7 || []).length,
        ord: window.dataStore?.orderDetail?.length || 0,
        booting: !!window._bootLoading,
        ver: typeof DB_VERSION !== 'undefined' ? DB_VERSION : '?'
      })).catch(() => ({}));
      console.log('  [' + ((Date.now()-t0)/1000).toFixed(0) + 's] cov7=' + snap.cov7 + ' ord=' + snap.ord + ' loaded=' + snap.loaded + ' boot=' + snap.booting);
    }
    await sleep(3000);
  }
  const bootMs = Date.now() - t0;
  console.log('\n② Boot 结果:', bootOk ? '✅ 成功' : '❌ 超时', '(' + (bootMs/1000).toFixed(0) + 's)');

  // 收集关键状态
  const st = await p.evaluate(() => ({
    dbVer: typeof DB_VERSION !== 'undefined' ? DB_VERSION : '?',
    cov7: (dataStore.inventory?.cov7 || []).length,
    ord: dataStore.orderDetail?.length || 0,
    struct: !!(dataStore.inventory?.structureByYear?.['2026']),
    planSkus: Object.keys(dataStore.inventory?.planBySkuRdc || {}).length,
    turn: !!(dataStore.inventoryTurnover),
    errors: document.querySelectorAll('.page-error,.error-msg').length,
    title: document.title,
    idbCleared: logs.some(l => l.indexOf('clearIDB') >= 0 || l.indexOf('清空') >= 0),
    verChange: logs.some(l => l.indexOf('DB_VERSION 变更') >= 0 || l.indexOf('版本不一致') >= 0)
  })).catch(e => ({ err: e.message.slice(0,200) }));

  console.log('\n③ 终态:');
  console.log('   DB_VERSION:', st.dbVer);
  console.log('   cov7 行数:', st.cov7);
  console.log('   orderDetail:', st.ord);
  console.log('   structureByYear[2026]:', st.struct);
  console.log('   planBySkuRdc SKU数:', st.planSkus);
  console.log('   inventoryTurnover:', st.turn);
  console.log('   页面错误元素:', st.errors);
  console.log('   title:', st.title);
  console.log('   触发了 clearIDB:', st.idbCleared);
  console.log('   版本变更检测:', st.verChange);

  // P1: 分仓计划监控页
  await p.evaluate(() => navigateTo('plan-monitor'));
  await sleep(5000);
  const p1 = await p.evaluate(() => {
    const el = document.getElementById('page-plan-monitor');
    const t = el ? el.textContent.replace(/\s+/g, ' ') : '';
    return {
      hasData: t.indexOf('暂无数据') < 0 && t.length > 500,
      len: t.length,
      hasEmpty: t.indexOf('暂无数据') >= 0,
      cov7Show: t.indexOf('cov7=0') >= 0,
      preview: t.slice(0, 300)
    };
  });
  console.log('\n[P1] 分仓计划监控:', p1.hasData ? '✅ 有数据' : '❌ 空', '(len=' + p1.len + ', cov7=0显示=' + p1.cov7Show + ')');

  // P2: 库存结构分析
  await p.evaluate(() => navigateTo('inventory-structure'));
  await sleep(3000);
  const p2 = await p.evaluate(() => {
    const el = document.getElementById('page-inventory-structure');
    const t = el ? el.textContent.replace(/\s+/g, ' ') : '';
    return {
      hasData: t.indexOf('未找到') < 0 && t.indexOf('请确认已包含') < 0 && t.length > 300,
      len: t.length,
      preview: t.slice(0, 250)
    };
  });
  console.log('[P2] 库存结构分析:', p2.hasData ? '✅ 有数据' : '❌ 空', '(len=' + p2.len + ')');

  // P3: 转储数据
  await p.evaluate(() => navigateTo('transship'));
  await sleep(6000);
  const p3 = await p.evaluate(() => {
    const el = document.getElementById('page-transship');
    const t = el ? el.textContent.replace(/\s+/g, ' ') : '';
    const rows = t.match(/条记录/);
    const rowNum = rows ? rows[0].match(/\d+/)[0] : '0';
    return { len: t.length, rowNum, has202608: t.indexOf('2026-08') >= 0 || t.indexOf('8月') >= 0 };
  });
  console.log('[P3] 转储数据:', p3.rowNum, '条, 含8月:', p3.has202608 ? '✅' : '❌');

  // P4: 库存周转
  await p.evaluate(() => navigateTo('inventory-turnover'));
  await sleep(3000);
  const p4 = await p.evaluate(() => {
    const el = document.getElementById('page-inventory-turnover');
    const t = el ? el.textContent.replace(/\s+/g, ' ') : '';
    return { hasData: t.length > 200, len: t.length, preview: t.slice(0, 200) };
  });
  console.log('[P4] 库存周转:', p4.hasData ? '✅' : '❌', '(len=' + p4.len + ')');

  // 总结
  const allPass = bootOk && p1.hasData && p2.hasData && parseInt(p3.rowNum) > 20000 && p4.hasData;
  console.log('\n═════════════════════════════════');
  console.log(allPass ? '✅ 全部通过' : '❌ 有失败项');
  console.log('═════════════════════════════════');

  await b.close();
  server.close();
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
