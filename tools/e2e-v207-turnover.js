/**
 * e2e-v207-turnover.js — 本地静态服务验证 v207 库存周转 8月数据
 * 走本地文件（同部署内容），规避 pages.dev 的 Cloudflare QUIC 超时，真实跑浏览器/IDB/渲染。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = process.cwd();
const PORT = 8971;
const MIME = { '.html':'text/html; charset=utf-8', '.json':'application/json; charset=utf-8' };

const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fs.existsSync(fp)) { s.writeHead(404); s.end(); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(fp).pipe(s);
});

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log('Local static server on :' + PORT);
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth','true'); } catch(e){} });
  p.on('pageerror', e => console.log('  [PAGEERR]', e.message.slice(0,200)));

  const t0 = Date.now();
  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  const initVer = await p.evaluate(() => typeof DB_VERSION !== 'undefined' ? DB_VERSION : '?');
  console.log('① 初始 DB_VERSION:', initVer);

  let bootOk = false;
  for (let i=0;i<200;i++){
    bootOk = await p.evaluate(() => !!(typeof dataStore !== 'undefined' && dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(()=>false);
    if (bootOk) break;
    if (i % 10 === 9){ const s = await p.evaluate(()=>({cov7:(dataStore?.inventory?.cov7||[]).length,ord:dataStore?.orderDetail?.length||0,loaded:!!dataStore?.loaded,boot:!!window._bootLoading})).catch(()=>({})); console.log('  ['+((Date.now()-t0)/1000).toFixed(0)+'s] cov7='+s.cov7+' ord='+s.ord+' loaded='+s.loaded+' boot='+s.boot); }
    await sleep(3000);
  }
  console.log('② Boot:', bootOk ? '✅' : '❌ 超时', '( '+((Date.now()-t0)/1000).toFixed(0)+'s )');

  // 核心断言：库存周转 8月
  const turn = await p.evaluate(() => {
    const t = dataStore.inventoryTurnover;
    if (!t) return { ok:false, reason:'inventoryTurnover 为空' };
    return {
      ok: true,
      months: t.months,
      monthCount: (t.months||[]).length,
      hzDays: t.allLocation && t.allLocation['华中RDC'],
      hzCost: t.shipmentCost && (t.shipmentCost['华中RDC'] || t.shipmentCost['华中']),
      hqDays: t.headquarters,
      hqCost: t.shipmentCost && t.shipmentCost['总仓']
    };
  });
  console.log('\n③ dataStore.inventoryTurnover:');
  console.log('   months:', JSON.stringify(turn.months));
  console.log('   monthCount:', turn.monthCount);
  console.log('   华中RDC 周转天数:', JSON.stringify(turn.hzDays), '→ 8月=', turn.hzDays && turn.hzDays[turn.hzDays.length-1]);
  console.log('   华中 出货成本:', JSON.stringify(turn.hzCost), '→ 8月=', turn.hzCost && turn.hzCost[turn.hzCost.length-1]);
  console.log('   总仓 周转天数:', JSON.stringify(turn.hqDays), '→ 8月=', turn.hqDays && turn.hqDays[turn.hqDays.length-1]);
  console.log('   总仓 出货成本:', JSON.stringify(turn.hqCost), '→ 8月=', turn.hqCost && turn.hqCost[turn.hqCost.length-1]);

  // 渲染层：进入库存周转页，确认页面显示 8月
  await p.evaluate(() => navigateTo('inventory'));
  await sleep(4000);
  const render = await p.evaluate(() => {
    const el = document.getElementById('page-inventory');
    const t = el ? el.textContent.replace(/\s+/g,' ') : '';
    return { has8: t.indexOf('8月') >= 0, has7: t.indexOf('7月') >= 0, hasEmpty: t.indexOf('暂无数据') >= 0, len: t.length, preview: t.slice(0, 220) };
  });
  console.log('\n④ 库存周转页面渲染:');
  console.log('   显示「8月」:', render.has8 ? '✅' : '❌', '| 显示「7月」:', render.has7, '| 空:', render.hasEmpty, '| len=', render.len);

  // P1 分仓计划监控（取新分仓计划表 + 取消 SKU 过滤）
  await p.evaluate(() => navigateTo('plan-monitor'));
  await sleep(5000);
  const p1 = await p.evaluate(() => { const el=document.getElementById('page-plan-monitor'); const t=el?el.textContent.replace(/\s+/g,' '):''; return { hasData: t.indexOf('暂无数据')<0 && t.length>500, len:t.length, preview:t.slice(0,200) }; });
  console.log('\n[P1] 分仓计划监控:', p1.hasData?'✅ 有数据':'❌ 空', '(len='+p1.len+')');

  // P2 库存结构分析（分仓计划不动，仍用 7月覆盖）
  await p.evaluate(() => navigateTo('inventory-structure'));
  await sleep(3000);
  const p2 = await p.evaluate(() => { const el=document.getElementById('page-inventory-structure'); const t=el?el.textContent.replace(/\s+/g,' '):''; return { hasData: t.indexOf('未找到')<0 && t.indexOf('请确认已包含')<0 && t.length>300, len:t.length }; });
  console.log('[P2] 库存结构分析:', p2.hasData?'✅ 有数据':'❌ 空', '(len='+p2.len+')');

  // 判定
  const ok = bootOk && turn.monthCount===8 && turn.hzDays && turn.hzDays.length===8 && turn.hzCost && turn.hzCost.length===8 && render.has8 && p1.hasData && p2.hasData;
  console.log('\n═══════ 结论:', ok ? '✅ v207 全部通过' : '❌ 存在失败项', '═══════');
  await b.close();
  server.close();
  process.exit(ok ? 0 : 1);
})();
