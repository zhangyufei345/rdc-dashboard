# -*- coding: utf-8 -*-
"""v453 补丁：新增第 7 类归因 E「计划口径变动」+ 引入 dp-history.json

背景（用户 2026-11-04 个案核查 → 全量核查）：
  10 月「严重度高重点跟进清单」58 行、D 类 17 行，其中 8 行是假 D ——
  计划员在缺货发生之后把 DP 共识数量上调，使完成率从「超销」翻成「滞后」，
  归因落到 D「需重点排查」（语义=查运输/排单/库位），处置方向与实际原因（计划被低估）完全相反。
  实证 40057·华北：缺货前计划 2,000、出货 9,576=478.8%；10-27 计划改 13,000 → 73.7% → D。

改法：
  ① 新增数据源 dp-history.json（tools/build_dp_history.py 生成，git 历史回填）
  ② buildHiAttribution 里对「原本会判 D」的行做一次翻转测试，命中则改判 E
  ③ 归因卡片/下拉/筛选/CSV 自动多出 E（attrOrder 驱动，栅格 auto-fit 不破版）
"""
import io
import sys

P = 'rdc-dashboard.html'
s = io.open(P, encoding='utf-8', newline='').read()
orig_len = len(s)
assert '\r\n' in s, '文件应为 CRLF'
n_edit = 0


def rep(old, new, tag):
    global s, n_edit
    assert s.count(old) == 1, '%s: 命中 %d 次（应为 1）' % (tag, s.count(old))
    s = s.replace(old, new)
    n_edit += 1
    print('  ✅ %s' % tag)


def block(lines):
    return '\r\n'.join(lines)


# ---------- P1: 版本号 ----------
rep('const BUILD_VERSION = 452;', 'const BUILD_VERSION = 453;', 'P1 BUILD_VERSION 452→453')

