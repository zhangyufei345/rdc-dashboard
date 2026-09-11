// 问题（用户 2026-09-11 17:39）：补货建议「下调预警」的 SKU，是否都是「下月需求衰减」的？
// 读代码得到的入选条件（L10815-10816）：
//   _dwList = _dwAll.filter(r => r.direction === '下调分仓计划' || (r.downScore != null && r.downScore >= 0.45))
// 而 downScore（L18997）= 0.35*devMag + 0.30*demandDecay + 0.15*slowRisk + 0.10*ltLow + 0.10*noPressure
//   → demandDecay 只占 0.30 权重，理论上「无衰减」也能达标。
// 本探针实测 262 条的 demandDecay 分布，并用字段复算 downScore 验证我的理解。
// 用法：node tools/probe-dw-decay.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..'), PORT = 8979;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'application/javascript; charset=utf-8' };
const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { s.writeHead(404); s.end('404'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(s);
});
const HARD = setTimeout(() => { console.error('\n❌ 硬超时 9 分钟'); process.exit(3); }, 540000);

const analyze = () => {
  const dw = window._dwList || [];
  const buck = { '0': 0, '0.4': 0, '0.7': 0, '1.0': 0, 'other': 0 };
  const noDecay = [], withDecay = [];
  dw.forEach(r => {
    const k = String(r.demandDecay == null ? 0 : r.demandDecay);
    if (k === '0') { buck['0']++; noDecay.push(r); }
    else if (k === '0.4') { buck['0.4']++; withDecay.push(r); }
    else if (k === '0.7') { buck['0.7']++; withDecay.push(r); }
    else if (k === '1') { buck['1.0']++; withDecay.push(r); }
    else { buck.other++; }
  });
  // 字段复算 downScore（验证我对公式的理解）
  let recomputeOk = 0, recomputeBad = 0, maxErr = 0;
  dw.forEach(r => {
    const slow = (r.dims && r.dims.slowRisk) || 0;
    const calc = 0.35 * (r.devMag || 0) + 0.30 * (r.demandDecay || 0) + 0.15 * slow + 0.10 * (r.ltLow || 0) + 0.10 * (r.noPressure || 0);
    const err = Math.abs(calc - (r.downScore || 0));
    if (err < 0.005) recomputeOk++; else { recomputeBad++; if (err > maxErr) maxErr = err; }
  });
  // 无衰减那批：靠哪些维度凑到阈值？
  const noDecayNoDecayPart = noDecay.map(r => ({
    sku: r.sku, rdc: r.rdc, plan: r.plan, dir: r.direction,
    downScore: +((r.downScore || 0).toFixed(3)),
    noDecayScore: +((0.35 * (r.devMag || 0) + 0.15 * ((r.dims && r.dims.slowRisk) || 0) + 0.10 * (r.ltLow || 0) + 0.10 * (r.noPressure || 0)).toFixed(3)),
    devMag: +((r.devMag || 0).toFixed(3)), slowRisk: (r.dims && r.dims.slowRisk) || 0,
    ltLow: +((r.ltLow || 0).toFixed(3)), noPressure: r.noPressure || 0,
    comp: +((r.comp || 0).toFixed(3)), shortQty: r.shortQty || 0,
  })).sort((a, b) => b.downScore - a.downScore);
  // 无衰减里，纯「预警态」（未达 0.60 下调阈值）有多少
  const noDecayWarnOnly = noDecay.filter(r => r.direction !== '下调分仓计划').length;
  const noDecayDown = noDecay.filter(r => r.direction === '下调分仓计划').length;

  // ==== 关键校验：全量候选里，无衰减的 SKU 是否有满足入选条件的？（证明 262 全衰减不是过滤造成的）====
  const all = (typeof buildPlanOptimAdvice === 'function') ? (buildPlanOptimAdvice() || []) : [];
  const isElig = r => r.direction === '下调分仓计划' || (r.downScore != null && r.downScore >= 0.45);
  const allElig = all.filter(isElig);
  const decay0All = all.filter(r => !r.demandDecay);
  const decay0Elig = allElig.filter(r => !r.demandDecay);
  let maxDown0 = 0, maxDown0Sku = '';
  decay0All.forEach(r => { const s = r.downScore || 0; if (s > maxDown0) { maxDown0 = s; maxDown0Sku = r.sku + '@' + r.rdc + ' dir=' + r.direction; } });
  const gap = all.filter(r => r.demandDecay > 0);
  // 衰减档位在「已入选」和「全量」两个池子的对比
  const cnt = (arr, v) => arr.filter(r => (r.demandDecay || 0) === v).length;
  // 去重值分布（排查档位统计对不上的原因：是否有非 0.4/0.7/1.0 的值或缺失）
  const valDist = (arr) => { const m = {}; arr.forEach(r => { const k = String(r.demandDecay); m[k] = (m[k] || 0) + 1; }); return m; };

  return {
    valDistDw: valDist(dw),
    valDistAllElig: valDist(allElig),
    crossCheck: {
      adviceTotal: all.length,
      allEligCnt: allElig.length,
      allEligWithDecay: allElig.length - decay0Elig.length,
      allEligNoDecay: decay0Elig.length,
      adviceNoDecayCnt: decay0All.length,
      adviceNoDecayMaxDownScore: +maxDown0.toFixed(3),
      adviceNoDecayMaxDownSku: maxDown0Sku,
      adviceWithDecayCnt: gap.length,
      adviceWithDecayMaxDownScore: +(Math.max(...(gap.length ? gap.map(r => r.downScore || 0) : [0]))).toFixed(3),
      eligDecayBreakdown: { '0.4': cnt(allElig, 0.4), '0.7': cnt(allElig, 0.7), '1.0': cnt(allElig, 1) },
    },
    total: dw.length,
    buck, noDecayCnt: noDecay.length, withDecayCnt: withDecay.length,
    noDecayWarnOnly, noDecayDown,
    recomputeOk, recomputeBad, maxErr: +maxErr.toFixed(4),
    noDecayTop12: noDecayNoDecayPart.slice(0, 12),
    withDecayDecayVals: withDecay.slice(0, 5).map(r => r.sku + '@' + r.rdc + ' decay=' + r.demandDecay + ' down=' + (r.downScore || 0).toFixed(2)),
  };
};

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
  p.on('pageerror', e => errs.push(e.message.slice(0, 200)));

  console.log('冷加载页面...');
  await p.goto(`http://127.0.0.1:${PORT}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 150; i++) {
    const ok = await p.evaluate(() => !!(typeof dataStore !== 'undefined' && dataStore.loaded && (dataStore.orderDetail || []).length > 100000)).catch(() => false);
    if (ok) { console.log('  基础数据就绪 (' + (i * 2) + 's)'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  await p.evaluate(() => navigateTo('replenishment')).catch(() => {});
  console.log('等待 planBySkuRdc 就绪（最多 120s）...');
  for (let i = 0; i < 60; i++) {
    const n = await p.evaluate(() => { const _pb = (dataStore.inventory || {}).planBySkuRdc; return _pb ? Object.keys(_pb).length : 0; }).catch(() => 0);
    if (n > 100) { console.log('  planBySkuRdc keys=' + n + ' (' + (i * 2) + 's)'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  // 稳态重渲染（显式 all RDC，排除筛选干扰）
  await p.evaluate(() => { window._replRdc = 'all'; renderReplenishment(); }).catch(e => console.log('渲染异常 ' + String(e).slice(0, 150)));
  await new Promise(r => setTimeout(r, 3000));

  const out = await p.evaluate(analyze);
  console.log('\n================ 下调预警 demandDecay 分布 ================');
  console.log('  _dwList 总条数 = ' + out.total);
  console.log('  demandDecay=0    (无衰减信号) : ' + out.buck['0']);
  console.log('  demandDecay=0.4  (轻度 33%+)  : ' + out.buck['0.4']);
  console.log('  demandDecay=0.7  (明显 50%+)  : ' + out.buck['0.7']);
  console.log('  demandDecay=1.0  (强 67%+)    : ' + out.buck['1.0']);
  if (out.buck.other) console.log('  其他: ' + out.buck.other);
  console.log('  ---- 有衰减合计 = ' + out.withDecayCnt + ' / 无衰减合计 = ' + out.noDecayCnt);
  console.log('  无衰减中：direction=下调分仓计划 ' + out.noDecayDown + ' 条 / 仅预警态 ' + out.noDecayWarnOnly + ' 条');

  console.log('\n================ 公式复算校验（0.35*devMag+0.30*decay+0.15*slow+0.10*ltLow+0.10*noPressure）================');
  console.log('  吻合 ' + out.recomputeOk + ' 条 / 不吻合 ' + out.recomputeBad + ' 条 / 最大误差 ' + out.maxErr);

  console.log('\n================ 无衰减(demandDecay=0) 里 downScore 最高的 12 条 ================');
  console.log('  sku@rdc | 计划 | dir | downScore | 无衰减部分 | devMag | slowRisk | ltLow | noPressure | comp | 缺货箱');
  out.noDecayTop12.forEach(r => {
    console.log('  ' + r.sku + '@' + r.rdc + ' | ' + r.plan + ' | ' + r.dir + ' | ' + r.downScore + ' | ' + r.noDecayScore + ' | ' + r.devMag + ' | ' + r.slowRisk + ' | ' + r.ltLow + ' | ' + r.noPressure + ' | ' + r.comp + ' | ' + r.shortQty);
  });

  console.log('\n================ 有衰减样例（前5）================');
  out.withDecayDecayVals.forEach(s => console.log('  ' + s));

  console.log('\n================ 全量候选交叉校验（证明「262 全衰减」不是过滤造成的）================');
  const c = out.crossCheck;
  console.log('  buildPlanOptimAdvice 全量条数            : ' + c.adviceTotal);
  console.log('  满足入选条件(下调 or downScore>=0.45)   : ' + c.allEligCnt + '  （其中含衰减 ' + c.allEligWithDecay + ' / 无衰减 ' + c.allEligNoDecay + '）');
  console.log('  全量里无衰减(demandDecay=0)条数          : ' + c.adviceNoDecayCnt);
  console.log('  全量无衰减里 downScore 最高              : ' + c.adviceNoDecayMaxDownScore + '   [' + c.adviceNoDecayMaxDownSku + ']  (阈值 0.45)');
  console.log('  全量有衰减里 downScore 最高              : ' + c.adviceWithDecayMaxDownScore);
  console.log('  入选池衰减档位分布                       : 0.4→' + c.eligDecayBreakdown['0.4'] + '  0.7→' + c.eligDecayBreakdown['0.7'] + '  1.0→' + c.eligDecayBreakdown['1.0']);
  console.log('  [去重值分布] _dwList    : ' + JSON.stringify(out.valDistDw));
  console.log('  [去重值分布] 入选池285   : ' + JSON.stringify(out.valDistAllElig));

  console.log('\n  页面错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('    └ ' + e));
  clearTimeout(HARD);
  await b.close(); server.close();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); clearTimeout(HARD); process.exit(2); });
