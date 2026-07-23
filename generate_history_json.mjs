// 历史数据预转换脚本：解析 history-template.xlsx（6月库存分析模版）
// 产出 history.json，供看板做「月度订单满足率历史同比」与「库存周转2025历史化」分析。
// 用法（项目根目录）： node generate_history_json.mjs
// 并入 manifest.json（合并模式，不覆盖 data.json/inventory.json 的哈希）。

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/xlsx');

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'history-template.xlsx');

// RDC 名称归一
const RDC_FULFILL = {
  '东北RDC分仓': '东北RDC', '华北RDC分仓': '华北RDC', '华南RDC分仓': '华南RDC',
  '华中RDC分仓': '华中RDC', '西北RDC分仓': '西北RDC', '西南RDC分仓': '西南RDC'
};
const RDC_INV = {
  '东北': '东北RDC', '华北': '华北RDC', '华东': '华东RDC', '华南': '华南RDC',
  '华中': '华中RDC', '西北': '西北RDC', '西南': '西南RDC', '总仓': '总仓'
};
const RDC_INV_RDCONLY = {
  '东北': '东北RDC', '华北': '华北RDC', '华东': '华东RDC', '华南': '华南RDC',
  '华中': '华中RDC', '西北': '西北RDC', '西南': '西南RDC'
};

function getSheet(wb, name) {
  return wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true }) : null;
}
function parseNum(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/千/g, '').replace(/,/g, '').replace(/[^0-9.\-]/g, '');
  if (s === '') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function numArr(row, startCol, len) {
  const a = [];
  for (let c = startCol; c < startCol + len; c++) {
    const v = row ? row[c] : null;
    a.push(parseNum(v));
  }
  return a;
}
function findRow(arr, substr) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] && arr[i].some(c => c != null && String(c).includes(substr))) return i;
  }
  return -1;
}
// 从表头行向下，连续解析带 RDC 标签的行（标签列 labelCol，值从 valStart 起 valLen 个）
function parseRdcBlock(arr, headerSubstr, labelCol, valStart, valLen, labelMap, maxRows) {
  const hdr = findRow(arr, headerSubstr);
  if (hdr < 0) return {};
  const out = {};
  let cnt = 0;
  for (let i = hdr + 1; i < arr.length && cnt < (maxRows || 20); i++) {
    const r = arr[i];
    if (!r) continue;
    const lab = r[labelCol] != null ? String(r[labelCol]).trim() : '';
    if (labelMap[lab]) {
      out[labelMap[lab]] = numArr(r, valStart, valLen);
      cnt++;
    } else if (cnt > 0) {
      break; // 遇到非标签行即结束当前块
    }
  }
  return out;
}

// ============ 1. 订单满足率 ============
function parseFulfillment(wb) {
  const sh = getSheet(wb, '订单满足率');
  if (!sh) return null;
  const out = { '2025': { daily: {}, monthly: {} }, '2026': { daily: {}, monthly: {} } };
  for (let i = 0; i < sh.length; i++) {
    const r = sh[i];
    if (!r) continue;
    const head = r[0];
    if (head === '日订单满足率' || head === '月订单满足率') {
      const type = head === '日订单满足率' ? 'daily' : 'monthly';
      const yrRow = sh[i - 1];
      const year = yrRow && yrRow[1] ? String(yrRow[1]).trim() : null;
      if (year !== '2025' && year !== '2026') continue;
      const block = {};
      for (let j = i + 1; j < i + 7; j++) {
        const rr = sh[j];
        if (!rr) continue;
        const lab = rr[0];
        if (RDC_FULFILL[lab]) block[RDC_FULFILL[lab]] = numArr(rr, 1, 12);
      }
      out[year][type] = block;
    }
  }
  return out;
}

