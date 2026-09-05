// 模拟验证 rdc-dashboard.html v202 新增逻辑（用真实生成的 JSON 数据）
const fs = require('fs');
const inv = JSON.parse(fs.readFileSync('inventory.json', 'utf8'));
const extra = JSON.parse(fs.readFileSync('inventory-extra.json', 'utf8'));
const ts = JSON.parse(fs.readFileSync('transship.json', 'utf8'));

function findByName(sheets, kw) {
  const n = sheets.sheetNames.find(x => String(x || '').includes(kw));
  return n ? sheets.sheets[n] : null;
}
const baseArr = findByName(inv, '基础数据');
const planArr = findByName(inv, '分仓计划');
const cov7Arr = findByName(inv, '7月库存覆盖数据');
const pbRaw = findByName(extra, '拉回数据');
const cov5Arr = findByName(extra, '5月库存覆盖数据');
const cov6Arr = findByName(extra, '6月库存覆盖数据');

let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('  PASS', name, extra || ''); } else { fail++; console.log('  FAIL', name, extra || ''); } }

// ---- 1) block C 产品主数据解析（复刻新增代码） ----
const cHeader = baseArr[0] || [];
function cColIdx(name) { for (let i = cHeader.length - 1; i >= 0; i--) { if (String(cHeader[i] || '').trim() === name) return i; } return -1; }
const C2_CODE = cColIdx('产品编码'), C2_ABC = cColIdx('ABC分类'), C2_CAT = cColIdx('供应链品类'), C2_CATEGORY = cColIdx('品类'), C2_PROMO = cColIdx('是否为软切新品'), C2_LIFE = cColIdx('生命周期标签'), C2_SPEC = cColIdx('箱规转化因子');
const _sc = {}, _life = {}, _promo = {}, _abc = {}, _cat = {}, _box = {};
for (let i = 1; i < baseArr.length; i++) {
  const r = baseArr[i]; if (!r || C2_CODE < 0 || !r[C2_CODE]) continue;
  const sku = String(r[C2_CODE]).trim(); if (!sku) continue;
  const vCat = C2_CAT >= 0 ? String(r[C2_CAT] || '').trim() : ''; if (vCat) _sc[sku] = vCat;
  const vLife = C2_LIFE >= 0 ? String(r[C2_LIFE] || '').trim() : ''; if (vLife) _life[sku] = vLife;
  const vPromo = C2_PROMO >= 0 ? String(r[C2_PROMO] || '').trim() : ''; _promo[sku] = (vPromo === '是' || vPromo === 'Y' || vPromo === 'TRUE');
  const vAbc = C2_ABC >= 0 ? String(r[C2_ABC] || '').trim() : ''; if (vAbc) _abc[sku] = vAbc;
  const vCat2 = C2_CATEGORY >= 0 ? String(r[C2_CATEGORY] || '').trim() : ''; if (vCat2) _cat[sku] = vCat2;
  const vSpec = C2_SPEC >= 0 ? Number(r[C2_SPEC]) : NaN; if (!isNaN(vSpec) && vSpec > 0) _box[sku] = vSpec;
}
console.log('[1] block C 产品主数据（按 block C 自身产品编码 建键）：');
check('供应链品类 map > 5000', Object.keys(_sc).length > 5000, '=' + Object.keys(_sc).length);
check('生命周期 map > 10000', Object.keys(_life).length > 10000, '=' + Object.keys(_life).length);
check('箱规 map > 5000', Object.keys(_box).length > 5000, '=' + Object.keys(_box).length);
check('ABC map > 10000', Object.keys(_abc).length > 10000, '=' + Object.keys(_abc).length);
const sampleSku = '09539';
check('样本SKU 09539 供应链品类 != 非卖品(错挂修正)', _sc[sampleSku] && _sc[sampleSku] !== '非卖品', '=' + _sc[sampleSku]);
check('样本SKU 09539 箱规有值', !!_box[sampleSku], '=' + _box[sampleSku]);
check('样本SKU 09539 生命周期有值', !!_life[sampleSku], '=' + _life[sampleSku]);
check('样本SKU 09555 供应链品类=非卖品(block C 正确归属)', _sc['09555'] === '非卖品', '=' + _sc['09555']);

// ---- 2) planBySkuRdc 解析（复刻新增代码） ----
const ph = planArr[0] || [];
function pCol(n) { for (let i = 0; i < ph.length; i++) { if (String(ph[i] || '').trim() === n) return i; } return -1; }
const P_CODE = pCol('产品 Code'), P_WH = pCol('计划仓 Name');
const MONTHS = ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01'].map(m => ({ m, idx: pCol(m) }));
const planBySkuRdc = {};
for (let i = 1; i < planArr.length; i++) {
  const r = planArr[i]; if (!r) continue;
  const sku = String(r[P_CODE] || '').trim(); if (!sku) continue;
  const wh = String(r[P_WH] || '').trim(); if (!wh) continue;
  const rdc = wh.replace(/仓$/, '') + 'RDC';
  if (!planBySkuRdc[sku]) planBySkuRdc[sku] = {};
  if (!planBySkuRdc[sku][rdc]) planBySkuRdc[sku][rdc] = {};
  MONTHS.forEach(mc => { if (mc.idx >= 0) { const v = Number(r[mc.idx]); if (!isNaN(v)) planBySkuRdc[sku][rdc][mc.m] = v; } });
}
console.log('[2] planBySkuRdc：');
check('SKU 数 > 400 (2435行÷~6RDC)', Object.keys(planBySkuRdc).length > 400, '=' + Object.keys(planBySkuRdc).length);
check('样本 09539/华南RDC/2026-09=4034', planBySkuRdc['09539'] && planBySkuRdc['09539']['华南RDC'] && planBySkuRdc['09539']['华南RDC']['2026-09'] === 4034, JSON.stringify(planBySkuRdc['09539'] && planBySkuRdc['09539']['华南RDC']));
check('样本 09539/华北RDC/2026-09=1247', planBySkuRdc['09539'] && planBySkuRdc['09539']['华北RDC'] && planBySkuRdc['09539']['华北RDC']['2026-09'] === 1247);

