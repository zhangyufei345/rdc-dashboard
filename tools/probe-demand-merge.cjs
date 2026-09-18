// 探针：模拟 ensureDemandMerged 的合并逻辑 + _actualShipOf 查表，验证实际出货口径接入正确。
const fs = require('fs');
const path = require('path');

const ROOT = 'C:\\Users\\zhangyufei1\\WorkBuddy\\2026-06-30-09-24-40';
const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'demand.json'), 'utf8'));

function normSkuCode(s) { s = String(s || ''); return s.replace(/^0+(?=\d)/, ''); }
function normalizeRdcName(name) {
  if (!name) return '';
  const n = name.replace(/仓$/, '').trim();
  const m = { '华南':'华南RDC','华北':'华北RDC','华中':'华中RDC','东北':'东北RDC','西北':'西北RDC','西南':'西南RDC',
    '华南RDC':'华南RDC','华北RDC':'华北RDC','华中RDC':'华中RDC','东北RDC':'东北RDC','西北RDC':'西北RDC','西南RDC':'西南RDC' };
  return m[n] || name;
}

// 模拟合并
const inv = { planBySkuRdc: {}, actualShipBySkuRdc: {} };
const plan = j.plan || {};
let planN = 0;
Object.keys(plan).forEach(sku => {
  const rdcObj = plan[sku] || {};
  if (!inv.planBySkuRdc[sku]) inv.planBySkuRdc[sku] = {};
  Object.keys(rdcObj).forEach(rdc => {
    if (!inv.planBySkuRdc[sku][rdc]) inv.planBySkuRdc[sku][rdc] = {};
    Object.keys(rdcObj[rdc] || {}).forEach(month => {
      const v = rdcObj[rdc][month];
      if (v == null || isNaN(Number(v))) return;
      inv.planBySkuRdc[sku][rdc][month] = Number(v); planN++;
    });
  });
});
const ship = j.actualShip || {};
let shipN = 0;
Object.keys(ship).forEach(sku => {
  const rdcObj = ship[sku] || {};
  if (!inv.actualShipBySkuRdc[sku]) inv.actualShipBySkuRdc[sku] = {};
  Object.keys(rdcObj).forEach(rdc => {
    const nr = normalizeRdcName(rdc);
    const rdcKeys = (nr !== rdc) ? [rdc, nr] : [rdc];
    rdcKeys.forEach(_rdc => {
      if (!inv.actualShipBySkuRdc[sku][_rdc]) inv.actualShipBySkuRdc[sku][_rdc] = {};
      Object.keys(rdcObj[rdc] || {}).forEach(month => {
        const v = rdcObj[rdc][month];
        if (v == null || isNaN(Number(v))) return;
        inv.actualShipBySkuRdc[sku][_rdc][month] = Number(v); shipN++;
      });
    });
  });
});

// 模拟 _actualShipOf (修正版：严格原始码 + rdc归一化)
function _actualShipOf(sku, rdc, month) {
  const m = inv.actualShipBySkuRdc;
  if (!m) return undefined;
  const byRdc = m[sku];
  if (!byRdc) return undefined;
  const nr = normalizeRdcName(rdc || '');
  const rdcKeys = (nr !== rdc) ? [rdc, nr] : [rdc];
  for (const rd of rdcKeys) {
    const row = byRdc[rd]; if (!row) continue;
    const v = row[month];
    if (v != null && !isNaN(Number(v))) return Number(v);
  }
  return undefined;
}

console.log('合并结果：计划月值=' + planN + ' / 实际出货月值(含镜像)=' + shipN);

// 抽查：09865|华北RDC
const t = '2026-09';
console.log('\n[抽查1] 09865|华北RDC (已知: 计划09=30584, 实际出货09=29556)');
console.log('  计划09 =', inv.planBySkuRdc['09865'] && inv.planBySkuRdc['09865']['华北RDC'] && inv.planBySkuRdc['09865']['华北RDC'][t]);
console.log('  实际出货09 原始码 =', _actualShipOf('09865', '华北RDC', t));
console.log('  实际出货09 去零码 =', _actualShipOf('9805', '华北RDC', t));
console.log('  实际出货09 rdc=华北 =', _actualShipOf('09865', '华北', t));
console.log('  实际出货08 (历史月,应回退undefined) =', _actualShipOf('09865', '华北RDC', '2026-08'));

// 抽查：09539|华中RDC (已知 实际出货 8598 vs 已放行 6462 → 用实际出货应得 8598)
console.log('\n[抽查2] 09539|华中RDC (已知 实际出货09=8598)');
console.log('  实际出货09 =', _actualShipOf('09539', '华中RDC', t));

// 统计实际出货覆盖的 SKU×仓数
let cov = 0;
Object.keys(inv.actualShipBySkuRdc).forEach(s => Object.keys(inv.actualShipBySkuRdc[s]).forEach(r => { if (inv.actualShipBySkuRdc[s][r][t] != null) cov++; }));
console.log('\n实际出货覆盖 SKU×仓(09) =', cov, '(demand.json 原始=' + Object.keys(j.actualShip).length + ' SKU)');