# ---------- P2: 数据加载器 + 判据（插在 buildHiAttribution 之前）----------
ANCHOR = 'function buildHiAttribution(hi, period) {'
LOADER = block([
    '// ===== v453: DP 逐次切片（dp-history.json）=====',
    '// 为什么需要：页面运行态只有 DP 的**期末值**（demand.json 的 plan），没有逐日切片。',
    '//   而计划员在月中/月末把 DP 往上调，会让「出货 < 计划」这个判据的分母被改过 ——',
    '//   完成率从超销翻成滞后，归因落到 D「需重点排查」（语义=查运输/排单/库位），',
    '//   处置方向与实际原因（计划被低估）完全相反。',
    '// 数据：dp-history.json 由 tools/build_dp_history.py 生成（git 历史回填 + 每次部署合并）。',
    '//   结构：{ months: { "2026-10": { "40057|华北RDC": { revs: [[日期, DP], ...], fs: "首次缺货日" } } } }',
    '//   key = normSkuCode(sku) + "|" + normalizeRdcName(rdc)，与 buildPlanSkuAgg 完全一致。',
    '//   只有变化点（revs 长度 > 1 才有意义）。',
    '// 🔴 判据（严格三条件同时成立才改判 E）：',
    '//   ① 计划确实被上调过（期末值 > 缺货发生时的值）',
    '//   ② 按「缺货发生时的计划」算完成率 ≥ 100%（当时并不滞后，是超销/达标）',
    '//   ③ 按「期末计划」算完成率 < 100%（所以才被判成滞后 D）',
    '//   缺失 dp-history.json 时全部返回 null → 归因退化为 v452 行为，不影响其他功能。',
    'window._dpHist = window._dpHist || null;',
    'window._dpHistLoading = false;',
    'window._dpHistError = null;',
    '',
    'function ensureDpHistory() {',
    '  if (window._dpHist || window._dpHistLoading) return;',
    '  window._dpHistLoading = true;',
    '  window._dpHistError = null;',
    '  fetch("./dp-history.json", { cache: "no-cache", signal: (typeof abortAfter === "function" ? abortAfter(30000) : undefined) })',
    '    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })',
    '    .then(function (j) {',
    '      window._dpHist = j || null;',
    '      window._dpHistLoading = false;',
    '      // 到位后补渲染一次，让已渲染的清单立刻带上 E（否则要等用户下次刷新）',
    '      try { if (typeof renderPage === "function") renderPage("shortage"); } catch (e) {}',
    '    })',
    '    .catch(function (e) {',
    '      window._dpHistLoading = false;',
    '      window._dpHistError = (e && e.message) ? e.message : String(e);',
    '      // 诚实降级：不静默假装没有计划变动，控制台留痕',
    '      console.warn("[ensureDpHistory] dp-history.json 不可用：" + window._dpHistError +',
    '        " → 归因不会出现 E 计划口径变动（其余功能不受影响）");',
    '    });',
    '}',
    'window.ensureDpHistory = ensureDpHistory;',
    '',
    '// 取某 SKU×RDC×月 的计划变动证据；无记录 / 未加载 / 不满足三条件 → null',
    'function _dpRevEvidence(sku, rdc, month, shippedQty) {',
    '  var h = window._dpHist && window._dpHist.months && window._dpHist.months[month];',
    '  if (!h) return null;',
    '  var rec = h[normSkuCode(sku) + "|" + normalizeRdcName(rdc)];',
    '  if (!rec || !rec.revs || rec.revs.length < 2) return null;',
    '  var revs = rec.revs, fs = rec.fs || null;',
    '  var planFinal = revs[revs.length - 1][1];',
    '  // 缺货发生时的计划 = 首个缺货日当天或之前最后一次生效的值',
    '  //   （首缺日早于首个切片 → 退化为最早已知值，这是可知的最低计划）',
    '  var planLow = revs[0][1], planLowDate = revs[0][0];',
    '  if (fs) {',
    '    for (var i = 0; i < revs.length; i++) {',
    '      if (revs[i][0] <= fs) { planLow = revs[i][1]; planLowDate = revs[i][0]; } else break;',
    '    }',
    '  }',
    '  if (!(planLow > 0)) return null;          // 计划为 0/无值 → 口径不同，不判',
    '  if (!(planFinal > planLow)) return null;  // 没被上调过（含被下调）→ 保持原归因',
    '  // 最大单次上调（用于文案：计划于 X 由 A 上调至 B，N 倍）',
    '  var best = null;',
    '  for (var k = 1; k < revs.length; k++) {',
    '    var pv = revs[k - 1][1], nv = revs[k][1];',
    '    if (pv > 0 && nv > pv) {',
    '      var rt = nv / pv;',
    '      if (!best || rt > best.ratio) best = { ratio: rt, date: revs[k][0], from: pv, to: nv };',
    '    }',
    '  }',
    '  var ship = Number(shippedQty);',
    '  if (!isFinite(ship) || ship <= 0) return null;',
    '  var compLow = ship / planLow;',
    '  var compEnd = ship / planFinal;',
    '  if (!(compLow >= 1)) return null;   // 按缺货前的计划本来也没达标 → 真滞后，不改判',
    '  if (!(compEnd < 1)) return null;    // 按期末计划也没滞后 → 本来就不会是 D',
    '  return {',
    '    planLow: planLow, planLowDate: planLowDate, planFinal: planFinal,',
    '    compLow: compLow, compEnd: compEnd, firstShort: fs,',
    '    raiseRatio: best ? best.ratio : 0,',
    '    raiseDate: best ? best.date : null,',
    '    raiseFrom: best ? best.from : null,',
    '    raiseTo: best ? best.to : null',
    '  };',
    '}',
    'window._dpRevEvidence = _dpRevEvidence;',
    '',
    '// 供 UI 悬浮提示 / CSV 导出的一句人话；无证据 → 空串',
    'function _dpRevText(rv) {',
    '  if (!rv) return "";',
    '  var f = function (v) { return Number(v).toLocaleString(); };',
    '  return "计划于 " + (rv.raiseDate || "?") + " 由 " + f(rv.raiseFrom) + " 上调至 " + f(rv.raiseTo) +',
    '         "（" + rv.raiseRatio.toFixed(1) + " 倍）；缺货发生时计划 " + f(rv.planLow);',
    '}',
    'window._dpRevText = _dpRevText;',
    '',
    '',
])
rep(ANCHOR, LOADER + ANCHOR, 'P2 插入 ensureDpHistory + _dpRevEvidence')