// ============ 2. 2025 库存（全年12月） ============
function parseInventory2025(wb) {
  const sh = getSheet(wb, '2025');
  if (!sh) return null;
  const turnoverDays = { allLocation: [], shared: [], headquarters: [], rdc: {}, rdcShared: {} };
  const inventoryAmount = {};
  const shipmentCost = {};
  for (const r of sh) {
    if (!r) continue;
    if (r[0] === 'RDC周转天数（全库位）') turnoverDays.allLocation = numArr(r, 1, 12);
    else if (r[0] === 'RDC周转天数（共享仓）') turnoverDays.shared = numArr(r, 1, 12);
    else if (r[0] === '总仓') turnoverDays.headquarters = numArr(r, 1, 12);
  }
  turnoverDays.rdc = parseRdcBlock(sh, 'RDC全库位库存周转天数', 0, 1, 12, RDC_INV_RDCONLY, 6);
  turnoverDays.rdcShared = parseRdcBlock(sh, 'RDC共享库位库存周转天数', 0, 1, 12, RDC_INV_RDCONLY, 6);
  // 库存金额 / 出货成本 均在右侧区块（标签 col14，值 col15-26）；用表头行隔开两区，避免互相覆盖
  Object.assign(inventoryAmount, parseRdcBlock(sh, '库存金额统计', 14, 15, 12, RDC_INV, 8));
  Object.assign(shipmentCost, parseRdcBlock(sh, '出货成本统计', 14, 15, 12, RDC_INV, 8));
  return { months: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'], turnoverDays, inventoryAmount, shipmentCost };
}

// ============ 3. 2026 库存（1-6月） ============
function parseInventory2026(wb) {
  const sh = getSheet(wb, '2026');
  if (!sh) return null;
  const turnoverDays = { allLocation: [], shared: [], headquarters: [], rdc: {}, rdcShared: {} };
  const inventoryAmount = {};
  const shipmentCost = {};
  for (const r of sh) {
    if (!r) continue;
    if (r[0] === 'RDC（全库位）') turnoverDays.allLocation = numArr(r, 1, 6);
    else if (r[0] === 'RDC（共享仓）') turnoverDays.shared = numArr(r, 1, 6);
    else if (r[0] === '总仓') turnoverDays.headquarters = numArr(r, 1, 6);
  }
  turnoverDays.rdc = parseRdcBlock(sh, 'RDC全库位库存周转天数', 0, 1, 6, RDC_FULFILL, 6);
  turnoverDays.rdcShared = parseRdcBlock(sh, 'RDC共享库位库存周转天数', 0, 1, 6, RDC_INV_RDCONLY, 6);
  // 库存金额在右区块（标签 col8，值 col9-14）；出货成本同批行但标签亦在 col8（与共享周转交错），靠表头隔开
  Object.assign(inventoryAmount, parseRdcBlock(sh, '库存金额统计', 8, 9, 6, RDC_INV, 8));
  Object.assign(shipmentCost, parseRdcBlock(sh, '出货成本统计', 8, 9, 6, RDC_INV, 8));
  return { months: ['1月','2月','3月','4月','5月','6月'], turnoverDays, inventoryAmount, shipmentCost };
}

// ============ 4. 海南花露水历史数据 (2025-01~2026-04) ============
// 数据源：inventory.xlsx 的「海南花露水历史数据」sheet
// 列：日期 / RDC / 库存地点名称 / 产品名称 / 产品编码 / 库存金额_考核 / 库存数量 / 状态
// 输出：按 (年, RDC) 聚合库存金额（千元），每月一个值；共 16 个月 (2025-01~2026-04)
// Excel 日期序列号（1900 系统）→ Date
function excelSerialToDate(serial) {
  // Excel 1900-based: serial 1 = 1900-01-01, 但 Excel 假装 1900 是闰年，实际到 60 之后才一致
  // 这里用标准转换：UTC 1899-12-30 + serial 天数
  const ms = (Number(serial) - 25569) * 86400 * 1000;
  return new Date(ms);
}
function parseHainanHistory(invWb) {
  const sh = invWb.Sheets['海南花露水历史数据'];
  if (!sh) return null;
  const arr = XLSX.utils.sheet_to_json(sh, { header: 1, defval: null, raw: true });
  // 月份 key → (年, RDC) → 金额合计(元)
  const out = { '2025': {}, '2026': {} };
  const monthKeys = [];
  for (let i = 1; i < arr.length; i++) {
    const r = arr[i];
    if (!r) continue;
    const date = r[0];
    let dt = null;
    if (date instanceof Date) dt = date;
    else if (typeof date === 'number' && date > 1000) dt = excelSerialToDate(date);
    if (!dt) continue;
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const monthKey = y + '-' + (m < 10 ? '0' : '') + m;
    if (monthKeys.indexOf(monthKey) < 0) monthKeys.push(monthKey);
    // RDC 推断：优先用 r[1] 标签列；为空则从 r[2] 库存地点名按关键字推断
    let rdcLabel = r[1] != null ? String(r[1]).trim() : '';
    if (!rdcLabel) {
      const loc = r[2] != null ? String(r[2]) : '';
      for (const kw of ['东北', '华北', '华南', '华东', '华中', '西北', '西南']) {
        if (loc.indexOf(kw) >= 0) { rdcLabel = kw + '仓'; break; }
      }
      // 跳过"总仓/东莞RDC"等非目标库位（这些不是 RDC 月末库存口径）
      if (!rdcLabel || rdcLabel === '总仓') continue;
    }
    if (rdcLabel.indexOf('总仓') >= 0) continue;
    const rdcName = rdcLabel.replace('仓', 'RDC');
    const amt = parseNum(r[5]) || 0;
    if (!out[y]) out[y] = {};
    if (!out[y][rdcName]) out[y][rdcName] = {};
    out[y][rdcName][monthKey] = (out[y][rdcName][monthKey] || 0) + amt;
  }
  // 转换为按 12/4 个月的有序数组（元）
  function toArr(monthDict, year) {
    const endMonth = year === '2025' ? 12 : 4;
    const rdcArr = {};
    Object.keys(monthDict).forEach(function (rdcName) {
      const arr = new Array(endMonth).fill(0);
      Object.keys(monthDict[rdcName]).forEach(function (mk) {
        const m = parseInt(mk.split('-')[1], 10) - 1;
        if (m >= 0 && m < endMonth) arr[m] = monthDict[rdcName][mk];
      });
      rdcArr[rdcName] = arr.map(v => Math.round(v / 10) / 100); // 元→千元，保留两位小数
    });
    return rdcArr;
  }
  return {
    months2025: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'],
    months2026: ['1月','2月','3月','4月'],
    byRdc: { '2025': toArr(out['2025'], '2025'), '2026': toArr(out['2026'], '2026') }
  };
}

// ============ 主流程 ============
function main() {
  if (!fs.existsSync(SRC)) {
    console.error('未找到 history-template.xlsx，请在项目根目录运行。');
    process.exit(1);
  }
  const wb = XLSX.read(fs.readFileSync(SRC), { type: 'array' });

  const fulfillment = parseFulfillment(wb);
  const inv2025 = parseInventory2025(wb);
  const inv2026 = parseInventory2026(wb);

  // 额外读取 inventory.xlsx 中的「海南花露水历史数据」
  let hainanHistory = null;
  const invPath = path.join(ROOT, 'inventory.xlsx');
  if (fs.existsSync(invPath)) {
    const invWb = XLSX.read(fs.readFileSync(invPath), { type: 'array' });
    hainanHistory = parseHainanHistory(invWb);
    console.log('   海南花露水历史数据 已加载 (2025/2026按RDC聚合)');
  } else {
    console.log('   (未找到 inventory.xlsx，跳过海南花露水历史数据)');
  }

  const history = {
    generatedAt: new Date().toISOString(),
    fulfillment,
    inventory: { '2025': inv2025, '2026': inv2026 }
  };
  if (hainanHistory) history.hainanHistory = hainanHistory;

  fs.writeFileSync(path.join(ROOT, 'history.json'), JSON.stringify(history));
  console.log('   history.json 已生成');
  for (const y of ['2025', '2026']) {
    const f = fulfillment[y];
    const inv = history.inventory[y];
    console.log(`   ${y}: 满足率RDC=${Object.keys(f.daily)} 库存金额RDC=${Object.keys(inv.inventoryAmount)} 出货成本RDC=${Object.keys(inv.shipmentCost)}`);
  }
  if (hainanHistory) {
    console.log(`   海南花露水: 2025 RDC=${Object.keys(hainanHistory.byRdc['2025'])} 2026 RDC=${Object.keys(hainanHistory.byRdc['2026'])}`);
  }

  const manifestPath = path.join(ROOT, 'manifest.json');
  let manifest = { generatedAt: history.generatedAt, files: {} };
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); manifest.files = manifest.files || {}; } catch (e) {}
  }
  manifest.files['history.json'] = crypto.createHash('sha256').update(fs.readFileSync(SRC)).digest('hex');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('   manifest.json 已合并 history.json 哈希');
}

main();
