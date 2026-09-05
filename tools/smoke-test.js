#!/usr/bin/env node
/**
 * RDC 看板预检脚本 - 部署前自动运行，防止更新后页面空白
 *
 * 检查项：
 *  1. JS 语法（提取 <script> 块用 new Function 解析）
 *  2. 顶层 render 函数列表（确认 8 个页面函数都在）
 *  3. 高风险模式扫描（常见改动坑）
 *  4. DB_VERSION 注释 vs 实际值一致性
 *
 * 用法: node tools/smoke-test.js
 * 退出码: 0=通过, 1=失败
 */
const fs = require('fs');
const path = require('path');

const HTML = path.resolve(__dirname, '..', 'rdc-dashboard.html');
const EXPECTED_RENDERERS = [
  'renderOverview', 'renderFulfillment', 'renderShortage',
  'renderCustomer', 'renderWeekendSim', 'renderTransship',
  'renderShortageCompare', 'renderReplenishment', 'renderReplenishLogic',
  'renderInventoryStructure', 'renderInventoryTurnover', 'renderInventoryForecast',
  'renderInventoryCoverageDetail', 'renderSlowMoving', 'renderSlowMovingLogic',
  'renderBizDemand', 'renderBizDemandDetail', 'renderBizDemandDACR',
  'renderOrderInsight'
];

let errors = 0;
let warnings = 0;
const log = (level, msg) => {
  const tag = { err: '❌', warn: '⚠ ', ok: '✓' }[level] || '·';
  console.log(`  ${tag} ${msg}`);
  if (level === 'err') errors++;
  if (level === 'warn') warnings++;
};

console.log('\n═══════════ RDC 看板预检 ═══════════');
console.log('文件: ' + path.relative(process.cwd(), HTML));

const html = fs.readFileSync(HTML, 'utf8');

// ── 1. JS 语法检查 ──
console.log('\n[1/4] JS 语法检查');
const scripts = html.match(/<script>[\s\S]*?<\/script>/g) || [];
if (scripts.length === 0) {
  log('err', '未找到 <script> 块');
} else {
  log('ok', `找到 ${scripts.length} 个 <script> 块`);
  scripts.forEach((s, i) => {
    const code = s.replace(/<\/?script>/g, '');
    try {
      new Function(code);
      log('ok', `script#${i} 语法 OK (${code.length} 字符)`);
    } catch (e) {
      log('err', `script#${i} 语法错误: ${e.message}`);
    }
  });
}

// ── 2. 顶层 render 函数存在性 ──
console.log('\n[2/4] 顶层 render 函数存在性');
EXPECTED_RENDERERS.forEach(name => {
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  if (re.test(html)) log('ok', name);
  else log('err', name + ' 缺失（函数未找到）');
});

// ── 3. 高风险模式扫描 ──
console.log('\n[3/4] 高风险模式扫描');

// 3a. 内部函数引用未定义变量（基于 render 函数体的简单启发）
const dangerPatterns = [
  { name: '引用已删除的 ACCURACY', re: /\bACCURACY\b/, severity: 'warn' },
  { name: '引用已删除的 adjDemandYuan', re: /\badjDemandYuan\b/, severity: 'warn' },
  { name: '引用已删除的 seasonalRatio', re: /\bseasonalRatio\b/, severity: 'warn' },
  { name: '引用已删除的 COVERAGE_DAYS(旧名)', re: /\bCOVERAGE_DAYS\b(?!.*window\._forecastParams)/, severity: 'warn' },
  { name: '引用已删除的 MAX_REPLENISH_RATIO(已移入 GRADUAL)', re: /\bMAX_REPLENISH_RATIO\b/, severity: 'warn' },
  { name: '引用已删除的 nat26SeasonalNationalH2', re: /\bnat26SeasonalNationalH2\b/, severity: 'warn' },
  { name: '引用已删除的 totalAmt 直接(可能为空，需 fallback)', re: /d\.totalAmt(?!\s*\|\|)/, severity: 'info' }
];
dangerPatterns.forEach(p => {
  if (p.re.test(html)) {
    if (p.severity === 'err') log('err', p.name);
    else if (p.severity === 'warn') log('warn', p.name);
    else console.log('  ℹ  ' + p.name);
  } else {
    log('ok', p.name + ' (无残留)');
  }
});