# ---------- P3: ATTR_TYPES 新增 E ----------
OLD_D = ("    D:  { label: '⚠️ 需重点排查',  color: '#374151', bg: '#F3F4F6', desc: "
         "'总仓正常 + 销售进度落后自然日进度 → 可能是运输/排单/库位问题，需重点排查',      order: 5 },")
NEW_D = OLD_D + '\r\n' + ("    E:  { label: '📋 计划口径变动', color: '#0369A1', bg: '#E0F2FE', desc: "
                           "'总仓正常 + 计划在月内被上调 → 按缺货发生时的计划算并不滞后，滞后由期末回填造成，需复核计划而非查执行', order: 6 },")
rep(OLD_D, NEW_D, 'P3 ATTR_TYPES 新增 E')

# ---------- P4: attrOrder ----------
rep("var attrOrder = ['A1','A2','C1','C2','D']; // v368: 撤销 E(进度正常)，领先日历的并入超销 C1/C2",
    "var attrOrder = ['A1','A2','C1','C2','D','E']; // v453: 新增 E(计划口径变动)；v368: 原 E(进度正常) 已撤销，领先日历的并入超销 C1/C2",
    'P4 attrOrder 加入 E')

# ---------- P5: 类型判定 + results 字段 ----------
OLD_TYPE = block([
    "    else if (compInfo && dcs && shippedQty > 0 && lagCal) { type = 'D'; }",
    "    else                             { type = 'NA'; }",
    '',
    '    results.push({',
    '      idx: idx,',
    '      sku: p.sku,',
    '      rdc: p.rdc,',
    '      type: type,',
    '      attr: ATTR_TYPES[type],',
    '      compInfo: compInfo,',
    '      spComp: spComp,',
])
NEW_TYPE = block([
    "    else if (compInfo && dcs && shippedQty > 0 && lagCal) { type = 'D'; }",
    "    else                             { type = 'NA'; }",
    '',
    '    // v453: E「计划口径变动」—— 只对原本要判 D 的行做一次翻转测试。',
    '    //   D 的语义是「总仓正常但 RDC 执行有问题 → 查运输/排单/库位」，',
    '    //   但若计划在月内被上调，「出货 < 计划」的分母已被改过 → 处置方向应当改为复核计划。',
    '    //   三条件严格同时成立才改判（见 _dpRevEvidence）；缺 dp-history.json → planRev=null → 保持 D。',
    '    var planRev = null;',
    "    if (type === 'D' && typeof _dpRevEvidence === 'function') {",
    '      planRev = _dpRevEvidence(p.sku, p.rdc, period, shippedQty);',
    "      if (planRev) type = 'E';",
    '    }',
    '',
    '    results.push({',
    '      idx: idx,',
    '      sku: p.sku,',
    '      rdc: p.rdc,',
    '      type: type,',
    '      attr: ATTR_TYPES[type],',
    '      compInfo: compInfo,',
    '      spComp: spComp,',
    '      planRev: planRev,',
])
rep(OLD_TYPE, NEW_TYPE, 'P5 类型判定改判 E + results.planRev')

# ---------- P6: UI 归因单元格加证据小字 ----------
OLD_CELL = ")\">'+ar.type+' '+m.label+'</span>';"
# 注意：NEW_CELL 必须以 OLD_CELL 去分号的内容开头（保持 renderShortage() 的右括号和引号原样）
NEW_CELL = (OLD_CELL[:-1] +
            " + (ar.planRev ? '<div style=\"font-size:9px;color:#0369A1;margin-top:2px;white-space:nowrap\""
            " title=\"' + String(window._dpRevText(ar.planRev)).replace(/\"/g, '&quot;') +"
            "'\">计划 ' + String(ar.planRev.raiseDate || '').slice(5) + ' ↑' +"
            " ar.planRev.raiseRatio.toFixed(1) + 'x</div>' : '');")
