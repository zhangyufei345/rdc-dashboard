// 🔴 修正版：键序统一为 sku|rdc|月（上一版 urMap 与 evidMap 键序不一致 → 交集假 0）
const fs = require('fs');
const P = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40/';
const main = JSON.parse(fs.readFileSync(P + 'data.json', 'utf8'));
const aug = JSON.parse(fs.readFileSync(P + 'data-2026-08.json', 'utf8'));
const S = Object.assign({}, aug.sheets || {}, main.sheets || {});
function colIdx(h, n) { return h.findIndex(x => String(x).trim() === n); }
function lastCol(h, n) { let k = -1; h.forEach((x, i) => { if (String(x).trim() === n) k = i; }); return k; }
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
function normRdc(w) { let s = String(w == null ? '' : w).trim(); if (!s) return ''; return /RDC$/i.test(s) ? s.replace(/rdc$/i, 'RDC') : s + 'RDC'; }
function toDateStr(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  const s = String(v).trim(); const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return m ? m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : '';
}
function isWorkday(ds) { if (!ds || ds.length < 10) return false; const w = new Date(ds + 'T00:00:00').getDay(); return w !== 0 && w !== 6; }
function quantile(a, q) { if (!a.length) return 0; const p = (a.length - 1) * q, b = Math.floor(p), r = p - b; return (b + 1 < a.length) ? a[b] + r * (a[b + 1] - a[b]) : a[b]; }
const shipMap = { '20': '东北RDC', '50': '华南RDC', '60': '西北RDC', '70': '华中RDC', '80': '西南RDC', '90': '华北RDC' };
const K = (sku, rdc, ym) => sku + '|' + rdc + '|' + ym;   // 🔴 唯一键序

// ---- 画像（v377 只展示路径）----
const H = S['订单明细'][0];
const C = { date: colIdx(H, 'SAP放行日期'), sku: colIdx(H, 'SKU编码'), name: colIdx(H, 'SKU名称'), brand: colIdx(H, '品牌名称'),
            wh: colIdx(H, '仓库名称'), oq: colIdx(H, '订单支数'), fds: colIdx(H, '首日缺货量'), gap: colIdx(H, '总履约缺口') };
const prof = {}; const evidKeys = new Set();
for (let i = 1; i < S['订单明细'].length; i++) {
  const r = S['订单明细'][i]; if (!r) continue;
  const ds = toDateStr(r[C.date]); if (!ds || !isWorkday(ds)) continue;
  const sku = String(r[C.sku] == null ? '' : r[C.sku]).trim(); const wh = normRdc(r[C.wh]);
  if (!sku || !wh) continue;
  const ym = ds.slice(0, 7), k = K(sku, wh, ym);
  if (!prof[k]) prof[k] = { month: ym, sku, name: String(r[C.name] || ''), brand: String(r[C.brand] || ''), rdc: wh,
                            orderQty: 0, shortQty: 0, gapQty: 0, shortDays: {}, orderDays: {} };
  const p = prof[k], o = num(r[C.oq]), sh = num(r[C.fds]);
  p.orderQty += o; p.shortQty += sh; p.gapQty += num(r[C.gap]);
  p.orderDays[ds] = 1; if (sh > 0) p.shortDays[ds] = 1;
  if (num(r[C.gap]) > 0) evidKeys.add(k);   // v358 门控
}
// ---- 未放行 openQty ----
const uh = S['未放行订单'][0];
const U = { date: colIdx(uh, '创建日期'), mat: colIdx(uh, '物料'), open: lastCol(uh, '未清数量'), cond: colIdx(uh, '装运条件') };
const urMap = {};
for (let i = 1; i < S['未放行订单'].length; i++) {
  const r = S['未放行订单'][i]; if (!r) continue;
  const d = toDateStr(r[U.date]); if (!d) continue;
  const sku = String(r[U.mat] == null ? '' : r[U.mat]).trim(); if (!sku) continue;
  const cond = String(r[U.cond] == null ? '' : r[U.cond]).trim().replace(/\.0$/, '');
  const rdc = shipMap[cond]; if (!rdc) continue;
  const q = num(r[U.open]); if (!(q > 0)) continue;
  const k = K(sku, rdc, d.slice(0, 7));
  urMap[k] = (urMap[k] || 0) + q;
}
console.log('画像组合 =', Object.keys(prof).length, '| 门控命中 =', evidKeys.size, '| 未放行键 =', Object.keys(urMap).length);
const hitKeys = Object.keys(urMap).filter(k => evidKeys.has(k));
console.log('★ 未放行 ∩ 门控 =', hitKeys.length, '| 涉及未放行量 =', hitKeys.reduce((s, k) => s + urMap[k], 0).toLocaleString(), '支');
const onlyUr = Object.keys(urMap).filter(k => !evidKeys.has(k));
console.log('  有未放行但门控未命中 =', onlyUr.length, '| 量 =', onlyUr.reduce((s, k) => s + urMap[k], 0).toLocaleString(), '支');

