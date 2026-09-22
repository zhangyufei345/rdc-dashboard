/**
 * probe-reject-reasons.cjs —— 只读：订单拒绝原因的取值分布（全月份）
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FILES = ['data-2026-01.json','data-2026-02.json','data-2026-03.json','data-2026-04.json',
  'data-2026-05.json','data-2026-06.json','data-2026-07.json','data-2026-08.json','data.json'];
function serialToDateStr(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 60000) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  }
  return null;
}
const reason = {};
const byMonthReason = {};
let totRows = 0, rejRows = 0, totShort = 0, rejShort = 0;
FILES.forEach(f => {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) return;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const rows = j.sheets && j.sheets['订单明细'];
  if (!rows) return;
  const H = rows[0];
  const C = { date: 0, reject: H.indexOf('订单拒绝原因'), oq: H.indexOf('订单支数'),
    first: H.indexOf('首日排单支数'), short: H.indexOf('首日缺货量'), gap: H.indexOf('总履约缺口'),
    rdc: H.indexOf('仓库名称'), ch: H.indexOf('主渠道') };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const ds = serialToDateStr(r[C.date]);
    if (!ds) continue;
    totRows++; totShort += Number(r[C.short]) || 0;
    const rj = String(r[C.reject] == null ? '' : r[C.reject]).trim();
    if (!rj) continue;
    rejRows++; rejShort += Number(r[C.short]) || 0;
    const a = reason[rj] || (reason[rj] = { rows: 0, oq: 0, short: 0, gap: 0, zeroFirst: 0, fullGap: 0, rdc: {} });
    a.rows++; a.oq += Number(r[C.oq]) || 0; a.short += Number(r[C.short]) || 0; a.gap += Number(r[C.gap]) || 0;
    if ((Number(r[C.first]) || 0) === 0) a.zeroFirst++;
    if ((Number(r[C.gap]) || 0) === (Number(r[C.oq]) || 0)) a.fullGap++;
    const rdc = String(r[C.rdc] || '?'); a.rdc[rdc] = (a.rdc[rdc] || 0) + 1;
    const ym = ds.slice(0, 7);
    if (!byMonthReason[ym]) byMonthReason[ym] = {};
    byMonthReason[ym][rj] = (byMonthReason[ym][rj] || 0) + 1;
  }
});
console.log('全部行=' + totRows + ' 拒绝行=' + rejRows + ' (' + (rejRows / totRows * 100).toFixed(2) + '%)');
console.log('全部首日缺货=' + totShort + ' 拒绝行首日缺货=' + rejShort + ' (' + (rejShort / totShort * 100).toFixed(2) + '%)');
console.log('\n=== 拒绝原因取值分布 ===');
Object.keys(reason).sort((a, b) => reason[b].rows - reason[a].rows).forEach(k => {
  const a = reason[k];
  console.log('  「' + k + '」 行=' + a.rows + ' 订单支=' + a.oq + ' 首日缺货=' + a.short + ' 总履约缺口=' + a.gap
    + ' | 首日排单=0 的行=' + a.zeroFirst + ' | 总缺口==订单支 的行=' + a.fullGap);
  console.log('      涉及 RDC: ' + Object.keys(a.rdc).map(r => r + ':' + a.rdc[r]).join(', '));
});
console.log('\n=== 逐月 × 原因（行数） ===');
const allReasons = Object.keys(reason);
console.log('月份 | ' + allReasons.join(' | '));
Object.keys(byMonthReason).sort().forEach(ym => {
  console.log(ym + ' | ' + allReasons.map(r => byMonthReason[ym][r] || 0).join(' | '));
});
