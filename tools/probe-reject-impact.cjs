/**
 * probe-reject-impact.cjs —— 只读：量化「订单拒绝原因」打标订单对看板各口径的影响面
 * 用于回答用户 2026-09-22：「被打标拒绝原因的订单不计入订单满足统计范围」若落地，会影响什么
 * 逐月扫描 data.json + data-2026-01..08.json，输出：
 *   A. 逐月：拒绝行数 / 订单支数 / 首日缺货支 / 占总缺货比
 *   B. 逐月满足率（含 vs 不含拒绝行）= firstDayQty ÷ orderQty，剔非工作日
 *   C. 9/21 当天逐日明细（KA / 经销商）
 *   D. 受影响模块清单（按各口径复算）
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function loadRows(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return null;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const rows = j.sheets && j.sheets['订单明细'];
  if (!rows || !rows.length) return null;
  return rows;
}
function serialToDateStr(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 60000) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  }
  return null;
}
// 与页面 isWorkday 等价：剔双休（页面还含节假日表，此处仅周末近似，差异极小）
function isWorkdayLike(ds) {
  const d = new Date(ds + 'T00:00:00Z');
  const w = d.getUTCDay();
  return w !== 0 && w !== 6;
}

const FILES = ['data-2026-01.json','data-2026-02.json','data-2026-03.json','data-2026-04.json',
  'data-2026-05.json','data-2026-06.json','data-2026-07.json','data-2026-08.json','data.json'];

const months = {};
const day0921 = {};
let dayDetail = [];

FILES.forEach(f => {
  const rows = loadRows(f);
  if (!rows) { console.log('  (缺) ' + f); return; }
  const H = rows[0];
  const C = { date: 0, ch: H.indexOf('主渠道'), sku: H.indexOf('SKU编码'), reject: H.indexOf('订单拒绝原因'),
    rdc: H.indexOf('仓库名称'), oq: H.indexOf('订单支数'), first: H.indexOf('首日排单支数'),
    short: H.indexOf('首日缺货量'), gap: H.indexOf('总履约缺口'), no: H.indexOf('销售单号'),
    cg: H.indexOf('客户组5'), brand: H.indexOf('品牌名称') };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const ds = serialToDateStr(r[C.date]);
    if (!ds) continue;
    const ym = ds.slice(0, 7);
    const rej = String(r[C.reject] == null ? '' : r[C.reject]).trim();
    const oq = Number(r[C.oq]) || 0, first = Number(r[C.first]) || 0, sh = Number(r[C.short]) || 0;
    const ch = String(r[C.ch] || '');
    if (!months[ym]) months[ym] = { rows: 0, oq: 0, first: 0, short: 0, rejRows: 0, rejOq: 0, rejFirst: 0, rejShort: 0,
      rejRowsWd: 0, rejOqWd: 0, rejFirstWd: 0, rejShortWd: 0, wdRows: 0, wdOq: 0, wdFirst: 0, wdShort: 0,
      ka: { oq: 0, first: 0, rejOq: 0, rejFirst: 0 }, jx: { oq: 0, first: 0, rejOq: 0, rejFirst: 0 } };
    const m = months[ym];
    m.rows++; m.oq += oq; m.first += first; m.short += sh;
    if (rej) { m.rejRows++; m.rejOq += oq; m.rejFirst += first; m.rejShort += sh; }
    const wd = isWorkdayLike(ds);
    if (wd) {
      m.wdRows++; m.wdOq += oq; m.wdFirst += first; m.wdShort += sh;
      if (rej) { m.rejRowsWd++; m.rejOqWd += oq; m.rejFirstWd += first; m.rejShortWd += sh; }
    }
    const bucket = ch === 'KA' ? m.ka : (ch === '经销商' ? m.jx : null);
    if (bucket) {
      bucket.oq += oq; bucket.first += first;
      if (rej) { bucket.rejOq += oq; bucket.rejFirst += first; }
    }
    if (ds === '2026-09-21' && wd) {
      if (!day0921[ym]) day0921[ym] = 0;
      dayDetail.push({ no: String(r[C.no]||''), ch, cg: String(r[C.cg]||''), rdc: String(r[C.rdc]||''),
        sku: String(r[C.sku]||''), oq, first, sh, gap: Number(r[C.gap])||0, reject: rej });
    }
  }
});

console.log('=== A/B. 逐月：拒绝行影响面 + 满足率（含 vs 不含；仅工作日） ===');
console.log('月份 | 全部行 | 工作日行 | 拒绝行(工作日) | 拒绝订单支 | 拒绝首日排单为0? | 满足率含 | 满足率不含 | Δpp');
Object.keys(months).sort().forEach(ym => {
  const m = months[ym];
  const rateAll = m.wdOq > 0 ? (m.wdFirst / m.wdOq * 100) : 0;
  const oq2 = m.wdOq - m.rejOqWd, f2 = m.wdFirst - m.rejFirstWd;
  const rateClean = oq2 > 0 ? (f2 / oq2 * 100) : 0;
  console.log('  ' + ym + ' | ' + m.rows + ' | ' + m.wdRows + ' | ' + m.rejRowsWd + ' | ' + m.rejOqWd
    + ' | 拒绝缺货' + m.rejShortWd + ' | ' + rateAll.toFixed(2) + '% | ' + rateClean.toFixed(2) + '% | +'
    + (rateClean - rateAll).toFixed(2));
});

console.log('\n=== A2. 全月（含非工作日）拒绝行量级 ===');
Object.keys(months).sort().forEach(ym => {
  const m = months[ym];
  console.log('  ' + ym + ' 拒绝 ' + m.rejRows + ' 行 / ' + m.rejOq + ' 支 / 首日缺货 ' + m.rejShort + ' 支'
    + ' | 占该月缺货 ' + (m.short ? (m.rejShort / m.short * 100).toFixed(2) : '0') + '%');
});

console.log('\n=== C. 9/21 工作日行明细（前 40 行，标出拒绝行） ===');
dayDetail.sort((a, b) => (b.reject ? 1 : 0) - (a.reject ? 1 : 0) || b.oq - a.oq);
console.log('  总行数=' + dayDetail.length + ' 其中拒绝行=' + dayDetail.filter(d => d.reject).length);
dayDetail.slice(0, 40).forEach(d => {
  console.log('  ' + [d.no, d.ch, d.cg, d.rdc, d.sku, '订单' + d.oq, '首日排单' + d.first, '缺货' + d.sh, (d.reject || '(无)')].join(' | '));
});

console.log('\n=== D. 9/21 KA 满足率（页面「日订单满足率趋势」口径：firstDayQty/orderQty，剔非工作日） ===');
const kaRows = dayDetail.filter(d => d.ch === 'KA');
const jxRows = dayDetail.filter(d => d.ch === '经销商');
function rate(rows, skipRej) {
  const rs = skipRej ? rows.filter(r => !r.reject) : rows;
  const oq = rs.reduce((a, r) => a + r.oq, 0), f = rs.reduce((a, r) => a + r.first, 0);
  return { oq, f, rate: oq > 0 ? f / oq * 100 : 0, n: rs.length };
}
[['KA', kaRows], ['经销商', jxRows]].forEach(([label, rows]) => {
  const a = rate(rows, false), b = rate(rows, true);
  console.log('  ' + label + ' 含拒绝: ' + a.rate.toFixed(2) + '% (' + a.f + '/' + a.oq + ', ' + a.n + '行)'
    + ' | 剔除拒绝: ' + b.rate.toFixed(2) + '% (' + b.f + '/' + b.oq + ', ' + b.n + '行)'
    + ' | Δ +' + (b.rate - a.rate).toFixed(2) + 'pp');
});