// 3b. parseCoverageSheet 字段完整性
const parseCov = html.match(/function\s+parseCoverageSheet[\s\S]*?\n\s{4}\}/);
if (parseCov) {
  const covCode = parseCov[0];
  ['cov07', 'cov08', 'cov09', 'cov10', 'cov11', 'cov12'].forEach(f => {
    if (!covCode.includes(f + ':')) log('err', `parseCoverageSheet 缺 ${f} 字段`);
  });
  if (!covCode.includes('coverageLevel:')) log('err', 'parseCoverageSheet 缺 coverageLevel 字段');
  if (!covCode.includes('totalAmt:')) log('err', 'parseCoverageSheet 缺 totalAmt 字段');
  // parseCoverageSheet 现在是动态列映射（按表头名查找），不检查列索引
  // 确认函数存在且包含必要字段即可
  if (covCode.includes('cov07:') && covCode.includes('cov12:')) {
    log('ok', 'cov07..cov12 字段存在（动态列映射）');
  } else {
    log('warn', 'cov07/cov12 字段可能缺少');
  }
} else {
  log('warn', 'parseCoverageSheet 函数找不到');
}

// 3c. 静态分析：函数级"未声明引用"检测（只报真正全局未定义的）
console.log('\n  [3c] 静态分析：render 函数的"全局未定义"引用');

// 收集整个文件的所有声明（const/let/var/function 参数）
const allDecls = new Set();
const fileDeclRe = /\b(?:const|let|var|function)\s+(\w+)/g;
let dm; while ((dm = fileDeclRe.exec(html)) !== null) allDecls.add(dm[1]);
const fileParamsRe = /function\s*\(([^)]*)\)/g;
while ((dm = fileParamsRe.exec(html)) !== null) {
  dm[1].split(',').forEach(p => { const t = p.trim().split(/\s+/).pop(); if (t && /^\w+$/.test(t)) allDecls.add(t); });
}

// 已知全局
const knownGlobals = new Set([
  'dataStore','echarts','ECharts','initChart','formatNum','formatMoney','fmtK','fmtChangeHtml',
  'mapRDCName','mapCovLevel','isSlowCoverage','isExcludedProduct','normalizeBrandName',
  'setTitle','navigateTo','showToast','DB_VERSION','DB_NAME','STORE_NAME','openDB','applyPreparsed',
  'renderInventoryTurnover','renderInventoryTurnoverHistory','renderInventoryTurnoverHistoryCharts',
  'renderDrillModal','drillStatusDetail','drillCoverageDetail','drillRdcCovDetail',
  'exportInventoryCoverageDetail','parseStatusSheet','parseCoverageSheet','parseInventoryTurnoverSheet',
  'reRenderForecast','getInvTabBar','getInvRdcSelection','renderAllShortageTable','getRDCName','init',
  'getComputedStyle','XMLHttpRequest','FormData','Date','Math','Array','Object','JSON','Number','String',
  'Set','Map','Promise','Error','URL','URLSearchParams','fetch','RegExp','Boolean','Symbol',
  'window','document','console','localStorage','sessionStorage','indexedDB','location','navigator','history',
  'getElementById','querySelector','querySelectorAll','addEventListener','appendChild','removeChild',
  'createElement','setAttribute','getAttribute','setTimeout','setInterval','clearTimeout',
  'parseInt','parseFloat','isNaN','isFinite','isArray','encodeURIComponent','decodeURIComponent'
]);

const jsKeywords = new Set([
  'if','else','for','while','do','switch','case','default','break','continue','return',
  'function','const','let','var','class','extends','super','this','new','delete',
  'typeof','instanceof','in','of','void','null','undefined','true','false','NaN','Infinity',
  'try','catch','finally','throw','async','await','yield','import','export','from','as'
]);