// ---- 两条路径评分 ----
function calcSeverity(p, sizePct) { return 0.5 * (sizePct || 0) + 0.3 * Math.min(1, p.mr || 0) + 0.2 * Math.min(1, p.sf || 0); }
const MIN_DAYS = 3;
function finalize(list, mode) {
  for (const q of list) {
    if (mode === 'v353' && q.amt > 0) { q.shortQty = q.baseShort + q.amt; q.orderQty = q.baseOrder + q.amt; }
    else { q.shortQty = q.baseShort; q.orderQty = q.baseOrder; }
    q.shortDayCnt = Object.keys(q.shortDays).length; q.orderDayCnt = Object.keys(q.orderDays).length;
    q.mr = q.orderQty > 0 ? q.shortQty / q.orderQty : 0;
    q.sf = q.orderDayCnt > 0 ? q.shortDayCnt / q.orderDayCnt : 0;
  }
  let base = list.filter(q => q.shortQty > 0 && q.orderDayCnt >= MIN_DAYS);
  if (!base.length) base = list;
  const shorts = base.map(q => q.shortQty).filter(v => v > 0).sort((a, b) => a - b);
  const geoMean = Math.exp(shorts.reduce((s, v) => s + Math.log(v + 1), 0) / shorts.length) - 1;
  const rank = {}; base.forEach(q => { (rank[q.shortQty] = rank[q.shortQty] || []).push(q); });
  const keys = Object.keys(rank).map(Number).sort((a, b) => a - b);
  let idx = 0; const N = base.length;
  keys.forEach(k => { const g = rank[k]; const avg = g.length > 1 ? (idx + (g.length - 1) / 2) / Math.max(1, N - 1) : idx / Math.max(1, N - 1); g.forEach(q => q.sizePct = avg); idx += g.length; });
  list.forEach(q => { if (q.sizePct == null) q.sizePct = 0; if (q.shortQty > 0 && geoMean > 0 && q.shortQty < geoMean) q.sizePct = q.sizePct * (q.shortQty / geoMean); });
  list.forEach(q => q.severity = calcSeverity(q, q.sizePct));
  const sevs = base.map(q => q.severity).sort((a, b) => a - b);
  const P75 = quantile(sevs, 0.75), P90 = quantile(sevs, 0.90);
  list.forEach(q => q.isPersistent = q.severity >= P75);
  return { geoMean, P75, P90, hiCnt: list.filter(q => q.isPersistent).length, baseCnt: base.length,
           hiQty: list.filter(q => q.isPersistent).reduce((s, q) => s + (q.shortQty || 0), 0) };
}
function buildList() {
  const list = [];
  for (const k in prof) {
    const p = prof[k];
    list.push({ k, month: p.month, sku: p.sku, name: p.name, rdc: p.rdc,
                baseShort: p.shortQty, baseOrder: p.orderQty, shortDays: p.shortDays, orderDays: p.orderDays,
                amt: evidKeys.has(k) ? (urMap[k] || 0) : 0 });
  }
  return list;
}
const A = buildList(); const r353 = finalize(A, 'v353');
const B = buildList(); const r377 = finalize(B, 'v377');

console.log('\n================ 严重度评分对比（全量 9 月） ================');
console.log('                          v353(并入分子分母)   v377(只展示)');
console.log('几何平均 hardFloor    =', String(Math.round(r353.geoMean)).padStart(12), String(Math.round(r377.geoMean)).padStart(14));
console.log('sevP75 严重度高阈值   =', r353.P75.toFixed(4).padStart(12), r377.P75.toFixed(4).padStart(14));
console.log('sevP90 紧急升级阈值   =', r353.P90.toFixed(4).padStart(12), r377.P90.toFixed(4).padStart(14));
console.log('「严重度高」入选数    =', String(r353.hiCnt).padStart(12), String(r377.hiCnt).padStart(14));
console.log('入选组合缺货量合计    =', String(r353.hiQty).padStart(12), String(r377.hiQty).padStart(14));

const m353 = new Map(A.map(q => [q.k, q]));
let dif = 0; const flip = [];
for (const q of B) {
  const a = m353.get(q.k);
  if (Math.abs(a.severity - q.severity) > 1e-9) { dif++; if (a.isPersistent !== q.isPersistent) flip.push({ q, a }); }
}
console.log('\n严重度数值有变化的组合数 =', dif, '/', B.length);
console.log('「严重度高」入选翻转     =', flip.length);
if (flip.length) {
  console.log('\n--- 翻转明细（按未放行量降序）---');
  flip.sort((x, y) => y.q.amt - x.q.amt).forEach(({ q, a }) => {
    console.log(`  ${q.sku} ${q.name} · ${q.rdc} | 未放行 ${q.amt.toLocaleString()} 支 | ` +
      `首日缺货 ${q.baseShort.toLocaleString()} | sev ${a.severity.toFixed(3)}→${q.severity.toFixed(3)} | ` +
      `入选 ${a.isPersistent ? '是' : '否'}→${q.isPersistent ? '是' : '否'}`);
  });
}
console.log('\n--- 命中门控的 20 组（未放行量 vs 首日缺货）---');
B.filter(q => q.amt > 0).sort((x, y) => y.amt - x.amt).forEach(q => {
  const ratio = q.baseShort > 0 ? (q.amt / q.baseShort * 100).toFixed(0) + '%' : '∞(原缺货=0)';
  console.log(`  ${q.sku} ${q.name} · ${q.rdc} | 未放行 ${q.amt.toLocaleString()} | 首日缺货 ${q.baseShort.toLocaleString()} | 比 ${ratio} | sev ${q.severity.toFixed(3)} 入选${q.isPersistent ? '是' : '否'}`);
});
