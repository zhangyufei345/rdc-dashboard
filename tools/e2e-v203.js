// v203 订单按月分片 —— 真实浏览器端到端验证
// 覆盖三个场景：
//   P1 首次冷加载（无 IDB）：全量 12 文件，验证月度快照正确落盘
//   P2 reload（缓存命中路径）：验证从快照合并回来，数据不丢
//   P3 模拟「只更新 9 月订单」部署：验证历史月份不从网络重拉，且数据仍完整
// 用法：node tools/e2e-v203.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8899;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'application/javascript', '.xlsx': 'application/octet-stream', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const fp = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

// 从 IndexedDB 读出快照统计（dataStore 是脚本作用域的顶层 const，evaluate 访问不到，
// 所以改为直接读 IDB —— 这同时也是分片方案的核心保证：内存数据 == 快照合并结果）
const READ_IDB = async () => {
  return await new Promise((resolve) => {
    const req = indexedDB.open('RDC_Dashboard');
    req.onsuccess = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('datasets')) { resolve({ error: 'no store' }); return; }
      const tx = db.transaction('datasets', 'readonly');
      const r = tx.objectStore('datasets').getAll();
      r.onsuccess = () => {
        const snaps = {};
        let cur = null;
        (r.result || []).forEach((rec) => {
          if (!rec || !rec.key) return;
          if (String(rec.key).indexOf('snap_') === 0) {
            const s = rec.snap || {};
            snaps[rec.month || 'unknown'] = {
              order: (s.orderDetail || []).length,
              shortage: (s.shortage || []).length,
              biz: (s.bizDemand || []).length,
              other: (s.otherOrders || []).length
            };
          } else if (rec.key === 'current_data') {
            cur = {
              cov7: (rec.inventory && rec.inventory.cov7) ? rec.inventory.cov7.length : 0,
              // v203 后 current_data 不应再含按月字段
              stillHasOrderDetail: Object.prototype.hasOwnProperty.call(rec, 'orderDetail'),
              stillHasShortage: Object.prototype.hasOwnProperty.call(rec, 'shortage'),
              shipCond: Object.keys(rec.shipCondRdcMap || {}).length
            };
          }
        });
        const orderTotal = Object.values(snaps).reduce((a, b) => a + b.order, 0);
        const shortTotal = Object.values(snaps).reduce((a, b) => a + b.shortage, 0);
        resolve({ snaps, cur, orderTotal, shortTotal, monthCount: Object.keys(snaps).length });
      };
      r.onerror = () => resolve({ error: 'read fail' });
    };
    req.onerror = () => resolve({ error: 'open fail' });
  });
};

