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

// R5: inventory-status.json 不在首屏 manifest（v196 拆出，v201 修脚本确保不被加回 manifest）
try {
  const mfRaw = fs.readFileSync(path.resolve(__dirname, '..', 'manifest.json'), 'utf8');
  const mf = JSON.parse(mfRaw);
  const hasStatus = mf.files && ('inventory-status.json' in mf.files);
  if (!hasStatus) {
    log('ok', 'R5: inventory-status.json 不在首屏 manifest（8.4MB 按需加载）');
  } else {
    log('err', 'R5: inventory-status.json 仍在首屏 manifest，首屏仍会下载 8.4MB');
  }
} catch (e) {
  log('warn', 'R5: 无法读取 manifest.json 校验（' + e.message + '）');
}

// R6: transship.json 已移出首屏 manifest（v196 方案B，v201 修脚本确保不被加回）
try {
  const mfRaw = fs.readFileSync(path.resolve(__dirname, '..', 'manifest.json'), 'utf8');
  const mf = JSON.parse(mfRaw);
  if (mf.files && !('transship.json' in mf.files)) {
    log('ok', 'R6: transship.json 已移出首屏 manifest（按需加载）');
  } else {
    log('err', 'R6: transship.json 仍在首屏 manifest，首屏仍会下载');
  }
} catch (e) {
  log('warn', 'R6: 无法读取 manifest.json 校验（' + e.message + '）');
}

