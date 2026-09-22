/* 为「已拒绝」标注的展示设计取真实数字（不改任何代码）
   数据源：data.json「订单明细」sheet（第 7 列 = 订单拒绝原因）
   口径：完全照 getTopShortageSKUsByDay（日）与 buildMonthlyShortageProfile（月，剔非工作日） */
const fs = require('fs');
const path = require('path');
const D = path.resolve(__dirname, '..');
const j = JSON.parse(fs.readFileSync(path.join(D, 'data.json'), 'utf8'));
const boxSpecMap = j.boxSpecMap || {};
const rows = j.sheets['订单明细'];
const H = rows[0];
const idx = n => H.indexOf(n);
const C = { date: idx('SAP放行日期'), ord: idx('销售单号'), ch: idx('主渠道'), sku: idx('SKU编码'), name: idx('SKU名称'), rej: idx('订单拒绝原因'), wh: idx('仓库名称'), oq: idx('订单支数'), fd: idx('首日排单支数'), fs: idx('首日缺货量'), tg: idx('总履约缺口') };

function normDate(v) {
  if (v == null) return '';
  if (typeof v === 'number') { const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000); return d.toISOString().slice(0, 10); }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  return s;
}
const num = v => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
const isRej = v => v != null && String(v).trim() !== '';

const od = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i]; if (!r || !r[C.sku]) continue;
  od.push({
    dateStr: normDate(r[C.date]), orderNo: String(r[C.ord] || '').trim(), channel: String(r[C.ch] || '').trim(),
    skuCode: String(r[C.sku] || '').trim(), skuName: String(r[C.name] || '').trim(),
    rej: isRej(r[C.rej]) ? String(r[C.rej]).trim() : '', warehouse: String(r[C.wh] || '').trim(),
    orderQty: num(r[C.oq]), firstDayQty: num(r[C.fd]), firstDayShort: num(r[C.fs]), totalGap: num(r[C.tg])
  });
}
const bs = c => { const v = boxSpecMap[c]; return v > 0 ? v : null; };
const boxes = (units, c) => { const b = bs(c); return b ? units / b : units; };

console.log('=== 0. 总量 ===');
const tot = od.length, rejRows = od.filter(d => d.rej).length;
const totFs = od.reduce((a, d) => a + d.firstDayShort, 0);
const rejFs = od.filter(d => d.rej).reduce((a, d) => a + d.firstDayShort, 0);
console.log(`行数 ${tot}，含拒绝原因 ${rejRows} (${(rejRows / tot * 100).toFixed(2)}%)`);
console.log(`首日缺货 合计 ${totFs.toLocaleString()} 支，其中拒绝 ${rejFs.toLocaleString()} 支 (${(rejFs / totFs * 100).toFixed(2)}%)`);
console.log('拒绝原因取值：', JSON.stringify([...new Set(od.filter(d => d.rej).map(d => d.rej))]));

console.log('\n=== 1. 日订单满足率 hover「未清箱数 TOP3」2026-09-21（全部 RDC） ===');
for (const ch of ['KA', '经销商']) {
  const f = od.filter(d => d.dateStr === '2026-09-21' && d.channel === ch && d.firstDayShort > 0);
  const m = {};
  f.forEach(d => {
    const k = d.skuCode;
    m[k] = m[k] || { sku: k, name: d.skuName, units: 0, rejUnits: 0, rejOrders: new Set() };
    m[k].units += d.firstDayShort;
    if (d.rej) { m[k].rejUnits += d.firstDayShort; m[k].rejOrders.add(d.orderNo); }
  });
  const arr = Object.values(m).sort((a, b) => b.units - a.units).slice(0, 3);
  console.log(`-- ${ch} 当日未清 >0 的 SKU 数 = ${Object.keys(m).length}`);
  arr.forEach((x, i) => {
    const bx = boxes(x.units, x.sku), rbx = boxes(x.rejUnits, x.sku);
    console.log(`   ${i + 1}. ${x.sku} ${x.name.slice(0, 12)}  未清 ${Math.ceil(bx)} 箱${x.rejUnits > 0 ? `  ← 其中已拒绝 ${Math.ceil(rbx)} 箱（${x.rejOrders.size} 单，${(rbx / bx * 100).toFixed(0)}%）` : ''}  [箱规 ${bs(x.sku) || '缺失'}]`);
  });
}