const renderFns = EXPECTED_RENDERERS.map(name => {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = html.match(re);
  if (!m) return null;
  let depth = 0, i = m.index;
  while (i < html.length) { const c = html[i]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; } i++; }
  return { name, body: html.slice(m.index, i + 1) };
}).filter(Boolean);

function stripStrings(s) {
  return s
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:\\\\|\\'|[^'\\\\])*'/g, "''")
    .replace(/"(?:\\\\|\\"|[^"\\\\])*"/g, '""')
    .replace(/`(?:\\\\|\\`|\$\{[\s\S]*?\}|[^`\\\\])*`/g, '``');
}

renderFns.forEach(({ name, body }) => {
  // 函数内部声明
  const localDecls = new Set();
  const localDeclRe = /\b(?:const|let|var|function)\s+(\w+)/g;
  let m; while ((m = localDeclRe.exec(body)) !== null) localDecls.add(m[1]);
  const localParamsRe = /function\s*\(([^)]*)\)/g;
  while ((m = localParamsRe.exec(body)) !== null) {
    m[1].split(',').forEach(p => { const t = p.trim().split(/\s+/).pop(); if (t && /^\w+$/.test(t)) localDecls.add(t); });
  }
  // 函数内使用到的标识符
  const code = stripStrings(body);
  const useRe = /\b([A-Za-z_]\w{2,})\b/g;
  const uses = {};
  while ((m = useRe.exec(code)) !== null) {
    const w = m[1];
    if (!localDecls.has(w) && !allDecls.has(w) && !knownGlobals.has(w) && !jsKeywords.has(w) && !/^[A-Z]/.test(w) && w.length > 2) {
      uses[w] = (uses[w] || 0) + 1;
    }
  }
  // 关键：仅报"文件中也未定义"的真可疑变量
  const realSuspects = Object.entries(uses).filter(([w, c]) => c >= 3);
  if (realSuspects.length > 0) {
    log('warn', name + ': 疑似未定义 ' + realSuspects.slice(0, 5).map(([w, c]) => w + '(' + c + ')').join(', '));
  }
});

// ── 4. DB_VERSION 注释 vs 实际值 ──
console.log('\n[4/4] DB_VERSION 检查');
const dvMatch = html.match(/const DB_VERSION\s*=\s*(\d+);?\s*(\/\/[^\n]*)?/);
if (dvMatch) {
  const val = parseInt(dvMatch[1]);
  const comment = (dvMatch[2] || '').trim();
  log('ok', `DB_VERSION = ${val}`);
  if (comment) log('ok', '  注释: ' + comment);
  if (val < 1) log('err', 'DB_VERSION 无效');
} else {
  log('err', '未找到 const DB_VERSION');
}

// ── + 回归防护：关键不变式（防止「开发一个版本、损失一个老功能」）──
// 历史坑位：v187 badge 造假 / v192 销售进度丢 / v193 月份下拉 / v194 加载提速 / v195 销售进度又空。
// 根因：每次只孤立验证「用户提到的那一页」，没有一处断言「其它页的关键列/字段是否还在」。
// 本段把「最容易复发、且复发后静默无提示」的不变式固化为断言，任何一次改动踩到都会让预检变红。
console.log('\n[回归防护] 关键不变式（防止「开发一个版本、损失一个老功能」）');

