// v206 P5 专项：模拟用户 9/5 报障场景「中毒 IDB 缓存」，验证能否自动自愈。
//   步骤：正常 boot → 内存毒化 dataStore.inventory（cov7=[] + structureByYear={}）→ saveToIDB
//         → reload（走 IDB 缓存路径）→ 期望健康检查/强制重拉把它救回来。
// 与 e2e-v206.js 分开跑：全量重拉本地实测 ~4 分钟，合并进主脚本会撞 8 分钟硬超时。
// 用法：node tools/e2e-v206-p5.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8947;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 20 分钟'); process.exit(3); }, 1200000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });
  const cdn = path.join(__dirname, '.cdn-cache');
  await p.route('**/echarts.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'echarts.min.js')) }).catch(() => {}));
  await p.route('**/xlsx.full.min.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(cdn, 'xlsx.full.min.js')) }).catch(() => {}));
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0, 160)));
  const logs = [];
  p.on('console', m => { const t = m.text(); if (m.type() === 'error') errs.push('console: ' + t.slice(0, 160)); if (/缓存|自愈|清空|强制|重拉|cov7/i.test(t)) logs.push(t.slice(0, 160)); });

  const bootDone = async () => {
    for (let i = 0; i < 150; i++) {
      const ok = await p.evaluate(() => !!(window.dataStore && dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(() => false);
      if (ok) return true;
      await sleep(2000);
    }
    return false;
  };

  const t0 = Date.now();
  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  console.log('① 首次 boot：' + (await bootDone() ? '就绪 ✅' : '失败 ❌') + '（' + ((Date.now() - t0) / 1000).toFixed(0) + 's）');

  console.log('② 毒化 inventory（cov7=[] / structureByYear={}）并写回 IDB…');
  await p.evaluate(async () => {
    dataStore.inventory = Object.assign({}, dataStore.inventory, { cov7: [], cov6: [], cov5: [], structureByYear: {}, coverageNew: {} });
    await saveToIDB();
  });
  logs.length = 0;
  const t1 = Date.now();
  await p.reload({ waitUntil: 'domcontentloaded' });
  let healed = false;
  for (let i = 0; i < 180; i++) {                       // 全量重拉 ~4 分钟，给足 9 分钟
    healed = await p.evaluate(() => !!(window.dataStore && dataStore.loaded && dataStore.inventory && dataStore.inventory.cov7 && dataStore.inventory.cov7.length > 100)).catch(() => false);
    if (healed) break;
    await sleep(3000);
  }
  console.log('③ reload 后自愈：' + (healed ? '✅ 自动恢复' : '❌ 未恢复') + '（等待 ' + ((Date.now() - t1) / 1000).toFixed(0) + 's）');

  await p.evaluate(() => navigateTo('plan-monitor'));
  await sleep(10000);
  const st = await p.evaluate(() => {
    const inv = dataStore.inventory || {};
    return {
      cov7: (inv.cov7 || []).length,
      struct: !!(inv.structureByYear && inv.structureByYear['2026']),
      planSkus: Object.keys(inv.planBySkuRdc || {}).length,
      pd08: (typeof getPlanDemand === 'function') ? getPlanDemand('09539', '华南RDC', 'cov08') : undefined,
      hasErr: (document.getElementById('page-plan-monitor').textContent || '').indexOf('暂无数据') >= 0,
    };
  }).catch(e => ({ err: e.message.slice(0, 120) }));
  console.log('④ 自愈后分仓监控：cov7=' + st.cov7 + ' struct=' + st.struct + ' plan=' + st.planSkus + ' pd08=' + st.pd08 + ' 有错误页=' + st.hasErr);

  const ok = healed && st.cov7 === 2735 && st.struct && st.planSkus === 417 && st.pd08 === 191 && !st.hasErr;
  console.log('\n' + (ok ? '✅ P5 毒缓存自愈通过' : '❌ P5 未通过'));
  console.log('  页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('    └ ' + e));
  console.log('  自愈相关日志:');
  logs.slice(0, 8).forEach(l => console.log('    · ' + l));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(ok && errs.length === 0 ? 0 : 1);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
