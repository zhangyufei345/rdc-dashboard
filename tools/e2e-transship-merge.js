/**
 * e2e-transship-merge.js — 验证转储数据 1-8月 合并（等待真实数据长度，而非仅 _invExtraReady）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = process.cwd();
const PORT = 8975;
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
  p.on('console', m => { if (m.text().indexOf('ensure')>=0) console.log('  [console]', m.text().slice(0,160)); });

  const t0 = Date.now();
  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  for (let i=0;i<200;i++){
    const ok = await p.evaluate(() => !!(typeof dataStore!=='undefined' && dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length>100)).catch(()=>false);
    if (ok) break;
    await sleep(3000);
  }
  console.log('① Boot:', ((Date.now()-t0)/1000).toFixed(0)+'s');

  // 进转储页（首次）
  await p.evaluate(() => navigateTo('transship'));
  // 等待真实合并完成：dataStore.transship.length >= 23000
  let merged=false;
  for (let i=0;i<80;i++){
    const len = await p.evaluate(() => (typeof dataStore!=='undefined' && dataStore.transship) ? dataStore.transship.length : 0).catch(()=>0);
    if (len >= 23000) { merged=true; break; }
    await sleep(2000);
  }
  const lenFinal = await p.evaluate(() => dataStore.transship.length).catch(()=>0);
  console.log('② 转储合并:', merged?'✅ 已合并1-8月':'❌ 仅1-6月', '| dataStore.transship.length=', lenFinal);

  // 读取渲染文本（合并完成后）
  await sleep(1500);
  const trans = await p.evaluate(() => {
    const el = document.getElementById('page-transship');
    const t = el ? el.textContent.replace(/\s+/g,' ') : '';
    return { has8: t.indexOf('2026-08')>=0 || t.indexOf('8月')>=0, txt: t.slice(0,220) };
  });
  console.log('   渲染文本片段:', trans.txt);
  console.log('   含8月显示:', trans.has8?'✅':'❌');

  const ok = merged && lenFinal >= 23000 && trans.has8;
  console.log('\n═══════ 转储结论:', ok?'✅ 1-8月合并正常':'❌ 仍有问题', '═══════');

  // 回归：拉回分析 tab（同源 inventory-extra.json，本次改动不应影响）
  await p.evaluate(() => { window._transTab='pullback'; renderTransship(); });
  await sleep(6000);
  const pull = await p.evaluate(() => {
    const el = document.getElementById('page-transship');
    const t = el ? el.textContent.replace(/\s+/g,' ') : '';
    const raw = (typeof dataStore!=='undefined' && dataStore.inventory && dataStore.inventory.pullbackRaw) ? dataStore.inventory.pullbackRaw.length : 0;
    return { hasData: t.indexOf('总拉回')>=0 && t.length>300, rawLen: raw, preview: t.slice(0,160) };
  });
  console.log('\n[拉回分析 tab 回归]');
  console.log('   渲染有数据:', pull.hasData?'✅':'❌', '| pullbackRaw行=', pull.rawLen);
  console.log('   preview:', pull.preview);
  const ok2 = pull.hasData && pull.rawLen > 1000;
  console.log('═══════ 拉回结论:', ok2?'✅ 正常（含8月拉回）':'❌ 异常', '═══════');

  await b.close(); server.close(); process.exit(ok && ok2 ?0:1);
})();