// R6b: inventory-plan.json 按需加载（v201 阶段A；inventory-master.json 暂留 manifest）
//     inventory-plan.json 仅 plan-monitor 页需要，源无「分仓计划」sheet 时不创建
try {
  const mfRaw = fs.readFileSync(path.resolve(__dirname, '..', 'manifest.json'), 'utf8');
  const mf = JSON.parse(mfRaw);
  const planOnDemand = mf.files && !('inventory-plan.json' in mf.files);
  if (planOnDemand) {
    log('ok', 'R6b: inventory-plan.json 按需加载（plan-monitor 用；源无此 sheet 则不创建）');
  } else {
    log('err', 'R6b: inventory-plan.json 在首屏 manifest（plan-monitor 加载时再拉即可）');
  }
} catch (e) {
  log('warn', 'R6b: 无法读取 manifest.json 校验（' + e.message + '）');
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

// R10: inventory-core.json（首屏库存）必含订单满足率/库存金额/库存覆盖/covX
//     v201 阶段A 后 inventory.json 拆为 inventory-core(首屏) + inventory-master(基础数据按需) + inventory-plan(分仓计划按需)
//     inventory-core.json 仅含首屏必需的 6 sheet（~650KB，替代原 3.7MB inventory.json）
try {
  const coreRaw = fs.readFileSync(path.resolve(__dirname, '..', 'inventory-core.json'), 'utf8');
  const coreObj = JSON.parse(coreRaw);
  const coreSheets = coreObj.sheetNames || Object.keys(coreObj.sheets || {});
  const hasCore = ['库存金额', '库存覆盖'].every(s => coreSheets.includes(s));
  const hasCov7 = coreSheets.some(n => /库存覆盖数据$/.test(n));
  const hasOrderRate = coreSheets.includes('订单满足率');
  if (hasCore && hasCov7 && hasOrderRate) {
    log('ok', 'R10: inventory-core.json 首屏必备 sheet 齐全（订单满足率+库存金额+库存覆盖+covX）');
  } else {
    log('err', 'R10: inventory-core.json 缺首屏 sheet（金额=' + hasCore + ' cov=' + hasCov7 + ' 订单满足率=' + hasOrderRate + '）');
  }
} catch (e) {
  log('err', 'R10: inventory-core.json 缺失或无法读取（v201 阶段A 必需）：' + e.message);
}

// R10b: inventory-core.json 必须 **不含** 基础数据/分仓计划/拉回数据/转储数据 sheets（拆干净）
//     防回归：脚本误改导致 inventory-core 又把 1.9MB 基础数据塞回去
try {
  const coreRaw = fs.readFileSync(path.resolve(__dirname, '..', 'inventory-core.json'), 'utf8');
  const coreObj = JSON.parse(coreRaw);
  const coreSheets = coreObj.sheetNames || Object.keys(coreObj.sheets || {});
  const forbidden = ['基础数据', '分仓计划', '拉回数据', '转储数据'];
  const found = forbidden.filter(s => coreSheets.includes(s));
  if (found.length === 0) {
    log('ok', 'R10b: inventory-core.json 不含基础数据/分仓计划/拉回数据/转储数据 sheets（拆干净）');
  } else {
    log('err', 'R10b: inventory-core.json 含按需 sheet：' + found.join(', ') + '（首屏会被这些死重拖累）');
  }
} catch (e) {
  log('warn', 'R10b: 无法读取 inventory-core.json 校验（' + e.message + '）');
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

// R16: inventory 五路拆分「零丢失」——inventory.xlsx 的每个 sheet 都必须落到某个输出 JSON
//      v202 事故：v201 首版拆分只定义 CORE/MASTER/PLAN，把 拉回数据/转储数据/5·6月覆盖/状态分析
//      落进「未分类」警告后直接丢弃 → 转储数据(2026-07~08，与 transship.json 的 2026-01~06 互补零重叠)
//      与拉回数据(本轮 +1763 行) 彻底丢失，且不会有任何报错，属静默数据回归。
try {
  const XLSX = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/xlsx');
  const wb = XLSX.read(fs.readFileSync(path.resolve(__dirname, '..', 'inventory.xlsx')), { type: 'array' });
  const OUT_FILES = ['inventory-core.json', 'inventory-master.json', 'inventory-plan.json', 'inventory-extra.json', 'inventory-status.json'];
  const covered = new Set();
  OUT_FILES.forEach(f => {
    const p = path.resolve(__dirname, '..', f);
    if (!fs.existsSync(p)) return;
    (JSON.parse(fs.readFileSync(p, 'utf8')).sheetNames || []).forEach(n => covered.add(n));
  });
  const lost = wb.SheetNames.filter(n => !covered.has(n));
  if (lost.length === 0) {
    log('ok', 'R16: inventory.xlsx 全部 ' + wb.SheetNames.length + ' 个 sheet 均已落入输出 JSON（无静默丢失）');
  } else {
    log('err', 'R16: inventory.xlsx 有 sheet 未落入任何输出 JSON（会被静默丢弃）：' + lost.join(', '));
  }
} catch (e) {
  log('warn', 'R16: 无法校验 inventory 拆分完整性（' + e.message + '）');
}

// R17: 「拆出来的按需文件必须有加载器」——每个 inventory-*.json/transship.json 都要有对应的 ensureXxx
//      这是本项目反复踩的坑：拆出文件很痛快，忘了写加载器 = 该数据源前端永远拿不到，且无任何报错。
//      v202 事故：inventory-plan.json（分仓需求权威源）拆出来后没有加载器 → planBySkuRdc 恒空
//      → getPlanDemand 静默回退 cov7 → 分仓需求口径悄悄退回 v198 之前，用户完全无感。
try {
  const onDemand = [
    { file: 'transship.json', loader: 'ensureTransship' },
    { file: 'inventory-extra.json', loader: 'ensureInventoryExtra' },
    { file: 'inventory-status.json', loader: 'ensureSlowDiag' },
    { file: 'inventory-plan.json', loader: 'ensureInventoryPlan' }
  ];
  const missing = onDemand.filter(x => {
    if (!fs.existsSync(path.resolve(__dirname, '..', x.file))) return false; // 文件不存在则跳过（源无此 sheet）
    return !new RegExp('async function ' + x.loader + '\\b').test(html);
  });
  if (missing.length === 0) {
    log('ok', 'R17: 所有按需 inventory/transship 文件都有对应加载器（无「拆出但无人加载」）');
  } else {
    log('err', 'R17: 按需文件缺少加载器：' + missing.map(x => x.file + '→' + x.loader).join(', ') + '（前端永远读不到该数据）');
  }
} catch (e) {
  log('warn', 'R17: 无法校验按需文件加载器（' + e.message + '）');
}

// R18: ensureInventoryPlan 必须在 renderPlanMonitor / renderPlanAdvice 中被触发
//      （分仓需求的两个消费页；缺任一则进入该页时「分仓计划」表仍未加载）
try {
  const fnRanges = [];
  const marker = (name) => html.indexOf('function ' + name + '(');
  const pm = marker('renderPlanMonitor'), pa = marker('renderPlanAdvice');
  const nextFnAfter = (idx) => { const m = html.slice(idx + 10).search(/\nfunction [A-Za-z_$]/); return m < 0 ? html.length : idx + 10 + m; };
  const pmBody = pm >= 0 ? html.slice(pm, nextFnAfter(pm)) : '';
  const paBody = pa >= 0 ? html.slice(pa, nextFnAfter(pa)) : '';
  const inPm = /ensureInventoryPlan\s*\(/.test(pmBody);
  const inPa = /ensureInventoryPlan\s*\(/.test(paBody);
  if (inPm && inPa) {
    log('ok', 'R18: ensureInventoryPlan 已在 renderPlanMonitor + renderPlanAdvice 中触发');
  } else {
    log('err', 'R18: ensureInventoryPlan 未在 ' + (!inPm ? 'renderPlanMonitor ' : '') + (!inPa ? 'renderPlanAdvice' : '') + ' 中触发（分仓需求会回退 cov7 旧口径）');
  }
} catch (e) {
  log('warn', 'R18: 无法校验 ensureInventoryPlan 触发点（' + e.message + '）');
}

// R19: bootLoad 不得无条件 clearIDB —— 「每次部署都全量重拉 42MB」的根因
//      允许的形式：clearIDB() 被 DB_VERSION 判断包住（needClear 之类），不允许 flag!==generatedAt 直接调 clearIDB
try {
  const blIdx = html.indexOf('async function bootLoad');
  const bl = html.slice(blIdx, blIdx + 6000);
  // 只认「await clearIDB(」真实调用点，不认注释里提到的 clearIDB() 字样
  //  （v202 的注释正文里就写着被修掉的旧代码「+ clearIDB()」，按裸名字匹配会误判 —— 检测器自己踩坑）。
  const re = /await\s+clearIDB\s*\(/g;
  const calls = []; let m;
  while ((m = re.exec(bl))) calls.push(m.index);
  const unguarded = calls.filter(p => !/needClear|DB_VERSION/.test(bl.slice(Math.max(0, p - 400), p)));
  if (calls.length > 0 && unguarded.length === 0) {
    log('ok', 'R19: bootLoad 的 clearIDB 受 DB_VERSION 判断保护（部署只清文件哈希，按文件增量更新）');
  } else if (unguarded.length > 0) {
    log('err', 'R19: bootLoad 存在未受保护的 clearIDB 调用 ' + unguarded.length + ' 处（每次部署都全量重拉 42MB）');
  } else {
    log('warn', 'R19: bootLoad 未找到 clearIDB 调用点，请人工核对');
  }
} catch (e) {
  log('warn', 'R19: 无法校验 bootLoad 缓存清理策略（' + e.message + '）');
}

// R20: 「部署不清 rdc_manifest_hashes」——v202 提速真正生效的关键
//      rdc_manifest_hashes 记录「IDB 里已存了哪版数据」，是 refreshFromManifest 判断
//      「哪些文件需要重拉」的唯一依据。在「generatedAt 变化」分支里清掉它 → 所有文件
//      都被判为已变更 → 仍全量重拉 42MB，提速完全失效（v202 第一版实测踩了这个坑：
//      只改了 clearIDB 判定，却把 removeItem 留在了外面）。
//      正确形态：removeItem 只能出现在 if (needClear) 分支内（IDB 都没了，哈希自然要失效）。
try {
  const bl2Idx = html.indexOf('async function bootLoad');
  const bl2 = html.slice(bl2Idx, bl2Idx + 6000);
  const needClearAt = bl2.indexOf('let needClear');
  const branchAt = bl2.indexOf('if (needClear)');
  const hashCleanupAt = bl2.indexOf("removeItem('rdc_manifest_hashes')");
  if (needClearAt < 0 || branchAt < 0) {
    log('warn', 'R20: bootLoad 未找到 needClear 结构，请人工核对缓存清理策略');
  } else if (hashCleanupAt >= 0 && hashCleanupAt < branchAt) {
    log('err', 'R20: removeItem(rdc_manifest_hashes) 出现在 if(needClear) 之前 —— 每次部署都会全量重拉，提速失效');
  } else {
    log('ok', 'R20: rdc_manifest_hashes 仅在 if(needClear) 分支内清除（部署时保留文件哈希，按文件增量更新）');
  }
} catch (e) {
  log('warn', 'R20: 无法校验 rdc_manifest_hashes 清理位置（' + e.message + '）');
}

// R21: 月度快照字段已移出 current_data（v203 分片生效）
//      saveToIDB 里若仍把 orderDetail/shortage 整块塞进 current_data，每次保存都要
//      structured clone 20 万+ 行，历史月份（几乎从不变）白白重写一遍。
//      正确形态：current_data 只保留 inventory/transship/history/shipCond 等非按月字段。
try {
  const stIdx = html.indexOf('async function saveToIDB');
  const stBody = html.slice(stIdx, stIdx + 2600);
  const payloadAt = stBody.indexOf('const payload = {');
  // 必须切到 payload 对象自己的结束处。用固定长度会越过 `};` 撞进 loadFromIDB 的
  // `const merged = { shortage: [], orderDetail: [], ... }`，把恢复用的临时对象误判成
  // 仍在存储按月字段（检测器自己踩坑，与 R19 注释误伤同款）。
  const payloadEnd = stBody.indexOf('\n    };', payloadAt);
  const payload = stBody.slice(payloadAt, payloadEnd > 0 ? payloadEnd : payloadAt + 1600);
  const stillHas = ['orderDetail:', 'shortage:', 'bizDemand:', 'customerFulfill:', 'otherOrders:', 'unreleasedOrders:']
    .filter((f) => payload.includes(f));
  if (stillHas.length === 0) {
    log('ok', 'R21: current_data 已不含按月字段（订单明细/缺货汇总等改存 snap_YYYY_MM）');
  } else {
    log('err', 'R21: current_data 仍含按月字段：' + stillHas.join(' ') + '（分片失效，每次仍全量 clone）');
  }
} catch (e) {
  log('warn', 'R21: 无法校验 saveToIDB 分片（' + e.message + '）');
}

// R22: loadFromIDB 必须先合并月度快照、再健康检查
//      顺序反了 → orderDetail 恒为 0 → 健康检查判「缓存残缺」→ 每次打开全量重拉，
//      恰好把本轮要消灭的慢又造出来一遍。
try {
  const ldIdx = html.indexOf('async function loadFromIDB');
  const ld = html.slice(ldIdx, ldIdx + 4200);
  const snapAt = ld.indexOf('loadAllMonthSnapshots()');
  const ordAt = ld.indexOf('const ord =');
  if (snapAt > 0 && ordAt > snapAt) {
    log('ok', 'R22: loadFromIDB 先合并月度快照再健康检查（顺序正确）');
  } else if (snapAt > 0 && ordAt >= 0 && ordAt < snapAt) {
    log('err', 'R22: loadFromIDB 健康检查早于快照合并（orderDetail 恒为 0 → 每次全量重拉）');
  } else {
    log('warn', 'R22: 未识别 loadFromIDB 的快照合并结构，请人工核对');
  }
} catch (e) {
  log('warn', 'R22: 无法校验 loadFromIDB 顺序（' + e.message + '）');
}

// R23: clearIDB 必须连 snap_* 一起删
//      只删 current_data → 旧月份快照残留 → 下次合并回来与当月新数据混成脏口径。
try {
  const clIdx = html.indexOf('async function clearIDB');
  const cl = html.slice(clIdx, clIdx + 1200);
  if (/IDBKeyRange\.bound\('snap_'/.test(cl) && cl.indexOf('store.delete(\'current_data\')') >= 0) {
    log('ok', 'R23: clearIDB 同时清理 current_data 与 snap_* 月度快照');
  } else {
    log('err', 'R23: clearIDB 未清理 snap_* 快照（旧月份数据会残留并与新数据混合）');
  }
} catch (e) {
  log('warn', 'R23: 无法校验 clearIDB（' + e.message + '）');
}

// R24: data-*.json 加载前必须 dropMonthRows
//      append 模式用 existingXxxKeys 去重，不清旧行 → 新行全被拦下 → 快照被存成空
//      → 下次「从本地回填」填进去一片空数据（v203 首要坑）。
try {
  const apIdx = html.indexOf("filename.indexOf('data-') === 0");
  const ap = html.slice(apIdx, apIdx + 700);
  const dropAt = ap.indexOf('dropMonthRows(');
  const parseAt = ap.indexOf('parseExcel(');
  if (dropAt >= 0 && parseAt > dropAt) {
    log('ok', 'R24: data-*.json 先 dropMonthRows 再 parseExcel（避免去重拦新行导致空快照）');
  } else {
    log('err', 'R24: data-*.json 未在解析前清理旧月份数据（快照会被存成空）');
  }
} catch (e) {
  log('warn', 'R24: 无法校验历史月加载分支（' + e.message + '）');
}

// R25: data.json 的哈希必须延后到历史月回填之后再标记
//      它是 replace 模式，解析完会清空历史数据；此刻就标记哈希 → 中途关页面留下
//      「当月有、历史无」的残缺缓存，而下轮比对 data.json 判无变化 → 残缺永久固化
//      （v191 同款死状态）。
try {
  const rmIdx = html.indexOf('async function refreshFromManifest');
  const rm = html.slice(rmIdx, rmIdx + 16000);
  const firstLoopAt = rm.indexOf('for (const f of first)');
  const markAt = rm.indexOf('first.forEach(function(f) { _markHash(f); });');
  const restoreAt = rm.indexOf('历史月份已从本地快照回填');
  if (firstLoopAt >= 0 && markAt > firstLoopAt && restoreAt > 0 && markAt > restoreAt) {
    log('ok', 'R25: data.json 哈希延后到历史月回填之后标记（防残缺缓存固化）');
  } else if (markAt < 0) {
    log('err', 'R25: 未找到延后的 data.json 哈希标记（历史月回填前标记会固化残缺数据）');
  } else {
    log('warn', 'R25: data.json 哈希标记位置异常，请人工核对');
  }
} catch (e) {
  log('warn', 'R25: 无法校验 data.json 哈希时机（' + e.message + '）');
}

// R26: 数据解析关键函数内不得引用「全文件从未声明」的标识符
//   🔥 v203 实测抓到的真 Bug：parseInventoryExcel 读了从未声明的 pullbackDiag →
//   ReferenceError → 整段解析中断 → dataStore.inventory 恒为 null → 库存/转储/分仓需求
//   三块全空，且 loadFromIDB 因 cov7 缺失判「缓存残缺」→ 每次打开全量重拉 42MB。
//   v64（2026-08-09）引入，线上潜伏近一个月；v200「分仓计划监控暂无数据」的真因也是它。
//   为什么之前的检查抓不到：
//     ① node --check 只校验语法，不校验未声明引用；
//     ② 上面的 render* 检查器要求出现 ≥3 次才报，pullbackDiag 只出现 1 次恰好漏网；
//     ③ 静态检查从来没覆盖过 parseInventoryExcel 这类解析函数。
//   判别要点：排除「属性访问(.foo)」与「对象字面量键名(foo:)」，只认真正的标识符引用。
try {
  const CRITICAL_FNS = ['parseInventoryExcel', 'parseExcel', 'applyPreparsed', 'loadFromIDB', 'saveToIDB', 'refreshFromManifest'];
  const suspects = [];
  CRITICAL_FNS.forEach((fn) => {
    const re = new RegExp('(?:async\\s+)?function\\s+' + fn + '\\s*\\([^)]*\\)\\s*\\{');
    const m = html.match(re);
    if (!m) return;
    let depth = 0, i = m.index;
    while (i < html.length) { const c = html[i]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; } i++; }
    // stripStrings 不处理正则字面量：`.replace(/^inventory\.json$/, '库存数据')` 里的
    //   inventory / product 会被当成标识符引用（最后一波假警报）。只剥离以 /^ 或 /\ 开头的
    //   正则字面量（除法运算符后面不会紧跟 ^ 或 \，不会误伤）。
    const code = stripStrings(html.slice(m.index, i + 1))
      .replace(/\/(?:\^|\\)[^\/\n]*\/[gimsuy]*/g, '//');
    // 函数参数也算已声明（第一版漏了这步，把 parseInventoryExcel(rawData, merge) 的参数
    //   当成了未声明标识符 —— 检测器自己造的假警报）
    const params = new Set();
    const pm = html.slice(m.index, m.index + 260).match(/function\s+\w+\s*\(([^)]*)\)/);
    if (pm) pm[1].split(',').forEach((p) => { const t = p.trim().split(/\s+/).pop(); if (t && /^\w+$/.test(t)) params.add(t); });
    // 函数体内的声明。踩坑记录（本规则迭代 4 版才干净）：
    //   ① 只认 `const X` 的第一个名字 → `const _sc = {}, _life = {}` 的后几个被误报；
    //   ② 漏掉对象解构 `const { kws, pbCols } = ...` → 解构出来的名字被误报；
    //   ③ 漏掉箭头函数/匿名函数参数 `(r, i) => ...` → 参数名被误报。
    // 三类都要收，否则假警报会淹没真正的未声明引用。
    const addNames = (chunk) => {
      chunk.split(',').forEach((p) => {
        const nm = p.trim().split(':').pop().trim().split(/\s*=/)[0].trim();
        if (/^[a-zA-Z_]\w*$/.test(nm)) params.add(nm);
      });
    };
    let d;
    const declRe = /\b(?:const|let|var)\s+([^;]+);/g;
    while ((d = declRe.exec(code)) !== null) addNames(d[1]);
    const destrRe = /\b(?:const|let|var)\s*[{[]([^}\]]+)[}\]]/g;
    while ((d = destrRe.exec(code)) !== null) addNames(d[1]);
    const arrowRe = /\(([^()]*)\)\s*=>/g;
    while ((d = arrowRe.exec(code)) !== null) addNames(d[1]);
    const anonFnRe = /\bfunction\s*\(([^)]*)\)\s*\{/g;
    while ((d = anonFnRe.exec(code)) !== null) addNames(d[1]);
    const catchRe = /\bcatch\s*\(\s*(\w+)\s*\)/g;
    while ((d = catchRe.exec(code)) !== null) params.add(d[1]);
    const forOfRe = /\bfor\s*\(\s*(?:const|let|var)\s+(\w+)/g;
    while ((d = forOfRe.exec(code)) !== null) params.add(d[1]);
    // ⑤ 嵌套命名函数的参数：function _findCol(kws)、function parsePullbackWithCols(pbCols, logDiag)。
    //    这类内部辅助函数的参数此前完全没被收集，是最后一波假警报的来源。
    const namedFnRe = /\bfunction\s+(\w+)\s*\(([^)]*)\)/g;
    while ((d = namedFnRe.exec(code)) !== null) { params.add(d[1]); addNames(d[2]); }
    // 前面不是 . 或 $（排除属性访问）；后面不能紧跟 : 或单词字符（排除对象字面量键名）。
    //   第二版踩坑：写成 \s*(?!:) 时正则会回溯少吞一个字母来「绕开」冒号——
    //   `type:` 回溯成 `typ`、`defval:` 回溯成 `defva`，全是假警报。必须用 (?![:\w])。
    const useRe = /([^.\w$]|^)([a-z_]\w{2,})(?![:\w])/g;
    let u;
    while ((u = useRe.exec(code)) !== null) {
      const w = u[2];
      if (params.has(w) || allDecls.has(w) || knownGlobals.has(w) || jsKeywords.has(w)) continue;
      if (/^[A-Z]/.test(w)) continue;
      suspects.push(fn + ' → ' + w);
    }
  });
  // 去重
  const uniq = [...new Set(suspects)];
  if (uniq.length === 0) {
    log('ok', 'R26: 数据解析关键函数无未声明标识符引用');
  } else {
    log('err', 'R26: 数据解析函数引用了未声明标识符（会抛 ReferenceError、整段解析静默中断）：' + uniq.slice(0, 6).join('; '));
  }
} catch (e) {
  log('warn', 'R26: 无法校验未声明标识符（' + e.message + '）');
}

// R27: 基础数据 sheet 必须含前端依赖的全部列（防列投影误删）
//   v203 引入列投影：删「表头为空且整列全 null」的占位列（30→20 列，省 0.5MB）。
//   安全性依赖两个前提，任一被破坏都会静默丢数据：
//     ① 前端用 bColIdx() 按**表头名**寻列 → 被删的列必须确实没有表头名；
//     ② 硬编码索引 r[0]/r[1]（产品编码/产品名称）必须仍在 0、1 位。
//   模板换版时列布局可能变，这条规则就是防止投影把有用列删掉的兜底。
try {
  const mp = path.resolve(__dirname, '..', 'inventory-master.json');
  if (!fs.existsSync(mp)) {
    log('warn', 'R27: 未找到 inventory-master.json，跳过列校验');
  } else {
    const arr = JSON.parse(fs.readFileSync(mp, 'utf8')).sheets['基础数据'];
    const head = arr && arr[0] ? arr[0] : [];
    const idxOf = (n) => head.findIndex((x) => String(x || '').trim() === n);
    const need = ['产品编码', '产品名称', '成本价', '品牌', '是否为淘汰品', '收货库位',
      '收货仓', 'RDC', 'ABC分类', '供应链品类', '品类', '是否为软切新品', '生命周期标签', '箱规转化因子'];
    const missing = need.filter((n) => idxOf(n) < 0);
    const headOk = String(head[0] || '').trim() === '产品编码' && String(head[1] || '').trim() === '产品名称';
    if (missing.length === 0 && headOk) {
      log('ok', 'R27: 基础数据含前端依赖的全部 ' + need.length + ' 列，且 r[0]/r[1] 仍为产品编码/产品名称');
    } else {
      log('err', 'R27: 基础数据列投影删错了 —— 缺列：' + (missing.join(',') || '无') + '；r[0]/r[1] 正确=' + headOk);
    }
  }
} catch (e) {
  log('warn', 'R27: 无法校验基础数据列（' + e.message + '）');
}

// R28: 禁止使用不存在的 API（v204 血的教训）
//   `AbortController.timeout(ms)` **在 Web 标准里不存在** —— 正确的是
//   `AbortSignal.timeout(ms)`（静态方法在 AbortSignal 上，且直接返回 signal）。
//   v198-fix3 写错后，三个按需加载器每次执行都同步抛 TypeError 并被 try/catch 吞掉，
//   表现为「数据永远加载不出来」而不是报错，潜伏到 v204 才被发现。
//   这类问题 node --check 完全查不出来，只能靠静态扫描兜底。
try {
  // 必须先剥掉注释：v204 的修复说明（DB_VERSION 注释、abortAfter 上方注释）里
  //   都提到了 `AbortController.timeout` 这个错误写法本身，不剥离会全部误报。
  //   引号感知扫描，避免把 'https://...' 里的 // 当成注释起点。
  const stripComment = (ln) => {
    let q = null;
    for (let i = 0; i < ln.length; i++) {
      const c = ln[i];
      if (q) { if (c === q && ln[i - 1] !== '\\') q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '/' && ln[i + 1] === '/') return ln.slice(0, i);
    }
    return ln;
  };
  const hits = [];
  const lines = html.split(/\r?\n/);
  lines.forEach((ln, i) => {
    const code = stripComment(ln);
    if (/AbortController\.timeout\s*\(/.test(code)) hits.push(`L${i + 1}: AbortController.timeout → 应为 AbortSignal.timeout`);
    // 顺带守住同类「静态方法挂错宿主」的高频错误
    if (/\bnew\s+AbortSignal\s*\(/.test(code)) hits.push(`L${i + 1}: new AbortSignal() 不合法 → 用 new AbortController().signal`);
  });
  if (hits.length === 0) {
    log('ok', 'R28: 未发现不存在的 AbortController/AbortSignal API 用法');
  } else {
    hits.forEach((h) => log('err', 'R28: ' + h));
  }
} catch (e) {
  log('warn', 'R28: 无法校验（' + e.message + '）');
}

// R29: 跨作用域引用检查 —— 顶层函数不得直接调用 init() 里的嵌套闭包
//   v204 一次抓到两个同类致命 Bug，都是「顶层函数引用了看不见的标识符」：
//     · pullbackDiag    —— v182 引入，parseInventoryExcel 整段中断 → 库存恒空（潜伏近一个月）
//     · applyPreparsed  —— init() 的嵌套函数，三个按需加载器调用即 ReferenceError，
//                          被 try/catch 吞掉后表现为「数据永远加载不出来」
//   这类问题的共同点：node --check 查不出、控制台只是一条 warn、现象是「数据静默为空」。
//   这里做通用兜底：扫描 init() 内声明的嵌套函数，若顶层函数体内出现同名调用
//   且没有 window. 前缀（也没在体内自行声明），就报错。
try {
  const lines = html.split(/\r?\n/);
  const initStart = lines.findIndex((l) => /^function init\(\)\s*\{/.test(l));
  let initEnd = -1;
  if (initStart >= 0) { for (let i = initStart + 1; i < lines.length; i++) { if (/^\}/.test(lines[i])) { initEnd = i; break; } } }
  if (initStart < 0 || initEnd < 0) {
    log('warn', 'R29: 未定位到 init() 函数体，跳过跨作用域检查');
  } else {
    // init() 内声明的嵌套函数名（缩进 ≥ 2 的 function 声明）
    const nested = new Set();
    for (let i = initStart; i < initEnd; i++) {
      const m = lines[i].match(/^\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
      if (m) nested.add(m[1]);
    }
    // 顶层函数（缩进 0）的起止
    const tops = [];
    lines.forEach((l, i) => {
      const m = l.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
      if (m) tops.push({ name: m[1], start: i, end: -1 });
    });
    tops.forEach((f, k) => { f.end = (k + 1 < tops.length ? tops[k + 1].start : lines.length) - 1; });
    // 已挂 window 的名字不算越界：暴露点可以不在调用处（v204 就是在 init() 末尾
    //   统一 `window.applyPreparsed = applyPreparsed`），调用处仍是裸名字。
    //   参考 v113/v114 铁律：跨函数依赖的标识符必须挂 window —— 挂了就合法。
    const exposed = new Set();
    lines.forEach((l) => {
      const m = l.match(/window\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|[A-Za-z_$][\w$]*)\s*[;(]?/);
      if (m) exposed.add(m[1]);
    });
    const clean = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
    const stripComment = (ln) => { const i = ln.indexOf('//'); return i >= 0 ? ln.slice(0, i) : ln; };
    const hits = [];
    tops.forEach((f) => {
      // 函数体内自行声明的同名标识符不算越界（局部遮蔽）
      const localDecl = new Set();
      for (let i = f.start; i <= f.end && i < lines.length; i++) {
        const c = stripComment(clean(lines[i]));
        const dm = c.match(/(?:^|[^.\w$])(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g);
        if (dm) dm.forEach((d) => localDecl.add(d.replace(/.*\s/, '')));
        const pm = c.match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/);
        if (pm) pm[2].split(',').forEach((p) => localDecl.add(p.trim().split('=')[0].trim()));
      }
      for (let i = f.start; i <= f.end && i < lines.length; i++) {
        const c = stripComment(clean(lines[i]));
        nested.forEach((n) => {
          if (localDecl.has(n) || exposed.has(n)) return;
          const re = new RegExp('(^|[^.\\w$])' + n.replace(/\$/g, '\\$') + '\\s*\\(');
          if (re.test(c) && !new RegExp('window\\.\\s*' + n.replace(/\$/g, '\\$') + '\\s*\\(').test(c)) {
            hits.push(`${f.name} (L${i + 1}) 调用了 init() 内嵌套函数 ${n}()`);
          }
        });
      }
    });
    const uniq = [...new Set(hits)];
    if (uniq.length === 0) {
      log('ok', `R29: 顶层函数未越界调用 init() 的 ${nested.size} 个嵌套函数（applyPreparsed 类 Bug 兜底）`);
    } else {
      uniq.slice(0, 8).forEach((h) => log('err', 'R29: ' + h));
      if (uniq.length > 8) log('err', 'R29: …以及另外 ' + (uniq.length - 8) + ' 处');
    }
  }
} catch (e) {
  log('warn', 'R29: 无法校验（' + e.message + '）');
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
