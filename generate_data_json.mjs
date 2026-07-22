// 数据预转换脚本：将 xlsx 预解析为行化 JSON，网页加载时跳过 SheetJS 解压/解析，大幅提升打开速度。
// 用法（在项目根目录执行）：
//   node generate_data_json.mjs
// 依赖：xlsx@0.18.5（须与网页 CDN 版本一致，保证 sheet_to_json 行化结果一致）
// 产物：每个 <name>.xlsx 生成 <name>.json + manifest.json（含各源文件 sha256）
// 注意：保留原 xlsx 不删除，网页端 JSON 异常时自动回退到 xlsx。

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';

// xlsx 安装在托管 node workspace，用绝对路径 require（ESM 不走 NODE_PATH）
const require = createRequire(import.meta.url);
const XLSX = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/xlsx');

const ROOT = process.cwd();

// 与网页端 sheet_to_json 选项保持一致（raw:true 时 dateNF 无效，故一致）
const SHEET_OPTS = { header: 1, defval: null, raw: true };

// 需要转换的源文件（排除备份文件）
function findSources() {
  const files = fs.readdirSync(ROOT).filter(f => {
    const lower = f.toLowerCase();
    if (lower.includes('backup')) return false;
    return /^data.*\.xlsx$/i.test(f) || /^inventory\.xlsx$/i.test(f);
  });
  return files.sort();
}

function sha256File(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 读取产品主数据（产品.xlsx），构建 物料号 -> 每箱支数(箱规转化因子) 映射
// 列定位：第1列(A)=产品编码，第35列(AI)=箱规转化因子
function buildBoxSpecMap() {
  const p = path.join(ROOT, '产品.xlsx');
  if (!fs.existsSync(p)) { console.log('   (未找到 产品.xlsx，boxSpecMap 为空)'); return {}; }
  const wb = XLSX.read(fs.readFileSync(p), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const arr = XLSX.utils.sheet_to_json(ws, SHEET_OPTS);
  const map = {};
  for (let i = 1; i < arr.length; i++) {
    const row = arr[i];
    if (!row || row.length < 35) continue;
    const code = String(row[0] != null ? row[0] : '').trim();
    const fac = row[34]; // 第35列(AI) 箱规转化因子
    if (code && fac != null && fac !== '') {
      const n = Number(fac);
      if (!isNaN(n) && n > 0) map[code] = n;
    }
  }
  console.log('   boxSpecMap 命中 ' + Object.keys(map).length + ' 个SKU');
  return map;
}

function main() {
  const sources = findSources();
  if (sources.length === 0) {
    console.error('未找到 data*.xlsx / inventory.xlsx，请在项目根目录运行。');
    process.exit(1);
  }

  const manifest = { generatedAt: new Date().toISOString(), files: {} };
  let totalRows = 0;

  for (const src of sources) {
    const srcPath = path.join(ROOT, src);
    const base = src.replace(/\.xlsx$/i, '');
    const outJson = base + '.json';

    console.log(`→ 转换 ${src} ...`);
    const wb = XLSX.read(fs.readFileSync(srcPath), { type: 'array' });
    const sheets = {};
    wb.SheetNames.forEach(name => {
      const arr = XLSX.utils.sheet_to_json(wb.Sheets[name], SHEET_OPTS);
      sheets[name] = arr;
      totalRows += arr.length;
    });

    const payload = { sheetNames: wb.SheetNames, sheets };
    if (base === 'data') payload.boxSpecMap = buildBoxSpecMap();
    fs.writeFileSync(path.join(ROOT, outJson), JSON.stringify(payload));
    // manifest 以「源 xlsx 内容哈希」为键，仅当真实数据变化时才触发网页重新解析
    manifest.files[outJson] = sha256File(srcPath);
    console.log(`   ${outJson}   sheets=${wb.SheetNames.length}  rows=${totalRows}`);
    totalRows = 0; // 仅用于日志，每行文件重置
  }

  // history.json 单独纳入 manifest：看板按 manifest 加载预解析文件，若缺 history.json
  // 则 dataStore.history 恒为 null，导致「库存金额趋势/出货成本趋势(2025 vs 2026)」及
  // 「订单满足率历史趋势」等历史图表全部空白。哈希直接取自 history.json 内容本身。
  const historyJson = path.join(ROOT, 'history.json');
  if (fs.existsSync(historyJson)) {
    manifest.files['history.json'] = sha256File(historyJson);
    console.log('   history.json 已纳入 manifest（历史趋势图数据源）');
  } else {
    console.log('   (未找到 history.json，跳过；历史趋势图将空白)');
  }

  fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n✅ 完成。manifest.json 含 ${Object.keys(manifest.files).length} 个数据文件哈希。`);
  console.log('   网页将优先加载 JSON；哈希未变时直接复用本地缓存，秒开。');
}

main();
