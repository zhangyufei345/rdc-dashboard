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
  'renderBizDemand', 'renderBizDemandDetail', 'renderBizDemandDACR'
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
  if (covCode.match(/cov07:\s*getSN\(r,\s*23\)/)) {
    log('ok', 'cov07=col23 (2026-07) 映射正确');
  } else {
    log('err', 'cov07 列映射可能错了，应该是 col23');
  }
} else {
  log('warn', 'parseCoverageSheet 函数找不到');
}

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