rep(OLD_CELL, NEW_CELL, 'P6 归因单元格显示计划上调证据')

# ---------- P7: renderShortage 顶部触发加载 ----------
# 同款语句在 renderShortage(L9162) 与另一处(L24553) 各有一条 —— 必须带上下文定位，避免误改另一处
OLD_R = block([
    "  if (typeof _demandReady === 'function' && !_demandReady() && typeof ensureDemandMerged === 'function') ensureDemandMerged();",
    '',
    '  // Tab默认激活订单缺货明细分析',
])
NEW_R = block([
    "  if (typeof _demandReady === 'function' && !_demandReady() && typeof ensureDemandMerged === 'function') ensureDemandMerged();",
    '',
    '  // v453: DP 逐次切片（判定 E「计划口径变动」用）；失败时诚实降级为无 E，不影响本页其他功能',
    "  if (typeof ensureDpHistory === 'function') ensureDpHistory();",
    '',
    '  // Tab默认激活订单缺货明细分析',
])
rep(OLD_R, NEW_R, 'P7 renderShortage 触发 ensureDpHistory')

# ---------- P8: CSV 增加「计划口径变动」列 ----------
rep("    '归因类型', '归因名称', '分仓完成率(%)',",
    "    '归因类型', '归因名称', '分仓完成率(%)',\r\n    // v453: E 计划口径变动的证据（计划在何时由多少上调至多少），便于在 Excel 里复核与追责\r\n    '计划口径变动说明',",
    'P8a CSV 表头新增列')

OLD_ROW = ("        return [ar.type, ar.attr ? ar.attr.label : '', "
           "(ar.spComp != null ? (isFinite(ar.spComp)?(ar.spComp*100).toFixed(1):'\u221e') : "
           "(ci ? (ci.comp * 100).toFixed(1) : ''))];")
NEW_ROW = ("        return [ar.type, ar.attr ? ar.attr.label : '', "
           "(ar.spComp != null ? (isFinite(ar.spComp)?(ar.spComp*100).toFixed(1):'\u221e') : "
           "(ci ? (ci.comp * 100).toFixed(1) : '')), "
           "esc(ar.planRev && window._dpRevText ? window._dpRevText(ar.planRev) : '')];")
rep(OLD_ROW, NEW_ROW, 'P8b CSV 行新增证据列')
rep("        if (!attr) return ['','',''];",
    "        if (!attr) return ['','','',''];",
    'P8c CSV 空归因补第 4 列')
rep("        if (!ar) return ['','',''];",
    "        if (!ar) return ['','','',''];",
    'P8d CSV 无归因行补第 4 列')

# ---------- P9: 表头 tooltip + CSV 注释补 E ----------
# 两处都要改：① 归因列表头 tooltip ② 导出函数里的列注释
_OLD9 = '（A1总仓卡死 / A2部分紧张 / C1结构性超销 / C2偶发大单 / D需排查）'
_NEW9 = ('（A1总仓卡死 / A2部分紧张 / C1结构性超销 / C2偶发大单 / D需排查 / '
         'E计划口径变动：计划在月内被上调，滞后由期末回填造成的假象）')
assert s.count(_OLD9) == 2, 'P9 应为 2 处'
s = s.replace(_OLD9, _NEW9)
n_edit += 1
print('  ✅ P9 归因说明补 E（表头 tooltip + CSV 注释，共 2 处）')

bare = s.replace('\r\n', '').count('\n')
assert bare == 0, '写回前混入了 %d 个裸 LF' % bare
io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('\n共 %d 处改动，文件 %d → %d 字节' % (n_edit, orig_len, len(s)))