console.log('\n=== 2. 缺货分析清单（8月+9月，SKU×RDC 首日缺货 TOP8） ===');
const m2 = {};
od.filter(d => ['2026-08', '2026-09'].includes(d.dateStr.slice(0, 7)) && d.firstDayShort > 0).forEach(d => {
  const k = d.dateStr.slice(0, 7) + '|' + d.skuCode + '|' + d.warehouse;
  m2[k] = m2[k] || { m: d.dateStr.slice(0, 7), sku: d.skuCode, name: d.skuName, wh: d.warehouse, units: 0, rejUnits: 0, rejOrders: new Set(), allOrders: new Set() };
  m2[k].units += d.firstDayShort;
  m2[k].allOrders.add(d.orderNo);
  if (d.rej) { m2[k].rejUnits += d.firstDayShort; m2[k].rejOrders.add(d.orderNo); }
});
const arr2 = Object.values(m2).sort((a, b) => b.units - a.units).slice(0, 8);
arr2.forEach((x, i) => {
  const bx = boxes(x.units, x.sku), rbx = boxes(x.rejUnits, x.sku);
  console.log(`   ${i + 1}. [${x.m}] ${x.sku} ${x.name.slice(0, 10)} @${x.wh} 首日缺货 ${Math.round(bx).toLocaleString()} 箱${x.rejUnits > 0 ? `  ← 含已拒绝 ${Math.round(rbx).toLocaleString()} 箱（${x.rejOrders.size}/${x.allOrders.size} 单，${(rbx / bx * 100).toFixed(1)}%）` : '  （无拒绝）'}`);
});

console.log('\n=== 3. 有「已拒绝」的 SKU×RDC×月 组合占比 ===');
const byKey = {}; const kk = k => k;
Object.values(m2).forEach(() => { });
const all = {};
od.filter(d => d.firstDayShort > 0).forEach(d => {
  const k = d.dateStr.slice(0, 7) + '|' + d.skuCode + '|' + d.warehouse;
  all[k] = all[k] || { units: 0, rej: 0 };
  all[k].units += d.firstDayShort;
  if (d.rej) all[k].rej += d.firstDayShort;
});
const keys = Object.keys(all);
const withRej = keys.filter(k => all[k].rej > 0);
console.log(`组合总数 ${keys.length}，其中含已拒绝 ${withRej.length} (${(withRej.length / keys.length * 100).toFixed(1)}%)`);
console.log(`这些组合的首日缺货 ${withRej.reduce((a, k) => a + all[k].units, 0).toLocaleString()} 支，其中拒绝 ${withRej.reduce((a, k) => a + all[k].rej, 0).toLocaleString()} 支`);

console.log('\n=== 4. 逐月（拒绝在首日缺货里的占比）===');
const bt = {};
od.filter(d => d.firstDayShort > 0).forEach(d => {
  const m = d.dateStr.slice(0, 7);
  bt[m] = bt[m] || { u: 0, r: 0, n: 0, rn: 0 };
  bt[m].u += d.firstDayShort; bt[m].n++;
  if (d.rej) { bt[m].r += d.firstDayShort; bt[m].rn++; }
});
Object.keys(bt).sort().forEach(m => {
  console.log(`   ${m}  首日缺货 ${bt[m].u.toLocaleString()} 支 / 拒绝 ${bt[m].r.toLocaleString()} 支 = ${(bt[m].r / bt[m].u * 100).toFixed(2)}%   （行 ${bt[m].rn}/${bt[m].n}）`);
});

console.log('\n=== 5. 补货建议窗口缺货（到货日起 4 天，取一例）9月 华中RDC ===');
const win = {};
od.filter(d => d.warehouse === '华中RDC' && d.dateStr >= '2026-09-01' && d.dateStr <= '2026-09-21' && d.firstDayShort > 0).forEach(d => {
  win[d.skuCode] = win[d.skuCode] || { name: d.skuName, u: 0, r: 0 };
  win[d.skuCode].u += d.firstDayShort;
  if (d.rej) win[d.skuCode].r += d.firstDayShort;
});
Object.values(win).sort((a, b) => b.u - a.u).slice(0, 5).forEach((x, i) => {
  console.log(`   ${i + 1}. ${x.name.slice(0, 12)}  窗口缺货 ${x.u.toLocaleString()} 支，其中拒绝 ${x.r.toLocaleString()} 支 (${(x.r / x.u * 100).toFixed(1)}%)`);
});