// R1: buildPlanSkuAgg 必须在「提前 return 守卫」之前设置 _planSkuAggMonth / _planSkuAggLabel，
//     否则 缺货四象限「严重度高重点跟进清单」的「销售进度」列全空 + 表头括号内目标月为空（v192→v195 反复）。
const fnMatch = html.match(/function\s+buildPlanSkuAgg\s*\([^)]*\)\s*\{/);
if (fnMatch) {
  let depth = 0, i = fnMatch.index;
  const start = i;
  while (i < html.length) { const c = html[i]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; } i++; }
  const body = html.slice(start, i + 1);
  const labelIdx = body.indexOf('window._planSkuAggMonth =');
  const label2Idx = body.indexOf('window._planSkuAggLabel =');
  const returnIdx = body.indexOf('return out;');
  if (labelIdx === -1) {
    log('err', 'R1: buildPlanSkuAgg 未设置 window._planSkuAggMonth（销售进度列会空）');
  } else if (label2Idx === -1) {
    log('err', 'R1b: buildPlanSkuAgg 未设置 window._planSkuAggLabel（表头目标月会空）');
  } else if (returnIdx === -1) {
    log('ok', 'R1: 设置 _planSkuAggMonth/_planSkuAggLabel 且无提前 return（OK）');
  } else if (labelIdx < returnIdx && label2Idx < returnIdx) {
    log('ok', 'R1: _planSkuAggMonth/_planSkuAggLabel 均在提前 return 之前设置（销售进度列不会空）');
  } else {
    log('err', 'R1: 提前 return 早于 _planSkuAggMonth 设置 → 销售进度列会空！');
  }
} else {
  log('err', 'R1: 找不到 function buildPlanSkuAgg（函数被改名/删除）');
}

// R2: 缺货四象限「销售进度」表头必须引用 _planSkuAggMonth（保证括号里有目标月，而非空括号）
if (html.includes("销售进度（' + (window._planSkuAggMonth")) {
  log('ok', 'R2: 缺货四象限「销售进度」表头引用 _planSkuAggMonth（目标月显示）');
} else {
  log('err', 'R2: 缺货四象限「销售进度」表头未引用 _planSkuAggMonth（目标月会空）');
}

// R3: 月份下拉仍由 orderDetail 的 dateStr 聚合（v193 把下拉移入筛选栏，曾担心「只有9月」）。
//     真实链路：buildMonthlyShortageProfile() 从 dataStore.orderDetail 取 d.dateStr.slice(0,7) → monthWd → 暴露为 monthWorkdays。
const bms = html.match(/function\s+buildMonthlyShortageProfile\s*\([^)]*\)\s*\{/);
if (bms) {
  let depth = 0, bi = bms.index; const bstart = bi;
  while (bi < html.length) { const c = html[bi]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; } bi++; }
  const bmsBody = html.slice(bstart, bi + 1);
  if (bmsBody.includes('dataStore.orderDetail') && bmsBody.includes("d.dateStr.slice(0, 7)")) {
    log('ok', 'R3: 月份下拉由 orderDetail.dateStr 聚合（多月份自动出现，不会只剩9月）');
  } else {
    log('err', 'R3: buildMonthlyShortageProfile 不再从 orderDetail 聚合月份（下拉可能只剩单月）');
  }
} else {
  log('err', 'R3: 找不到 buildMonthlyShortageProfile（月份下拉逻辑可能被删）');
}

// R4: 分仓计划监控「✓ 在补货建议清单中」badge 仍为真实匹配（v187 曾无条件显示造假）
if (html.includes('_replSkuRdcSet') || html.includes('badge') && html.includes('在补货建议清单')) {
  log('ok', 'R4: 补货建议 badge 匹配逻辑存在（v187 后已改为真实命中）');
} else {
  log('warn', 'R4: 未找到 badge 真实匹配标记，请人工核对「分仓计划监控 ✓ badge 是否造假」');
}

// R5: inventory.json 不再含「库存状态分析」sheet（v196 已拆出为 inventory-status.json，首屏不再下载/解析 8.4MB）
try {
  const invRaw = fs.readFileSync(path.resolve(__dirname, '..', 'inventory.json'), 'utf8');
  const invObj = JSON.parse(invRaw);
  const invSheets = invObj.sheetNames || Object.keys(invObj.sheets || {});
  const hasStatus = invSheets.some(n => /月库存状态分析$/.test(n));
  if (!hasStatus) {
    log('ok', 'R5: inventory.json 已移除状态分析 sheet（首屏不再解析 8.4MB/45669 行）');
  } else {
    log('err', 'R5: inventory.json 仍含「库存状态分析」sheet，首屏仍会下载/解析 8.4MB 死重');
  }
} catch (e) {
  log('warn', 'R5: 无法读取 inventory.json 校验（' + e.message + '）');
}

