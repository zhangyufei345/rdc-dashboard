const j = require('./data.json');
const boxSpec = j.boxSpecMap || {};
function serialToStr(v) { const d = new Date((v - 25569) * 86400 * 1000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// 当月待发：订单口径
const od = j.sheets['订单明细'];
const orderMap = {}, skuName = {};
for (let i = 1; i < od.length; i++) {
  const r = od[i];
  const sku = String(r[4] || '').trim();
  const rdc = String(r[8] || '').trim().replace(/RDC$/i, '');
  const oq = Number(r[9]) || 0, fq = Number(r[11]) || 0;
  const remaining = Math.max(0, oq - fq);
  const bs = boxSpec[sku];
  const boxes = bs && bs > 0 ? remaining / bs : remaining;
  orderMap[sku + '|' + rdc] = (orderMap[sku + '|' + rdc] || 0) + boxes;
  if (!skuName[sku] && r[5]) skuName[sku] = String(r[5]).trim();
}

// 缺货：最新数据日期
const sh = j.sheets['缺货汇总'];
let maxSerial = -1;
for (let i = 2; i < sh.length; i++) { const s = Number(sh[i][0]); if (s > maxSerial) maxSerial = s; }
const rdcCols = [{name:'华北',idx:13},{name:'西南',idx:15},{name:'东北',idx:17},{name:'华中',idx:19},{name:'华南',idx:21},{name:'华东',idx:23},{name:'西北',idx:25}];
const shortMap = {};
for (let i = 2; i < sh.length; i++) {
  const r = sh[i];
  if (Number(r[0]) !== maxSerial) continue;
  const sku = String(r[1] || '').trim();
  if (!skuName[sku] && r[2]) skuName[sku] = String(r[2]).trim();
  for (const c of rdcCols) {
    const v = Number(r[c.idx]) || 0;
    if (v > 0) shortMap[sku + '|' + c.name] = (shortMap[sku + '|' + c.name] || 0) + v;
  }
}

const allKeys = new Set([...Object.keys(orderMap), ...Object.keys(shortMap)]);
const rows = [];
for (const k of allKeys) {
  const [sku, rdc] = k.split('|');
  const o = orderMap[k] || 0, s = shortMap[k] || 0;
  if (Math.abs(o - s) < 0.001) continue; // 仅保留有差异的行
  rows.push({ sku, name: skuName[sku] || '', rdc, order: Math.round(o*100)/100, short: Math.round(s*100)/100, diff: Math.round((o-s)*100)/100 });
}
rows.sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff));

// 写 CSV
const fs = require('fs');
let csv = '物料号,物料名称,RDC,当月待发(箱),缺货(8-11,箱),差异(待发-缺货)\n';
for (const r of rows) csv += `${r.sku},"${r.name}",${r.rdc},${r.order},${r.short},${r.diff}\n`;
fs.writeFileSync('当月待发_vs_缺货_SKU×RDC明细.csv', '\uFEFF' + csv);
console.log('已生成 CSV，有差异的 SKU×RDC 行数:', rows.length, ' 保存至 当月待发_vs_缺货_SKU×RDC明细.csv');

// 汇总
const onlyShort = rows.filter(r=>r.order===0&&r.short>0);
const onlyOrder = rows.filter(r=>r.short===0&&r.order>0);
console.log('有缺货但待发=0:', onlyShort.length, '个, 缺货', Math.round(onlyShort.reduce((a,r)=>a+r.short,0)), '箱');
console.log('有待发但缺货=0:', onlyOrder.length, '个, 待发', Math.round(onlyOrder.reduce((a,r)=>a+r.order,0)), '箱');
console.log('\nTop15 差异最大:');
console.log('物料号\tRDC\t当月待发\t缺货\t差异');
for (const r of rows.slice(0,15)) console.log(`${r.sku}\t${r.rdc}\t${r.order}\t${r.short}\t${r.diff}`);
