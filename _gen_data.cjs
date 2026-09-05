// 从 8月库存分析模版.xlsx 生成部署用 JSON 数据文件
// 拆分策略（首屏友好 + 修复 v198 dead-route）：
//   inventory.json        : 首屏 sheet（含 基础数据[含 block C 产品主数据] + 分仓计划）
//   inventory-status.json  : 5/6/7月库存状态分析（按需懒加载）
//   transship.json         : 转储数据（已解析为 transship 条目，ensureTransship 直接消费）
// 注：拉回数据 / 5月6月覆盖 走 inventory-extra.json（由 rdc-dashboard.html 合并解析），本脚本不产 inventory-extra.json。
const XLSX = require('xlsx');
const fs = require('fs');

const SRC = 'C:/Users/zhangyufei1/Desktop/更新部署/8月库存分析模版.xlsx';
const OUT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';

const wb = XLSX.read(fs.readFileSync(SRC), { type: 'buffer', cellDates: true });
const allNames = wb.SheetNames;

function sheetArr(name) {
  const sh = wb.Sheets[name];
  if (!sh) throw new Error('sheet 缺失: ' + name);
  return XLSX.utils.sheet_to_json(sh, { header: 1, defval: null, raw: true, blankrows: false });
}
function writeJson(name, sheetNames, sheets) {
  const payload = { sheetNames: sheetNames, sheets: sheets };
  const buf = JSON.stringify(payload);
  fs.writeFileSync(OUT + '/' + name, buf);
  return (Buffer.byteLength(buf) / 1048576).toFixed(2) + 'MB';
}

// ---------- 1) inventory.json（首屏） ----------
const invSheets = ['订单满足率', '2026周转', '2025周转', '库存金额', '库存覆盖', '7月库存覆盖数据', '基础数据', '分仓计划'];
const invSheetsObj = {};
invSheets.forEach(n => { invSheetsObj[n] = sheetArr(n); });
const invSize = writeJson('inventory.json', invSheets, invSheetsObj);
console.log('inventory.json =>', invSheets.join(' | '), '=>', invSize);

// ---------- 2) inventory-status.json（懒加载） ----------
const statusSheets = ['5月库存状态分析', '6月库存状态分析', '7月库存状态分析'];
const statusSheetsObj = {};
statusSheets.forEach(n => { statusSheetsObj[n] = sheetArr(n); });
const statusSize = writeJson('inventory-status.json', statusSheets, statusSheetsObj);
console.log('inventory-status.json =>', statusSheets.join(' | '), '=>', statusSize);

// ---------- 2b) inventory-extra.json（懒加载：拉回数据 + 5月/6月覆盖；不含 转储数据，转储已独立到 transship.json） ----------
const extraSheets = ['5月库存覆盖数据', '6月库存覆盖数据', '拉回数据'];
const extraSheetsObj = {};
extraSheets.forEach(n => { extraSheetsObj[n] = sheetArr(n); });
const extraSize = writeJson('inventory-extra.json', extraSheets, extraSheetsObj);
console.log('inventory-extra.json =>', extraSheets.join(' | '), '=>', extraSize);

// ---------- 3) transship.json（转储数据 → 已解析条目） ----------
// 复刻 rdc-dashboard.html 中 parseInventoryExcel 的「转储」解析块（适配新模板表头：PO数量 无空格）
function normalizeDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  if (typeof val === 'number') {
    const d = new Date((val - 25569) * 86400 * 1000);
    if (!isNaN(d.getTime())) return d;
  }
  if (typeof val === 'string') {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;
    const m = val.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  return null;
}
function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}
function getSafeNum(row, idx) { const v = row[idx]; if (v == null || v === '' || isNaN(Number(v))) return 0; return Number(v); }
function getSafeStr(row, idx) { const v = row[idx]; return v == null ? '' : String(v).trim(); }

const transArr = sheetArr('转储数据');
const tHeader = transArr[0] || [];
function tColIdx(name) {
  for (let i = 0; i < tHeader.length; i++) { if (String(tHeader[i] || '').trim() === name) return i; }
  return -1;
}
function unitAfter(numCol) {
  for (let i = numCol + 1; i < tHeader.length; i++) { if (String(tHeader[i] || '').trim() === 'OUn') return i; }
  return -1;
}
const C_DATE = tColIdx('创建日期');
const C_LOC = tColIdx('收货库位');
const C_FACTORY = tColIdx('收货工厂');
const C_MAT = tColIdx('物料');
const C_NAME = tColIdx('短文本');
const C_PO = tColIdx('PO 数量');
const C_PLAN = tColIdx('计划数量');
const C_CONFIRM = tColIdx('确认数量');
const C_INVOICE = tColIdx('发货单数量');
const C_SHIPFAC = tColIdx('发货工厂');
const C_INBOUND = tColIdx('入库数量');
const C_DELIVERY = tColIdx('发货过账数量');
const C_UNIT = C_INVOICE >= 0 ? unitAfter(C_INVOICE) : -1;
console.log('[转储] 列映射:', JSON.stringify({ C_DATE, C_LOC, C_FACTORY, C_MAT, C_NAME, C_PO, C_PLAN, C_CONFIRM, C_INVOICE, C_SHIPFAC, C_INBOUND, C_DELIVERY, C_UNIT }));

const transship = [];
const existTk = new Set();
for (let i = 1; i < transArr.length; i++) {
  const r = transArr[i];
  if (!r || r.length < 10) continue;
  const d = normalizeDate(r[C_DATE]);
  if (!d) continue;
  const loc = getSafeStr(r, C_LOC);
  if (!loc || loc.startsWith('30')) continue;
  let rdc = '未知';
  if (loc.startsWith('20')) rdc = '东北RDC';
  else if (loc.startsWith('40')) rdc = '华南RDC';
  else if (loc.startsWith('60')) rdc = '西北RDC';
  else if (loc.startsWith('70')) rdc = '华中RDC';
  else if (loc.startsWith('80')) rdc = '西南RDC';
  else if (loc.startsWith('90')) rdc = '华北RDC';
  let transType = '常规转储';
  if (loc.endsWith('23') || loc.endsWith('06')) transType = '免费单转储';
  else if (loc.endsWith('03')) transType = 'KA常规转储';
  const unit = C_UNIT >= 0 ? getSafeStr(r, C_UNIT) : '';
  const material = getSafeStr(r, C_MAT);
  const dateStr = fmtDate(d);
  const tKey = dateStr + '|' + material + '|' + loc;
  if (existTk.has(tKey)) continue;
  existTk.add(tKey);
  transship.push({
    date: dateStr, dateStr: dateStr,
    location: loc, rdc: rdc, factory: getSafeStr(r, C_FACTORY),
    material: material, materialName: getSafeStr(r, C_NAME),
    poQty: getSafeNum(r, C_PO), planQty: getSafeNum(r, C_PLAN),
    confirmQty: getSafeNum(r, C_CONFIRM), invoiceQty: getSafeNum(r, C_INVOICE),
    unit: unit, isBox: unit === '箱',
    transType: transType,
    shipFactory: getSafeStr(r, C_SHIPFAC),
    inboundQty: getSafeNum(r, C_INBOUND),
    deliveryQty: getSafeNum(r, C_DELIVERY)
  });
}
fs.writeFileSync(OUT + '/transship.json', JSON.stringify({ transship: transship }));
console.log('transship.json => 转储条目:', transship.length, '=>', (Buffer.byteLength(JSON.stringify({ transship })) / 1048576).toFixed(2) + 'MB');

console.log('DONE');
