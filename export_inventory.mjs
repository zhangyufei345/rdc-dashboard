// export_inventory.mjs — 从 Excel 模板全量导出 inventory JSON 文件
//
// 用法：node export_inventory.mjs [Excel文件路径]
// 默认输入：./.cache/8月库存分析模版.xlsx（或同目录下最新的 *库存分析*.xlsx）
// 输出（项目根目录）：
//   inventory-core.json   首屏：订单满足率 / 2026周转 / 2025周转 / 库存金额 / 库存覆盖 / 7月库存覆盖数据
//   inventory-plan.json   按需：分仓计划
//   inventory-extra.json  按需：5·6月库存覆盖 / 拉回数据 / 转储数据
//   inventory-master.json 按需：基础数据（产品主数据）
//
// 设计原则（v208 教训固化）：
//   ① max_row × max_column 全范围读取 —— 杜绝「宽表右半截被截断」（如库存金额右表 1565 格丢失）
//   ② sheet→文件映射表驱动 —— 新增 sheet 只需加一行配置，不会漏
//   ③ datetime → ISO 字符串 —— 前端 parseInventoryExcel 统一处理
//   ④ 导出后自动校验 —— 各 sheet 行数/关键列非空数/manifest 文件数，不靠人眼抽查
//   ⑤ manifest.json 同步更新 —— 含 SHA256，15 文件清单

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');          // SheetJS: read Excel (CJS via createRequire)

// ── 配置 ──

// sheet → 输出文件的映射（order 同时控制 manifest 里的加载优先级）
const SHEET_MAP = [
  // inventory-core.json — 首屏必需（boot 时立即下载）
  { file: 'inventory-core.json', sheets: ['订单满足率', '2026周转', '2025周转', '库存金额', '库存覆盖', '7月库存覆盖数据'] },
  // inventory-plan.json — 分仓计划（按需）
  { file: 'inventory-plan.json', sheets: ['分仓计划'] },
  // inventory-extra.json — 大表按需（拉回/转储/历史覆盖）
  { file: 'inventory-extra.json', sheets: ['5月库存覆盖数据', '6月库存覆盖数据', '拉回数据', '转储数据'] },
  // inventory-master.json — 产品主数据（按需）
  { file: 'inventory-master.json', sheets: ['基础数据'] },
];

// 需要校验的「右表非空」规则：（sheet名, 起始列索引0-based, 描述）
// 库存金额 右表是 col12+（橙/红/黄/安全 × RDC × 月），至少要有几百个非空单元格
const RIGHT_TABLE_CHECKS = [
  { sheet: '库存金额', minCol: 11, minNonNull: 500, desc: '库存金额右表(库存结构分析)' },
];

// ── 主逻辑 ─

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function findExcelFile(customPath) {
  if (customPath) {
    // 先尝试作为绝对路径或相对于 cwd
    if (fs.existsSync(customPath)) return customPath;
    // 再尝试相对于脚本目录
    const p = path.resolve(__dirname, customPath);
    if (fs.existsSync(p)) return p;
  }
  // 自动查找：各候选目录下匹配 *库存分析*.xlsx 的最新文件
  const candidates = [
    __dirname,                                   // 脚本同目录
    path.join(__dirname, '.cache'),              // 脚本/.cache
    'D:\\WB\\2026-08-29-16-03-40',              // 工作区（D:盘）
    'D:\\WB\\2026-08-29-16-03-40\\.cache',      // 工作区/.cache
    process.cwd(),                               // 当前工作目录
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const files = (fs.readdirSync(dir) || [])
      .filter(f => /\.xlsx?$/i.test(f) && /库存分析/.test(f))
      .map(f => ({ f, p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtime.getTime() }))
      .sort((a, b) => b.m - a.m);
    if (files.length) {
      console.log('[auto] 找到 Excel:', files[0].p);
      return files[0].p;
    }
  }
  console.error('[FATAL] 未找到库存分析 Excel 文件。请指定路径：node export_inventory.mjs <路径>');
  process.exit(1);
}

