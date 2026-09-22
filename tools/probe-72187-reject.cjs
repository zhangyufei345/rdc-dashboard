/**
 * probe-72187-reject.cjs —— 只读探针：核查「订单拒绝原因」打标的订单，看板是否仍计入未清/缺货
 * 用户 2026-09-22 疑点：72187 的订单在 SAP 里全部打标「10-不合理请求」，
 *   但看板「日订单满足率趋势」tooltip 里仍显示 9/21 KA 未清箱数 302。
 * 本脚本直读 data.json（不依赖页面），打印：
 *   A. 该 SKU 当日全部订单明细行（含拒绝原因）
 *   B. 按 RDC / 渠道汇总 orderQty / firstDayShort / 换算箱数
 *   C. 全表统计：有拒绝原因的行占比与量级（若剔除会影响多少）
 *   D. 页面 tooltip 口径复算（getTopShortageSKUsByDay 的等价实现）
 * 用法: node tools/probe-72187-reject.cjs [SKU] [日期]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKU = process.argv[2] || '72187';
const DATE = process.argv[3] || '2026-09-21';

const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const boxSpecMap = j.boxSpecMap || {};
const rows = j.sheets['订单明细'];
const H = rows[0];
console.log('=== 订单明细表头 ===');
H.forEach((h, i) => { if (i < 20) console.log('  [' + i + '] ' + h); });

const C = {
  date: H.indexOf('SAP放行日期'), no: H.indexOf('销售单号'), ch: H.indexOf('主渠道'),
  brand: H.indexOf('品牌名称'), sku: H.indexOf('SKU编码'), name: H.indexOf('SKU名称'),
  reject: H.indexOf('订单拒绝原因'), cg: H.indexOf('客户组5'), rdc: H.indexOf('仓库名称'),
  oq: H.indexOf('订单支数'), first: H.indexOf('首日排单支数'),
  total: H.indexOf('总履约排单支数'), short: H.indexOf('首日缺货量'), gap: H.indexOf('总履约缺口')
};
console.log('列索引:', JSON.stringify(C));

function serialToDateStr(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (typeof v === 'number') {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

const mine = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  if (!r) continue;
  if (String(r[C.sku] == null ? '' : r[C.sku]).trim() !== SKU) continue;
  const ds = serialToDateStr(r[C.date]);
  if (ds !== DATE) continue;
  mine.push({
    date: ds, no: String(r[C.no] || ''), ch: String(r[C.ch] || ''), brand: String(r[C.brand] || ''),
    reject: String(r[C.reject] == null ? '' : r[C.reject]).trim(),
    cg: String(r[C.cg] || ''), rdc: String(r[C.rdc] || ''),
    oq: Number(r[C.oq]) || 0, first: Number(r[C.first]) || 0,
    total: Number(r[C.total]) || 0, short: Number(r[C.short]) || 0, gap: Number(r[C.gap]) || 0
  });
}
mine.sort((a, b) => b.oq - a.oq);
console.log('\n=== A. ' + SKU + ' @ ' + DATE + ' 共 ' + mine.length + ' 行 ===');
console.log(['销售单号', '渠道', '客户组', '仓库', '订单支数', '首日排单', '首日缺货', '总履约缺口', '拒绝原因'].join(' | '));
mine.forEach(m => console.log([m.no, m.ch, m.cg, m.rdc, m.oq, m.first, m.short, m.gap, m.reject || '(空)'].join(' | ')));

const spec = boxSpecMap[SKU] || boxSpecMap[String(Number(SKU))] || 0;
console.log('\n箱规 boxSpecMap[' + SKU + '] = ' + (spec || '(缺)'));

function agg(keyFn) {
  const m = {};
  mine.forEach(r => {
    const k = keyFn(r);
    const a = m[k] || (m[k] = { rows: 0, oq: 0, short: 0, rejectRows: 0, rejOq: 0, rejShort: 0 });
    a.rows++; a.oq += r.oq; a.short += r.short;
    if (r.reject) { a.rejectRows++; a.rejOq += r.oq; a.rejShort += r.short; }
  });
  return m;
}

console.log('\n=== B. 按 RDC 汇总（含拒绝行/剔除拒绝行 对比） ===');
const byRdc = agg(r => r.rdc);
Object.keys(byRdc).sort().forEach(k => {
  const a = byRdc[k];
  const allBox = spec ? (a.short / spec).toFixed(1) : 'N/A';
  const cleanBox = spec ? ((a.short - a.rejShort) / spec).toFixed(1) : 'N/A';
  console.log('  ' + k + ' 行=' + a.rows + ' 订单支数=' + a.oq + ' 首日缺货支=' + a.short + ' → 箱=' + allBox
    + ' | 其中打标拒绝 ' + a.rejectRows + ' 行/' + a.rejOq + '支 缺货支=' + a.rejShort + ' → 剔除后箱=' + cleanBox);
});
const tot = mine.reduce((a, r) => { a.oq += r.oq; a.short += r.short; if (r.reject) { a.rejOq += r.oq; a.rejShort += r.short; a.rejRows++; } return a; }, { oq: 0, short: 0, rejOq: 0, rejShort: 0, rejRows: 0 });
console.log('  【合计】行=' + mine.length + ' 订单支数=' + tot.oq + ' 首日缺货支=' + tot.short
  + ' → 箱=' + (spec ? (tot.short / spec).toFixed(1) : 'N/A')
  + ' | 打标拒绝 ' + tot.rejRows + ' 行/' + tot.rejOq + '支，其首日缺货支=' + tot.rejShort
  + ' → 剔除后箱=' + (spec ? ((tot.short - tot.rejShort) / spec).toFixed(1) : 'N/A'));

console.log('\n=== B2. 按渠道汇总 ===');
Object.keys(agg(r => r.ch)).sort().forEach(k => {
  const a = agg(r => r.ch)[k];
  console.log('  ' + k + ' 行=' + a.rows + ' 订单支数=' + a.oq + ' 首日缺货支=' + a.short + ' 箱=' + (spec ? (a.short / spec).toFixed(1) : 'N/A'));
});

console.log('\n=== C. 全表：有拒绝原因的行（2026-09 全月） ===');
let all = 0, rejRows = 0, rejOq = 0, rejShort = 0, rejOrders = new Set(), totOq = 0, totShort = 0;
let rejByDay = {};
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  if (!r) continue;
  const ds = serialToDateStr(r[C.date]);
  if (!ds || ds.slice(0, 7) !== '2026-09') continue;
  all++;
  const oq = Number(r[C.oq]) || 0, sh = Number(r[C.short]) || 0;
  totOq += oq; totShort += sh;
  const rej = String(r[C.reject] == null ? '' : r[C.reject]).trim();
  if (rej) {
    rejRows++; rejOq += oq; rejShort += sh; rejOrders.add(String(r[C.no] || ''));
    rejByDay[ds] = rejByDay[ds] || { rows: 0, oq: 0, short: 0 };
    rejByDay[ds].rows++; rejByDay[ds].oq += oq; rejByDay[ds].short += sh;
  }
}
console.log('  2026-09 订单明细行=' + all + ' 订单支数=' + totOq + ' 首日缺货支=' + totShort);
console.log('  其中打标拒绝原因 ' + rejRows + ' 行 / ' + rejOrders.size + ' 个销售单号 / 订单支数 ' + rejOq
  + ' (' + (rejOq / totOq * 100).toFixed(2) + '%) / 首日缺货支 ' + rejShort
  + ' (' + (totShort ? (rejShort / totShort * 100).toFixed(2) : '0') + '%)');
console.log('  逐日：');
Object.keys(rejByDay).sort().forEach(d => {
  const a = rejByDay[d];
  console.log('    ' + d + ' 行=' + a.rows + ' 订单支数=' + a.oq + ' 首日缺货支=' + a.short);
});

console.log('\n=== D. 页面 tooltip 口径复算（getTopShortageSKUsByDay 等价：firstDayShort>0，不过滤拒绝原因） ===');
const map = {};
mine.filter(m => m.short > 0).forEach(m => {
  if (!map[SKU]) map[SKU] = { units: 0 };
  map[SKU].units += m.short;
});
console.log('  ' + SKU + ' units=' + (map[SKU] ? map[SKU].units : 0) + ' → 箱=' + (spec ? Math.ceil((map[SKU] ? map[SKU].units : 0) / spec) : 'N/A'));
const cleanUnits = mine.filter(m => m.short > 0 && !m.reject).reduce((a, m) => a + m.short, 0);
console.log('  若剔除拒绝行 units=' + cleanUnits + ' → 箱=' + (spec ? Math.ceil(cleanUnits / spec) : 'N/A'));