// ---- 3) getPlanDemand（复刻新增函数） ----
function getPlanDemand(sku, rdc, targetField) {
  const pb = planBySkuRdc;
  if (!pb || !sku || !rdc) return undefined;
  const COV_TO_YM = { cov06: '2026-06', cov07: '2026-07', cov08: '2026-08', cov09: '2026-09', cov10: '2026-10', cov11: '2026-11', cov12: '2026-12', cov13: '2027-01' };
  const ym = COV_TO_YM[targetField];
  if (!ym) return undefined;
  const byRdc = pb[sku]; if (!byRdc) return undefined;
  const byYm = byRdc[rdc]; if (!byYm || !(ym in byYm)) return undefined;
  return byYm[ym];
}
console.log('[3] getPlanDemand：');
check('09539/华南RDC/cov09=4034', getPlanDemand('09539', '华南RDC', 'cov09') === 4034);
check('09539/华南RDC/cov06=undefined(回退cov7)', getPlanDemand('09539', '华南RDC', 'cov06') === undefined);
check('不存在SKU/cov09=undefined', getPlanDemand('ZZZZ', '华南RDC', 'cov09') === undefined);
check('09539/华南RDC/cov13=1535', getPlanDemand('09539', '华南RDC', 'cov13') === 1535);

// ---- 4) transship.json 加载（applyPreparsed transship 分支） ----
console.log('[4] transship.json：');
check('transship 条目=7267', (ts.transship || []).length === 7267, '=' + (ts.transship || []).length);
const t0 = (ts.transship || [])[0];
check('条目含 dateStr/rdc/material/location', !!(t0 && t0.dateStr && t0.rdc && t0.material && t0.location), JSON.stringify(t0));
check('条目含 transType', !!(t0 && t0.transType), t0 && t0.transType);

// ---- 5) inventory-extra.json 内容（合并加载源） ----
console.log('[5] inventory-extra.json：');
check('含 拉回数据 sheet', !!pbRaw, 'rows=' + (pbRaw ? pbRaw.length : 0));
check('含 5月库存覆盖数据 sheet', !!cov5Arr);
check('含 6月库存覆盖数据 sheet', !!cov6Arr);
check('拉回数据有表头以外行', pbRaw && pbRaw.length > 1, 'rows=' + (pbRaw ? pbRaw.length : 0));

// ---- 6) 合并装配逻辑（复刻 _keep） ----
console.log('[6] 合并装配 _keep：');
function _keep(val, prevVal, kind) {
  if (kind === 'arr') return (val && val.length) ? val : (prevVal || val);
  if (kind === 'obj') return (val && Object.keys(val).length) ? val : (prevVal || val);
  return (val != null) ? val : (prevVal != null ? prevVal : val);
}
const prev = { cov7: [1, 2, 3], productMaster: { a: 1 }, planBySkuRdc: { x: 1 }, pullbackRows: [] };
const extraComputed = { cov5: [4], cov6: [5], pullbackRows: [7, 8, 9], pullbackByRdcMonth: { k: 1 } };
const merged = {
  cov7: _keep(prev.cov7, extraComputed.cov7, 'arr'),
  productMaster: _keep(prev.productMaster, extraComputed.productMaster, 'obj'),
  planBySkuRdc: _keep(prev.planBySkuRdc, extraComputed.planBySkuRdc, 'obj'),
  cov5: _keep(extraComputed.cov5, prev.cov5, 'arr'),
  cov6: _keep(extraComputed.cov6, prev.cov6, 'arr'),
  pullbackRows: _keep(extraComputed.pullbackRows, prev.pullbackRows, 'arr'),
  pullbackByRdcMonth: _keep(extraComputed.pullbackByRdcMonth, prev.pullbackByRdcMonth, 'obj'),
};
check('合并后 cov7 保留首屏值', merged.cov7.length === 3, 'len=' + merged.cov7.length);
check('合并后 productMaster 保留首屏值', Object.keys(merged.productMaster).length === 1);
check('合并后 planBySkuRdc 保留首屏值', !!merged.planBySkuRdc.x);
check('合并后 cov5 来自 extra', merged.cov5.length === 1);
check('合并后 cov6 来自 extra', merged.cov6.length === 1);
check('合并后 pullbackRows 来自 extra', merged.pullbackRows.length === 3, 'len=' + merged.pullbackRows.length);

console.log('\\n==== 结果: PASS=' + pass + ' FAIL=' + fail + ' ====');
process.exit(fail > 0 ? 1 : 0);
