// 拆分 inventory.json：把「X月库存状态分析」三个 sheet 拆出为 inventory-status.json
// 首屏不再下载/解析这 ~8.4MB / 45669 行（占原文件 84%），根治库存相关页加载慢。
// 用法：node split_inventory.mjs
import fs from 'fs';

const p = 'inventory.json';
const raw = fs.readFileSync(p, 'utf8');
const j = JSON.parse(raw);

const sheetNames = j.sheetNames || [];
const sheets = j.sheets || {};

// 精确匹配「X月库存状态分析」（findByName('5月库存状态') 模糊命中同名）
const statusKeys = sheetNames.filter(n => /月库存状态分析$/.test(n));
if (statusKeys.length !== 3) {
  console.error('期望拆出 3 个状态分析 sheet，实际:', statusKeys);
  process.exit(1);
}

const statusSheets = {};
let statusRows = 0;
statusKeys.forEach(k => {
  statusSheets[k] = sheets[k];
  statusRows += (sheets[k] && sheets[k].length) || 0;
});

// 写 inventory-status.json
fs.writeFileSync('inventory-status.json', JSON.stringify({ sheetNames: statusKeys, sheets: statusSheets }));

// 从 inventory.json 删除
const newSheetNames = sheetNames.filter(n => !statusKeys.includes(n));
const newSheets = {};
newSheetNames.forEach(k => { newSheets[k] = sheets[k]; });
// 备份原文件
fs.copyFileSync(p, p + '.bak');
fs.writeFileSync(p, JSON.stringify({ sheetNames: newSheetNames, sheets: newSheets }));

const origBytes = Buffer.byteLength(raw);
const newBytes = fs.statSync(p).size;
const statusBytes = fs.statSync('inventory-status.json').size;
console.log('拆出 status sheets:', statusKeys.join(' | '));
console.log('status 行数:', statusRows, ' status 字节:', (statusBytes/1048576).toFixed(2)+'MB');
console.log('inventory.json:', (origBytes/1048576).toFixed(2)+'MB -> '+(newBytes/1048576).toFixed(2)+'MB', ' sheets:', sheetNames.length, '->', newSheetNames.length);
console.log('剩余 sheets:', newSheetNames.join(' | '));