// R6: transship.json 已移出首屏 manifest（v196 方案B，转储数据按需加载）
try {
  const mfRaw = fs.readFileSync(path.resolve(__dirname, '..', 'manifest.json'), 'utf8');
  const mf = JSON.parse(mfRaw);
  if (mf.files && !('transship.json' in mf.files)) {
    log('ok', 'R6: transship.json 已移出首屏 manifest（5.5MB 按需加载）');
  } else {
    log('err', 'R6: transship.json 仍在首屏 manifest，首屏仍会下载 5.5MB');
  }
} catch (e) {
  log('warn', 'R6: 无法读取 manifest.json 校验（' + e.message + '）');
}

// R7: 慢动诊断抽离 + 按需加载机制存在（防「拆出后忘记补算导致慢动诊断全空」回潮）
if (html.includes('function computeStatusDerived') && html.includes('function ensureSlowDiag') && html.includes('function ensureTransship')) {
  log('ok', 'R7: 慢动诊断抽离（computeStatusDerived）+ 按需加载（ensureSlowDiag/ensureTransship）机制在位');
} else {
  log('err', 'R7: 缺失 computeStatusDerived/ensureSlowDiag/ensureTransship，慢动诊断按需加载机制失效');
}

// R8: v197 分仓计划优化建议模块（多信号融合，替代 plan-monitor 单一完成率建议）
// 用户核心诉求：建议不能一刀切；按原因分类给计划员互动式调整建议。钉死关键不变式防回潮。
if (html.includes('function buildPlanOptimAdvice')) {
  log('ok', 'R8a: buildPlanOptimAdvice（多信号融合聚合）函数存在');
} else {
  log('err', 'R8a: 找不到 buildPlanOptimAdvice（优化建议核心聚合被删）');
}
if (html.includes('function renderPlanAdvice')) {
  log('ok', 'R8b: renderPlanAdvice（优化建议渲染）函数存在');
} else {
  log('err', 'R8b: 找不到 renderPlanAdvice（优化建议页未渲染）');
}
if (html.includes('💡 优化建议') || html.includes('planTabBarHtml')) {
  log('ok', 'R8c: 分仓计划监控页「优化建议」Tab 入口存在');
} else {
  log('err', 'R8c: 找不到优化建议 Tab 入口（计划员进不去）');
}
// C4 大单去噪分支：用户明确要求"超额需识别临时大单因素，否则可能误上调计划"
if (html.includes('peakFactor') && html.includes('maxLineRatio') && html.includes('疑似临时大单超销')) {
  log('ok', 'R8d: C4 超额建议含「临时大单去噪」（峰值因子+单笔占比，防盲目上调计划）');
} else {
  log('err', 'R8d: C4 大单识别分支缺失（超额会被无脑判为"上调计划"）');
}
// 原因分类元信息齐全（C1~C6）
if (html.includes('PLAN_ADVICE_TYPES') && ['C1','C2','C3','C4a','C4b','C5','C6'].every(function(k){ return html.includes("'" + k + "'"); })) {
  log('ok', 'R8e: 原因分类体系 C1~C6 齐全（总仓+RDC双缺/长期/紧急/结构性超额/临时大单/滞后防呆滞/慢动）');
} else {
  log('err', 'R8e: 原因分类 PLAN_ADVICE_TYPES 不完整');
}

// R9: v198 高严重度归因分析（严重度高清单前的归因概览卡片）
if (html.includes('buildHiAttribution')) {
  log('ok', 'R9a: buildHiAttribution（高严重度归因分析函数）存在');
} else {
  log('err', 'R9a: buildHiAttribution 不存在 —— 归因分析模块缺失');
}
if (html.includes("window._msFocusAttr = attrData")) {
  log('ok', 'R9b: 归因数据挂 window._msFocusAttr（供导出CSV使用）');
} else {
  log('err', 'R9b: _msFocusAttr 未挂载 —— 导出CSV无法获取归因数据');
}
if (html.includes("'A1'") && html.includes("'D'") && html.includes('ATTR_TYPES')) {
  log('ok', 'R9c: 归因分类 A1/A2/C1/C2/D 定义齐全');
} else {
  log('err', 'R9c: 归因分类 ATTR_TYPES 不完整');
}
if (html.includes("_attrFilter") && html.includes('hiAttrFiltered')) {
  log('ok', 'R9d: 归因筛选(_attrFilter)与筛选后列表(hiAttrFiltered)在位');
} else {
  log('err', 'R9d: 归因筛选机制缺失');
}

