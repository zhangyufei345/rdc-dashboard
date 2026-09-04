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
    return /^data.*\.xlsx$/i.test(f) || /^inventory\.xlsx$/i.test(f) || /^transship\.xlsx$/i.test(f);
  });
  return files.sort();
}

function sha256File(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 读取产品主数据（产品.xlsx），构建多维度产品属性映射。
// 该文件含 3 个 sheet：
//   「产品列表」：产品编码 / ABC分类 / 品牌 / 箱规转化因子 等
//   「单价」：物料编码 / 单价
//   「淘汰品」：产品编码 / 是否为淘汰品
// 列定位统一按表头名动态查找（兼容新旧列顺序，避免硬编码列号取空）。
function buildProductMaster() {
  const p = path.join(ROOT, '产品.xlsx');
  const empty = { boxSpecMap: {}, priceMap: {}, discontinuedMap: {}, brandMap: {}, abcMap: {} };
  if (!fs.existsSync(p)) { console.log('   (未找到 产品.xlsx，产品主数据为空)'); return empty; }
  const wb = XLSX.read(fs.readFileSync(p), { type: 'array' });
  const out = { boxSpecMap: {}, priceMap: {}, discontinuedMap: {}, brandMap: {}, abcMap: {} };
  function colIdx(header, name) {
    for (let i = 0; i < (header || []).length; i++) {
      if (String(header[i] || '').trim() === name) return i;
    }
    return -1;
  }
  function loadSheet(name) {
    if (!wb.SheetNames.includes(name)) return null;
    return XLSX.utils.sheet_to_json(wb.Sheets[name], SHEET_OPTS);
  }
  // 1) 产品列表：箱规 / 品牌 / ABC
  const list = loadSheet('产品列表') || loadSheet(wb.SheetNames[0]);
  if (list && list.length > 0) {
    const h = list[0] || [];
    const cCode = colIdx(h, '产品编码') >= 0 ? colIdx(h, '产品编码') : 0;
    const cSpec = colIdx(h, '箱规转化因子');
    const cBrand = colIdx(h, '品牌');
    const cAbc = colIdx(h, 'ABC分类');
    for (let i = 1; i < list.length; i++) {
      const r = list[i];
      const code = String(r[cCode >= 0 ? cCode : 0] || '').trim();
      if (!code) continue;
      if (cSpec >= 0) { const v = Number(r[cSpec]); if (!isNaN(v) && v > 0) out.boxSpecMap[code] = v; }
      if (cBrand >= 0) { const b = String(r[cBrand] || '').trim(); if (b) out.brandMap[code] = b; }
      if (cAbc >= 0) { const a = String(r[cAbc] || '').trim(); if (a) out.abcMap[code] = a; }
    }
  }
  // 2) 单价：物料编码 -> 单价
  const price = loadSheet('单价');
  if (price && price.length > 0) {
    const h = price[0] || [];
    const cCode = colIdx(h, '物料编码') >= 0 ? colIdx(h, '物料编码') : 0;
    const cPrice = colIdx(h, '单价');
    for (let i = 1; i < price.length; i++) {
      const r = price[i];
      const code = String(r[cCode >= 0 ? cCode : 0] || '').trim();
      if (!code) continue;
      if (cPrice >= 0) { const v = Number(r[cPrice]); if (!isNaN(v)) out.priceMap[code] = v; }
    }
  }
  // 3) 淘汰品：产品编码 -> 是否为淘汰品
  const disc = loadSheet('淘汰品');
  if (disc && disc.length > 0) {
    const h = disc[0] || [];
    const cCode = colIdx(h, '产品编码') >= 0 ? colIdx(h, '产品编码') : 0;
    const cObs = colIdx(h, '是否为淘汰品');
    for (let i = 1; i < disc.length; i++) {
      const r = disc[i];
      const code = String(r[cCode >= 0 ? cCode : 0] || '').trim();
      if (!code) continue;
      if (cObs >= 0) { const v = String(r[cObs] || '').trim(); if (v) out.discontinuedMap[code] = v; }
    }
  }
  console.log('   产品主数据：boxSpec=' + Object.keys(out.boxSpecMap).length + ' 单价=' + Object.keys(out.priceMap).length + ' 淘汰品=' + Object.keys(out.discontinuedMap).length + ' 品牌=' + Object.keys(out.brandMap).length + ' ABC=' + Object.keys(out.abcMap).length);
  return out;
}

// 解析转储数据源（上半年转储.XLSX），输出与网页 dataStore.transship 同构的数组
function parseTransship(srcPath) {
  function normDate(v) {
    if (!v) return null;
    if (typeof v === 'number') {
      const d = new Date((v - 25569) * 86400 * 1000);
      return isNaN(d.getTime()) ? null : d;
    }
    if (v instanceof Date) return v;
    if (typeof v === 'string') {
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }
  function fmtDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function getSafeStr(r, i) { return String((r && r[i]) || '').trim(); }
  function getSafeNum(r, i) { const v = (r && r[i]); const n = Number(v); return isNaN(n) ? 0 : n; }
  function rdcOf(loc) {
    if (loc.startsWith('20')) return '东北RDC';
    if (loc.startsWith('40')) return '华南RDC';
    if (loc.startsWith('60')) return '西北RDC';
    if (loc.startsWith('70')) return '华中RDC';
    if (loc.startsWith('80')) return '西南RDC';
    if (loc.startsWith('90')) return '华北RDC';
    return '未知';
  }
  function typeOf(loc) {
    if (loc.endsWith('23') || loc.endsWith('06')) return '免费单转储';
    if (loc.endsWith('03')) return 'KA常规转储';
    return '常规转储';
  }

  const wb = XLSX.read(fs.readFileSync(srcPath), { type: 'array' });
  const list = [];
  const seen = new Set();

  // Sheet1 表头：公司/创建日期/创建者/收货库位/收货工厂/物料/短文本/PO数量/OUn/OUn/计划数量/OUn/确认数量/OUn/发货单数量/OUn/发货工厂/发货RDC/采购凭证/null/删除标记/入库数量/OUn/发货过账数量/OUn
  const sh1 = XLSX.utils.sheet_to_json(wb.Sheets['Sheet1'], SHEET_OPTS);
  for (let i = 1; i < sh1.length; i++) {
    const r = sh1[i];
    if (!r) continue;
    const d = normDate(r[1]);
    if (!d) continue;
    const loc = getSafeStr(r, 3);
    if (!loc || loc.startsWith('30')) continue;
    if (!/^\d/.test(loc) || !(loc.startsWith('20') || loc.startsWith('40') || loc.startsWith('60') || loc.startsWith('70') || loc.startsWith('80') || loc.startsWith('90'))) continue;
    const material = getSafeStr(r, 5);
    if (!material) continue;
    const dateStr = fmtDate(d);
    const key = dateStr + '|' + material + '|' + loc + '|' + getSafeNum(r, 7) + '|' + getSafeNum(r, 21) + '|' + getSafeNum(r, 23);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({
      date: dateStr, dateStr,
      location: loc, rdc: rdcOf(loc), factory: getSafeStr(r, 4),
      material, materialName: getSafeStr(r, 6),
      poQty: getSafeNum(r, 7), planQty: getSafeNum(r, 10),
      confirmQty: getSafeNum(r, 12), invoiceQty: getSafeNum(r, 14),
      unit: getSafeStr(r, 22), isBox: getSafeStr(r, 22) === '箱',
      transType: typeOf(loc),
      shipFactory: getSafeStr(r, 16),
      inboundQty: getSafeNum(r, 21),
      deliveryQty: getSafeNum(r, 23)
    });
  }

  // Sheet3 表头：创建日期/创建者/收货库位/收货仓/物料/短文本/PO数量/OUn/OUn/计划数量/OUn/确认数量/OUn/发货单数量/OUn/发货工厂/发货RDC/采购凭证/删除标记/入库数量/OUn/发货过账数量/OUn
  if (wb.SheetNames.includes('Sheet3')) {
    const sh3 = XLSX.utils.sheet_to_json(wb.Sheets['Sheet3'], SHEET_OPTS);
    for (let i = 1; i < sh3.length; i++) {
      const r = sh3[i];
      if (!r) continue;
      const d = normDate(r[0]);
      if (!d) continue;
      const loc = getSafeStr(r, 2);
      if (!loc || loc.startsWith('30')) continue;
      if (!/^\d/.test(loc) || !(loc.startsWith('20') || loc.startsWith('40') || loc.startsWith('60') || loc.startsWith('70') || loc.startsWith('80') || loc.startsWith('90'))) continue;
      const material = getSafeStr(r, 4);
      if (!material) continue;
      const dateStr = fmtDate(d);
      const key = dateStr + '|' + material + '|' + loc + '|' + getSafeNum(r, 6) + '|' + getSafeNum(r, 19) + '|' + getSafeNum(r, 21);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        date: dateStr, dateStr,
        location: loc, rdc: rdcOf(loc), factory: getSafeStr(r, 3),
        material, materialName: getSafeStr(r, 5),
        poQty: getSafeNum(r, 6), planQty: getSafeNum(r, 9),
        confirmQty: getSafeNum(r, 11), invoiceQty: getSafeNum(r, 13),
        unit: getSafeStr(r, 20), isBox: getSafeStr(r, 20) === '箱',
        transType: typeOf(loc),
        shipFactory: getSafeStr(r, 15),
        inboundQty: getSafeNum(r, 19),
        deliveryQty: getSafeNum(r, 21)
      });
    }
  }

  return { transship: list, generatedAt: new Date().toISOString() };
}

