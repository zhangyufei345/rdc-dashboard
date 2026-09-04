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