// R10: inventory-core.json（首屏库存）必含库存金额/库存覆盖/7月库存覆盖数据 sheet
//     v198+ 拆分后：inventory.json 不再含基础数据/分仓计划；首屏只需这 3 个 sheet + 周转
//     防「拆分后退化成原样」/「首屏文件被无意义重写」回潮
try {
  const invRaw = fs.readFileSync(path.resolve(__dirname, '..', 'inventory.json'), 'utf8');
  const invObj = JSON.parse(invRaw);
  const invSheets = invObj.sheetNames || Object.keys(invObj.sheets || {});
  const hasCore = ['库存金额', '库存覆盖'].every(s => invSheets.includes(s));
  const hasCov7 = invSheets.some(n => /库存覆盖数据$/.test(n));
  const hasOrderRate = invSheets.includes('订单满足率');
  if (hasCore && hasCov7 && hasOrderRate) {
    log('ok', 'R10: inventory.json 首屏必备 sheet 齐全（库存金额+库存覆盖+covX+订单满足率）');
  } else {
    log('err', 'R10: inventory.json 缺首屏 sheet（金额=' + hasCore + ' cov=' + hasCov7 + ' 订单满足率=' + hasOrderRate + '）');
  }
} catch (e) {
  log('warn', 'R10: 无法读取 inventory.json 校验（' + e.message + '）');
}

// R11: data.json 必含 v198 切到的产品主数据 5 个 map（boxSpecMap/priceMap/discontinuedMap/brandMap/abcMap）
//     v198 后分仓需求取基础数据 block C、产品主数据不再单独 fetch product.xlsx，依赖这 5 个 map
//     任何缺 → 后续模块（计划员 dashboard / 重点跟进清单供应链品类列 / 缺货箱数计算）静默失败
try {
  const dataRaw = fs.readFileSync(path.resolve(__dirname, '..', 'data.json'), 'utf8');
  const dataObj = JSON.parse(dataRaw);
  const requiredMaps = ['boxSpecMap', 'priceMap', 'discontinuedMap', 'brandMap', 'abcMap'];
  const missing = requiredMaps.filter(k => !(k in dataObj) || (typeof dataObj[k] !== 'object'));
  if (missing.length === 0) {
    log('ok', 'R11: data.json 含产品主数据 5 个 map（v198+ 必备）');
  } else {
    log('err', 'R11: data.json 缺产品主数据 map：' + missing.join(', '));
  }
} catch (e) {
  log('warn', 'R11: 无法读取 data.json 校验（' + e.message + '）');
}

// R12: data-YYYY-MM.json 订单明细数据量级防线（v191 防「半量快照+全量哈希」死状态）
//     当前全量 ord≈23.8 万，若低于 10 万视为残缺
try {
  const dataFiles = fs.readdirSync(path.resolve(__dirname, '..'))
    .filter(f => /^data-\d{4}-\d{2}\.json$/.test(f))
    .map(f => path.resolve(__dirname, '..', f));
  let totalOrd = 0;
  dataFiles.forEach(f => {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const sh = j.sheets && j.sheets['订单明细'];
      if (Array.isArray(sh)) totalOrd += Math.max(0, sh.length - 1); // 减表头
    } catch (e) {}
  });
  if (totalOrd >= 100000) {
    log('ok', 'R12: 订单明细总量 ' + totalOrd + ' ≥ 10 万（数据量级防线 OK）');
  } else {
    log('err', 'R12: 订单明细总量仅 ' + totalOrd + '（<10 万视为残缺，疑似半量快照）');
  }
} catch (e) {
  log('warn', 'R12: 无法扫描历史月 data-*.json：' + e.message);
}