function main() {
  const sources = findSources();
  if (sources.length === 0) {
    console.error('未找到 data*.xlsx / inventory.xlsx / transship.xlsx，请在项目根目录运行。');
    process.exit(1);
  }

  const manifest = { generatedAt: new Date().toISOString(), files: {} };
  let totalRows = 0;

  for (const src of sources) {
    const srcPath = path.join(ROOT, src);
    const base = src.replace(/\.xlsx$/i, '');
    const outJson = base + '.json';

    console.log(`→ 转换 ${src} ...`);

    if (base === 'transship') {
      const payload = parseTransship(srcPath);
      fs.writeFileSync(path.join(ROOT, outJson), JSON.stringify(payload));
      manifest.files[outJson] = sha256File(srcPath);
      console.log(`   ${outJson}   rows=${payload.transship.length}`);
      continue;
    }

    const wb = XLSX.read(fs.readFileSync(srcPath), { type: 'array' });
    const sheets = {};
    wb.SheetNames.forEach(name => {
      const arr = XLSX.utils.sheet_to_json(wb.Sheets[name], SHEET_OPTS);
      sheets[name] = arr;
      totalRows += arr.length;
    });

    const payload = { sheetNames: wb.SheetNames, sheets };
    if (base === 'data') {
      const pm = buildProductMaster();
      payload.boxSpecMap = pm.boxSpecMap;
      payload.priceMap = pm.priceMap;
      payload.discontinuedMap = pm.discontinuedMap;
      payload.brandMap = pm.brandMap;
      payload.abcMap = pm.abcMap;
      // 未放行订单需要它把装运条件码映射到 RDC。若源文件里没有，才从历史月 json 回填。
      // 该表为 SAP 静态编码（20东北/50华南/60西北/70华中/80西南/90华北），沿用历史值安全。
      //
      // v181 修复：源文件的 sheet 名会变——8 月及以前叫「装运条件定义」，
      //   2026-09-04 的 9 月文件改叫「装运条件」（内容一致，都是 7 行）。
      //   此前这里是精确匹配 '装运条件定义'，把「有数据但换了名字」误判成缺失，
      //   于是走回填分支，结果 json 里同时出现「装运条件」(自带 7 行) 与
      //   「装运条件定义」(回填 7 行) 两份完全相同的数据，sheetNames 变成 9 个。
      //   HTML 侧用的是模糊匹配（line 1490 的 indexOf('装运条件')），取第一个所以功能没坏，
      //   但属于冗余且易误导。
      //   改法：这里也改成与 HTML 一致的模糊匹配，命中源文件自带的表就直接用，不回填。
      const SHIP_KEY = '装运条件';
      const shipName = (wb.SheetNames || []).find(n => String(n || '').indexOf(SHIP_KEY) >= 0);
      if (shipName) {
        console.log(`   ✓ 装运条件表：使用源文件自带的「${shipName}」（${(payload.sheets[shipName] || []).length} 行），无需回填`);
      } else {
        const histFiles = fs.readdirSync(ROOT)
          .filter(f => /^data-\d{4}-\d{2}\.json$/.test(f) && f !== 'data.json')
          .sort().reverse();
        for (const hf of histFiles) {
          try {
            const hj = JSON.parse(fs.readFileSync(path.join(ROOT, hf), 'utf8'));
            // 历史 json 同样用模糊匹配找，兼容新旧两种名字
            const hName = (hj.sheetNames || []).find(n => String(n || '').indexOf(SHIP_KEY) >= 0);
            if (hName && hj.sheets && hj.sheets[hName] && Array.isArray(hj.sheets[hName])) {
              payload.sheets['装运条件定义'] = hj.sheets[hName];
              payload.sheetNames = payload.sheetNames.filter(n => String(n || '').indexOf(SHIP_KEY) < 0);
              payload.sheetNames.push('装运条件定义');
              console.log(`   ⚠️ data.xlsx 缺「${SHIP_KEY}」sheet，已从 ${hf} 的「${hName}」回填（${payload.sheets['装运条件定义'].length} 行）`);
              break;
            }
          } catch (e) { /* 跳过不可读历史文件 */ }
        }
      }
    }
    fs.writeFileSync(path.join(ROOT, outJson), JSON.stringify(payload));
    // manifest 以「源 xlsx 内容哈希」为键，仅当真实数据变化时才触发网页重新解析
    manifest.files[outJson] = sha256File(srcPath);
    console.log(`   ${outJson}   sheets=${wb.SheetNames.length}  rows=${totalRows}`);
    totalRows = 0; // 仅用于日志，每行文件重置
  }

  // ===== 补货调整记录（v186 新增数据源：补货调整跟踪模块）=====
  // 来源：S 盘《RDC补货调整记录.xlsx》（计划员手工维护）；用户会复制到桌面「更新部署」再通知更新。
  //   查找顺序：桌面「更新部署」优先 → S 盘兜底。两边都没有时保留已有 adjustments.json 不动。
  // 产物：adjustments.json = { generatedAt, source, count, adjust: [...] }
  //   只存原始记录（13 列），到货日/观察窗口由前端按运输周期动态计算——运输周期改了不用重跑脚本。
  // 口径：窗口缺货量由前端按「订单明细首日缺货量(支) ÷ 箱规」计算，本文件不碰缺货数据。
  {
    const ADJ_CANDIDATES = [
      'C:/Users/zhangyufei1/Desktop/更新部署/RDC补货调整记录.xlsx',
      'S:/供应链/供应链计划部/03.创新/12.补货计划工作记录/RDC补货调整记录.xlsx'
    ];
    const adjSrc = ADJ_CANDIDATES.find(p => fs.existsSync(p));
    if (adjSrc) {
      try {
        const wbA = XLSX.read(fs.readFileSync(adjSrc), { type: 'array' });
        const shA = wbA.Sheets[wbA.SheetNames[0]];
        const rowsA = XLSX.utils.sheet_to_json(shA, SHEET_OPTS);
        const ser2iso = n => {
          if (typeof n !== 'number' || !isFinite(n)) return null;
          const d = new Date(Math.round((n - 25569) * 86400000));
          return isNaN(d) ? null : d.toISOString().slice(0, 10);
        };
        const normSku = v => {
          if (v === null || v === undefined || v === '') return '';
          let s = String(v).trim();
          if (/^\d+(\.0+)?$/.test(s)) s = String(Math.trunc(parseFloat(s)));
          return s.padStart(5, '0');
        };
        const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
        const adjust = [];
        for (let i = 1; i < rowsA.length; i++) {
          const r = rowsA[i];
          if (!r || r[0] === null || r[0] === undefined || r[0] === '') continue;
          const d = ser2iso(typeof r[0] === 'number' ? r[0] : null) || (typeof r[0] === 'string' ? r[0].slice(0, 10) : null);
          if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
          adjust.push({
            date: d,                                    // 补货日期
            rdc: String(r[1] || '').trim(),             // 华中/华南/华北/东北/西北/西南
            sku: normSku(r[2]),
            skuName: String(r[3] || '').trim(),
            category: String(r[4] || '').trim(),        // 供应链品类
            lifecycle: String(r[5] || '').trim(),       // 生命周期
            hainan: String(r[6] || '').trim(),          // 海南花露水标记
            spuMissing: String(r[7] || '').trim(),      // SPU缺失&不补货产品
            planQty: num(r[8]),                         // 应补量（箱）
            adjQty: num(r[9]),                          // 调整后补货量（箱）
            dcStock: num(r[10]),                        // 当时大仓库存（箱）
            adjType: String(r[11] || '').trim(),        // 调整类型：总仓缺货/超大仓10%/补货后超大仓20%/计划员调整/其他
            adjReason: String(r[12] || '').trim()       // 调整原因或判断依据
          });
        }
        const payloadA = { generatedAt: new Date().toISOString(), source: adjSrc, count: adjust.length, adjust };
        fs.writeFileSync(path.join(ROOT, 'adjustments.json'), JSON.stringify(payloadA));
        manifest.files['adjustments.json'] = sha256File(adjSrc);
        console.log(`   adjustments.json  records=${adjust.length}  ← ${adjSrc}`);
      } catch (e) {
        console.error('   ⚠️ 补货调整记录解析失败，保留旧 adjustments.json：' + e.message);
        const adjJson = path.join(ROOT, 'adjustments.json');
        if (fs.existsSync(adjJson)) manifest.files['adjustments.json'] = sha256File(adjJson);
      }
    } else {
      // 两边都没找到源文件：保留旧 adjustments.json 并按其自身内容纳入 manifest（同 history.json 逻辑），
      // 否则 manifest 里缺了这个文件，前端按 manifest 加载时调整跟踪页会空。
      const adjJson = path.join(ROOT, 'adjustments.json');
      if (fs.existsSync(adjJson)) {
        manifest.files['adjustments.json'] = sha256File(adjJson);
        console.log('   adjustments.json  源文件未找到（更新部署/S盘），保留现有数据');
      } else {
        console.log('   adjustments.json  源文件未找到且无历史产物，跳过（补货调整跟踪页将显示引导）');
      }
    }
  }

  // 纳入孤儿预解析 json（如 data-2026-01.json：仅有 .json 而无对应 .xlsx 源的历史月）。
  // 若不纳入，看板 bootLoad 只按 manifest.files 加载，孤儿历史月数据永不加载，导致趋势图该月空白。
  const orphanJsonRe = /^data-\d{4}-\d{2}\.json$/;
  fs.readdirSync(ROOT).forEach(f => {
    if (!orphanJsonRe.test(f)) return;
    const base = f.replace(/\.json$/, '');
    if (fs.existsSync(path.join(ROOT, base + '.xlsx'))) return; // 有 xlsx 源已在上面正常生成
    manifest.files[f] = sha256File(path.join(ROOT, f));
    console.log('   孤儿预解析 ' + f + ' 已纳入 manifest（无对应 xlsx 源，确保历史月被加载）');
  });

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
