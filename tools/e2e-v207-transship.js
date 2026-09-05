/**
 * e2e-v207-transship.js — 本地静态服务验证 转储数据 + 拉回分析（含8月）渲染
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = process.cwd();
const PORT = 8972;
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
  for (let i=0;i<200;i++){
    const ok = await p.evaluate(() => !!(typeof dataStore!=='undefined' && dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length>100)).catch(()=>false);
    if (ok) break;
    await sleep(3000);
  }
  console.log('① Boot:', ((Date.now()-t0)/1000).toFixed(0)+'s');

  // 进入转储/拉回页
  await p.evaluate(() => navigateTo('transship'));
  // 等待两个按需加载器
  let ready=false;
  for (let i=0;i<60;i++){
    ready = await p.evaluate(() => !!(typeof dataStore!=='undefined' && window._transshipReady && window._invExtraReady)).catch(()=>false);
    if (ready) break;
    await sleep(3000);
  }
  console.log('② 转储/拉回 加载器:', ready?'✅ ready':'❌ 超时', '(_transshipReady=' + await p.evaluate(()=>!!window._transshipReady).catch(()=>false) + ', _invExtraReady=' + await p.evaluate(()=>!!window._invExtraReady).catch(()=>false) + ')');

  // 转储数据 tab（默认）
  let trans = await p.evaluate(() => {
    const el = document.getElementById('page-transship');
    const t = el ? el.textContent.replace(/\s+/g,' ') : '';
    return { hasData: t.indexOf('加载失败')<0 && t.length>300, len: t.length, has8: t.indexOf('8月')>=0 || t.indexOf('2026-08')>=0 || t.indexOf('08月')>=0, has7: t.indexOf('7月')>=0, preview: t.slice(0,180) };
  });
  console.log('\n[转储数据 tab]');
  console.log('   有数据:', trans.hasData?'✅':'❌', '| len='+trans.len, '| 含7月:', trans.has7, '| 含8月:', trans.has8);
  console.log('   preview:', trans.preview);

  // 拉回分析 tab
  await p.evaluate(() => { window._transTab='pullback'; renderTransship(); });
  await sleep(9000);
  const pull = await p.evaluate(() => {
    const el = document.getElementById('page-transship');
    const t = el ? el.textContent.replace(/\s+/g,' ') : '';
    const raw = (typeof dataStore!=='undefined' && dataStore.inventory && dataStore.inventory.pullbackRaw) ? dataStore.inventory.pullbackRaw.length : 0;
    return { notFound: t.indexOf('未找到')>=0 || t.indexOf('未解析出有效数据')>=0, hasData: t.indexOf('总拉回')>=0 && t.length>300, len: t.length, has8: t.indexOf('8月')>=0, rawLen: raw, preview: t.slice(0,200) };
  });
  console.log('\n[拉回分析 tab]');
  console.log('   未找到Sheet:', pull.notFound?'❌ 是':'✅ 否', '| 渲染有数据:', pull.hasData?'✅':'❌', '| pullbackRaw行=', pull.rawLen, '| 含8月显示:', pull.has8);
  console.log('   preview:', pull.preview);

  const ok = ready && trans.hasData && !pull.notFound && pull.hasData && pull.rawLen>1000;
  console.log('\n═══════ 结论:', ok?'✅ 转储+拉回均正常（含8月）':'❌ 存在问题', '═══════');
  await b.close(); server.close(); process.exit(ok?0:1);
})();