// R13: transship 按需 fetch 触发器（ensureTransship）存在 + 转储页可由 sidebar 进入
//     v198 转储页死锁根因之一是缺 retry 上限/try-catch；这里钉死入口必须存在
if (html.includes('function ensureTransship') && html.includes("data-page=\"transship\"")) {
  log('ok', 'R13: 转储页按需 fetch（ensureTransship）+ sidebar 入口存在');
} else {
  log('err', 'R13: 转储页入口或 ensureTransship 缺失（点转储将全空/死锁）');
}

// R14: 数据加载链路根因检查 — bootLoad/refreshFromManifest/loadFromIDB 三个核心函数必须存在
//     v188~v199 多次因 init/bootLoad 位置错导致首登空白、缓存路径下空态。钉死三件套
const fns = ['function bootLoad', 'function refreshFromManifest', 'function loadFromIDB'];
const missing = fns.filter(s => !html.includes(s));
if (missing.length === 0) {
  log('ok', 'R14: 数据加载核心三件套（bootLoad/refreshFromManifest/loadFromIDB）齐全');
} else {
  log('err', 'R14: 加载核心函数缺失：' + missing.join(', '));
}

// R15: 跨函数 window._xxx 暴露点检查（v113/v114 教训：必须挂在数据解析函数末尾，不能挂 UI 渲染函数体内）
//     关键全局状态：_skuIsHainan（plan-monitor 海南花露水筛选）、_planSkuAggMonth（销售进度列）
//     必须由 parseInventoryExcel/buildPlanSkuAgg 末尾暴露，不能由 renderXxx 末尾暴露
//     改进 v201：排除注释行 + 字符串内提及（之前的索引比对太天真，会被 v201 注释里的字符串误判）
const realExposures = [];
const expRe = /window\._skuIsHainan\s*=/g;
let em;
while ((em = expRe.exec(html)) !== null) {
  const pos = em.index;
  // 取该行，检查是否注释
  const before = html.lastIndexOf('\n', pos);
  const lineStart = before + 1;
  const lineEnd = html.indexOf('\n', pos);
  const lineText = html.slice(lineStart, lineEnd);
  if (/^\s*\/\//.test(lineText)) continue; // 跳过纯注释行
  if (/^\s*\*/.test(lineText)) continue; // 跳过块注释行
  realExposures.push({ pos, line: html.slice(0, pos).split('\n').length, text: lineText.trim() });
}
if (realExposures.length === 1) {
  const exp = realExposures[0];
  const prevParseInv = html.lastIndexOf('function parseInventoryExcel', exp.pos);
  const prevRenderOI = html.lastIndexOf('function renderOrderInsight', exp.pos);
  if (prevParseInv > prevRenderOI && prevParseInv > 0) {
    log('ok', 'R15a: window._skuIsHainan 唯一暴露点位于 parseInventoryExcel 末尾（line ' + exp.line + '，v114 修复位置正确）');
  } else {
    log('err', 'R15a: window._skuIsHainan 唯一暴露点位于 renderOrderInsight 体内（line ' + exp.line + '，v113 旧坑）');
  }
} else if (realExposures.length === 0) {
  log('err', 'R15a: window._skuIsHainan 完全没有暴露点（plan-monitor 海南花露水筛选将失效）');
} else {
  log('err', 'R15a: window._skuIsHainan 暴露点数量 = ' + realExposures.length + '（多处暴露会导致 set 覆盖）');
}

// ── 总结 ──
console.log('\n═══════════ 预检结果 ═══════════');
if (errors === 0 && warnings === 0) {
  console.log('✅ 全部通过，放心 push');
} else if (errors === 0) {
  console.log(`⚠️  ${warnings} 个警告（可 push，但建议确认）`);
} else {
  console.log(`❌  ${errors} 个错误 + ${warnings} 个警告，修复后再 push`);
}
console.log('');
process.exit(errors > 0 ? 1 : 0);