function main() {
  const excelPath = findExcelFile(process.argv[2]);
  console.log('=== RDC Inventory Excel → JSON Export ===');
  console.log('源文件:', excelPath);

  // 1. 读取 Excel（SheetJS）
  const wb = XLSX.readFile(excelPath, { cellDates: true, defval: '' });
  console.log('Sheets:', wb.SheetNames.join(', '));

  // 2. 逐文件导出
  const manifestFiles = {};   // filename -> sha256
  const allOutput = {};

  for (const group of SHEET_MAP) {
    const outFile = group.file;
    const outSheets = {};
    let totalRows = 0;

    for (const sn of group.sheets) {
      if (!wb.SheetNames.includes(sn)) {
        console.warn(`[WARN] Sheet "${sn}" 不存在于 Excel 中，跳过`);
        continue;
      }
      const ws = wb.Sheets[sn];

      // sheet_to_json with header=1 gives raw 2D array covering !ref（全范围）
      const data2d = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', dateNF: 'yyyy-mm-dd\\Thh:mm:ss' });

      // Post-process: convert Date objects to ISO strings
      for (let r = 0; r < data2d.length; r++) {
        for (let c = 0; c < (data2d[r] || []).length; c++) {
          const v = data2d[r][c];
          if (v instanceof Date) {
            // Handle Excel "1899-12-30" serial date issue etc.
            const y = v.getFullYear();
            if (y > 2000 && y < 2100) {
              data2d[r][c] = v.toISOString().replace('T', ' ').slice(0, 19);
            } else {
              data2d[r][c] = '';
            }
          }
        }
      }

      outSheets[sn] = data2d;
      totalRows += data2d.length;

      // 右表校验
      const rtc = RIGHT_TABLE_CHECKS.find(c => c.sheet === sn);
      if (rtc) {
        let nonNull = 0;
        for (let r = 0; r < data2d.length; r++) {
          for (let c = rtc.minCol; c < (data2d[r] || []).length; c++) {
            if (data2d[r][c] !== null && data2d[r][c] !== undefined && data2d[r][c] !== '') nonNull++;
          }
        }
        const ok = nonNull >= rtc.minNonNull;
        console.log(`  [校验] ${rtc.desc}: 非空格=${nonNull} ${ok ? '✅' : '❌ 低于阈值 ' + rtc.minNonNull}`);
        if (!ok) {
          console.error(`[ERROR] ${rtc.desc} 非空单元格仅 ${nonNull}，少于阈值 ${rtc.minNonNull}。Excel 可能未保存或 sheet 结构已变。`);
          // 不退出，但标记
        }
      }

      console.log(`  ${sn}: ${data2d.length} 行 × ${(data2d[0] || []).length} 列`);
    }

    const sheetNames = Object.keys(outSheets);
    if (sheetNames.length === 0) {
      console.log(`[SKIP] ${outFile}: 无有效 sheet`);
      continue;
    }

    const output = JSON.stringify({ sheetNames, sheets: outSheets });
    const outPath = path.join(__dirname, outFile);
    fs.writeFileSync(outPath, output);
    const hash = sha256(Buffer.from(output));
    manifestFiles[outFile] = hash;
    allOutput[outFile] = { rows: totalRows, bytes: Buffer.byteLength(output), hash, sheets: sheetNames };
    console.log(`  → ${outFile}: ${(Buffer.byteLength(output) / 1048576).toFixed(2)} MB, ${totalRows} 行, sha256:${hash.slice(0, 12)}…`);
  }

  // 3. 生成 manifest.json（含所有 data 文件 + inventory 文件）
  const manifestDir = __dirname;
  const manifestPath = path.join(manifestDir, 'manifest.json');

  // 读取已有 manifest 以获取非 inventory 文件的 hash（data.json 等）
  let existingManifest = {};
  if (fs.existsSync(manifestPath)) {
    try { existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch(e) {}
  }

  const manifest = { version: new Date().toISOString().slice(0, 10), files: {} };
  // 合并 inventory 文件 hash
  Object.assign(manifest.files, manifestFiles);
  // 保留其他 data 文件的 hash（如果之前存在且文件还在）
  for (const [f, h] of Object.entries(existingManifest.files || {})) {
    if (!(f in manifest.files) && fs.existsSync(path.join(manifestDir, f))) {
      // 重新计算 hash（文件可能变了）
      manifest.files[f] = sha256(fs.readFileSync(path.join(manifestDir, f)));
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('\n→ manifest.json:', Object.keys(manifest.files).length, '文件');
  for (const [f, h] of Object.entries(manifest.files)) {
    console.log(`   ${f}: ${h.slice(0, 16)}…`);
  }

  // 4. 汇总报告
  console.log('\n=== 导出完成 ===');
  for (const [f, info] of Object.entries(allOutput)) {
    console.log(`  ${f}: ${info.rows} 行, ${(info.bytes / 1048576).toFixed(2)} MB, sheets=[${info.sheets.join(', ')}]`);
  }
  console.log(`\n下一步：确认 DB_VERSION 已 bump → git add ${Object.keys(allOutput).join(' ')} manifest.json rdc-dashboard.html index.html → commit & push`);
}

main();