// 轮询 IDB 直到「快照数 + 订单总行数」连续 3 次不变且达标。
// 不能用 DOM/load 事件判断完成——首屏 renderAll 发生在实际数据落盘之前，
// 早期版本就是这么读出了 cov7=0 / 快照只有 7 个的假象，误报成代码 bug。
async function waitLoaded(page, expectMonths, timeoutMs) {
  const t0 = Date.now();
  let lastCount = -1, lastTotal = -1, stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    const s = await page.evaluate(READ_IDB).catch(() => null);
    if (s && !s.error) {
      if (s.monthCount === lastCount && s.orderTotal === lastTotal) {
        stable++;
        if (stable >= 3 && s.monthCount >= expectMonths && s.orderTotal > 200000 && s.cur && s.cur.cov7 > 100) return s;
      } else { stable = 0; }
      lastCount = s.monthCount; lastTotal = s.orderTotal;
    }
    await page.waitForTimeout(2000);
  }
  console.log('   ⚠️ 等待超时，当前状态: 快照 ' + lastCount + ' 个 / 订单 ' + lastTotal + ' 行');
  return await page.evaluate(READ_IDB).catch(() => null);
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('静态服务: http://127.0.0.1:' + PORT);

  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const fetches = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/data') && u.endsWith('.json')) fetches.push(u.split('/').pop());
  });
  page.on('console', (m) => {
    const t = m.text();
    if (/v203|快照|回填|全量重拉|残缺/.test(t)) console.log('   [console] ' + t.slice(0, 160));
  });

  await page.addInitScript(() => { try { localStorage.setItem('rdc_dashboard_auth', 'true'); } catch (e) {} });

  // ── P1 首次冷加载 ──
  console.log('\n═══ P1 首次冷加载（无缓存，全量 12 文件）═══');
  fetches.length = 0;
  await page.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  const p1 = await waitLoaded(page, 9, 300000);
  console.log('加载完成: ' + (p1 && p1.monthCount >= 9 ? '✅' : '⚠️ 未达预期'));
  console.log('月度快照: ' + p1.monthCount + ' 个');
  Object.keys(p1.snaps || {}).sort().forEach((m) => {
    const s = p1.snaps[m];
    console.log('   ' + m + '  订单 ' + String(s.order).padStart(7) + '  缺货 ' + String(s.shortage).padStart(5) + '  业务需求 ' + String(s.biz).padStart(4) + '  其他订单 ' + s.other);
  });
  console.log('   合计: 订单 ' + p1.orderTotal + ' 行 / 缺货 ' + p1.shortTotal + ' 行');
  console.log('current_data: cov7=' + (p1.cur ? p1.cur.cov7 : '?') + '  仍含 orderDetail 字段=' + (p1.cur ? p1.cur.stillHasOrderDetail : '?') + '  仍含 shortage 字段=' + (p1.cur ? p1.cur.stillHasShortage : '?'));
  console.log('本次 fetch 的订单文件: ' + fetches.length + ' 个');

  // ── P2 reload（缓存命中）──
  console.log('\n═══ P2 reload（缓存命中路径，应无网络重拉）═══');
  fetches.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  const p2 = await waitLoaded(page, 9, 180000);
  console.log('月度快照: ' + p2.monthCount + ' 个, 订单合计 ' + p2.orderTotal + ' 行, 缺货 ' + p2.shortTotal + ' 行');
  console.log('本次 fetch 的订单文件: ' + fetches.length + ' 个  ' + (fetches.length === 0 ? '✅ 未重拉' : '(history.json 等属正常)'));

  // ── P3 模拟部署「只更新 9 月订单」──
  console.log('\n═══ P3 模拟部署：只更新当月订单（data.json 哈希失效）═══');
  await page.evaluate(() => {
    const h = JSON.parse(localStorage.getItem('rdc_manifest_hashes') || '{}');
    delete h['data.json'];
    localStorage.setItem('rdc_manifest_hashes', JSON.stringify(h));
    localStorage.setItem('rdc_deploy_flag', 'SIMULATE_SEP_ORDER_DEPLOY'); // 让 bootLoad 走「新版本部署」分支
  });
  fetches.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  const p3 = await waitLoaded(page, 9, 180000);
  const histFetched = fetches.filter((f) => /^data-2026-\d\d\.json$/.test(f));
  console.log('月度快照: ' + p3.monthCount + ' 个, 订单合计 ' + p3.orderTotal + ' 行, 缺货 ' + p3.shortTotal + ' 行');
  console.log('本次 fetch 的订单文件: ' + fetches.join(', '));
  console.log('   其中历史月文件: ' + histFetched.length + ' 个 ' + (histFetched.length === 0 ? '✅ 未重拉（从本地快照回填）' : '❌ 仍走网络: ' + histFetched.join(',')));

  // ── 结论 ──
  console.log('\n═══════════ 结论 ═══════════');
  const pass = [];
  const fail = [];
  if (p1.monthCount === 9) pass.push('P1 生成 9 个月度快照'); else fail.push('P1 快照数应为 9，实为 ' + p1.monthCount);
  if (p1.orderTotal > 200000) pass.push('P1 订单明细完整（' + p1.orderTotal + ' 行）'); else fail.push('P1 订单行数异常: ' + p1.orderTotal);
  if (p1.cur && p1.cur.stillHasOrderDetail === false) pass.push('P1 current_data 已不含 orderDetail（分片生效）'); else fail.push('P1 current_data 仍含 orderDetail');
  if (p2.orderTotal === p1.orderTotal) pass.push('P2 reload 后订单行数一致（' + p2.orderTotal + '）'); else fail.push('P2 订单行数漂移: ' + p1.orderTotal + ' → ' + p2.orderTotal);
  if (p3.orderTotal === p1.orderTotal) pass.push('P3 增量更新后订单行数一致（历史月已从快照回填）'); else fail.push('P3 订单行数漂移: ' + p1.orderTotal + ' → ' + p3.orderTotal);
  if (histFetched.length === 0) pass.push('P3 历史月份零网络重拉'); else fail.push('P3 仍重拉了 ' + histFetched.length + ' 个历史月文件');
  if (p3.shortTotal === p1.shortTotal) pass.push('P3 缺货汇总行数一致（' + p3.shortTotal + '）'); else fail.push('P3 缺货行数漂移: ' + p1.shortTotal + ' → ' + p3.shortTotal);

  pass.forEach((p) => console.log('  ✅ ' + p));
  fail.forEach((p) => console.log('  ❌ ' + p));
  console.log(fail.length === 0 ? '\n全部通过' : '\n有 ' + fail.length + ' 项失败');

  await browser.close();
  server.close();
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('E2E 异常:', e); server.close(); process.exit(2); });
