# -*- coding: utf-8 -*-
"""v452 补丁：buildPlanSkuAgg 支持显式月份参数（缺货四象限的销售进度/归因跟随所选月份）
   —— 保持 CRLF 行尾，逐处断言唯一命中，前导空行不破坏结构。"""
import io, sys, re

P = 'rdc-dashboard.html'
s = io.open(P, encoding='utf-8', newline='').read()
crlf0 = s.count('\r\n')
bare0 = s.count('\n') - crlf0
assert bare0 == 0, '文件含裸 LF，先停下：bare=%d' % bare0

def rep1(old, new, label):
    global s
    n = s.count(old)
    assert n == 1, '❌ %s 命中 %d 次（应为 1）' % (label, n)
    s = s.replace(old, new, 1)
    print('✅ ' + label)

# ---- 1) 新增 _hasActualShipMonth 助手 + 函数签名 ----
old_head = ("//      （某个 RDC 滞后，但 SKU 整体早已超额）。\r\n"
            "function buildPlanSkuAgg() {\r\n")
new_head = (
"//      （某个 RDC 滞后，但 SKU 整体早已超额）。\r\n"
"// ===== v452: 判断 demand.json 的 actualShip 里到底有没有某个月的数 =====\r\n"
"//   用途：buildPlanSkuAgg(ym) 的分子口径分流 —— 有该月实际出货就严格用它（取不到即 0），\r\n"
"//         没有（2026-01~08 源表还没「分仓需求」sheet，属真·不可得）才回退该月订单量并标注。\r\n"
"var _hasASMonthCache = { key: '', map: null };\r\n"
"function _hasActualShipMonth(ym) {\r\n"
"  if (!ym) return false;\r\n"
"  var m = (dataStore.inventory && dataStore.inventory.actualShipBySkuRdc) || null;\r\n"
"  if (!m) return false;\r\n"
"  var skus = Object.keys(m);\r\n"
"  var ck = ym + '|' + skus.length;\r\n"
"  if (_hasASMonthCache.map && _hasASMonthCache.key === ck) return _hasASMonthCache.map[ym] || false;\r\n"
"  var hit = {};\r\n"
"  skus.forEach(function(sk){ var br = m[sk] || {}; Object.keys(br).forEach(function(rd){\r\n"
"    var md = br[rd] || {}; Object.keys(md).forEach(function(mo){ if (md[mo] != null) hit[mo] = true; });\r\n"
"  }); });\r\n"
"  _hasASMonthCache.key = ck; _hasASMonthCache.map = hit;\r\n"
"  return hit[ym] || false;\r\n"
"}\r\n"
"window._hasActualShipMonth = _hasActualShipMonth;\r\n"
"function buildPlanSkuAgg(ymOverride) {\r\n")
rep1(old_head, new_head, '1) _hasActualShipMonth 助手 + 函数签名')

# ---- 2) 月份解析：支持显式月份 ----
old_res = (
"  // v195: 先设置 label（即使后续提前返回，UI 也能显示目标月而非空括号）\r\n"
"  // v400: 月份解析改走 planMonthResolved 单一出口（含历史月：行源切旧快照槽，分子回退当月订单量）\r\n"
"  const _res = (typeof planMonthResolved === 'function') ? planMonthResolved() : null;\r\n"
"  const idx = _res ? _res.idx : 0;\r\n"
"  const targetField = _res ? _res.field : getCovMonthConfig(covSource).fields[0];\r\n"
"  const targetMonth = _res ? _res.ym : (covFieldToYM(targetField) || '2026-09');\r\n"
"  const _isHistMonth = !!(_res && _res.history);\r\n"
"  window._planSkuAggMonth = targetMonth;\r\n"
"  window._planSkuAggLabel = _res ? _res.label : targetMonth;\r\n"
"  // v400: 历史月分子 = 当月订单量（全库视角：不套海南/RDC 筛选，与本函数口径注释一致）\r\n"
"  const _ordShipAgg = _isHistMonth ? buildOrderShipMapForMonth(targetMonth, orders, 'all', null, 'all') : null;\r\n")
new_res = (
"  // v195: 先设置 label（即使后续提前返回，UI 也能显示目标月而非空括号）\r\n"
"  // v400: 月份解析改走 planMonthResolved 单一出口（含历史月：行源切旧快照槽，分子回退当月订单量）\r\n"
"  // v452: 支持显式月份 ymOverride —— 供「缺货四象限分析」这类**自带月份下拉**的页面按所选月取数。\r\n"
"  //   背景（2026-11-04 用户截图）：归因分析 / 跟进清单的「分仓完成率」「距时间进度」原来恒取当月，\r\n"
"  //   用户把月份切到 10 月，这两列仍是 11 月的数（08472·华中 计划显示 301 = 11 月、完成率 0.0% = 11 月、\r\n"
"  //   距时间进度 -10.0pt = (11-04 的 3 日)/11 月 30 日）→ 10 月 36 条里 28 条被误判成「D 需重点排查」。\r\n"
"  //   ⚠️ 不传参时行为与改前**逐字节一致**（分仓计划监控等页面零影响），且不写 window._planMonthYM\r\n"
"  //      （那是分仓计划监控自己的月份状态，不能被缺货页覆盖）。\r\n"
"  let _res;\r\n"
"  if (ymOverride) {\r\n"
"    const _opts = planMonthOptionsExt();\r\n"
"    let _hit = null, _hi = -1;\r\n"
"    for (let _i = 0; _i < _opts.length; _i++) { if (_opts[_i].ym === ymOverride) { _hit = _opts[_i]; _hi = _i; break; } }\r\n"
"    if (_hit) {\r\n"
"      _res = { idx: _hi, ym: _hit.ym, label: _hit.label, src: _hit.src, field: _hit.field, history: !!_hit.history, opts: _opts };\r\n"
"    } else {\r\n"
"      const _cmCfg = getCovMonthConfig(covSource);\r\n"
"      const _ci = (_cmCfg.yms || []).indexOf(ymOverride);\r\n"
"      _res = { idx: _ci >= 0 ? _ci : 0, ym: ymOverride, label: ymOverride, src: covSource,\r\n"
"               field: _ci >= 0 ? _cmCfg.fields[_ci] : (covFieldOfYM(ymOverride) || _cmCfg.fields[0]),\r\n"
"               history: false, opts: _opts };\r\n"
"    }\r\n"
"  } else {\r\n"
"    _res = (typeof planMonthResolved === 'function') ? planMonthResolved() : null;\r\n"
"  }\r\n"
"  const idx = _res ? _res.idx : 0;\r\n"
"  const targetField = _res ? _res.field : getCovMonthConfig(covSource).fields[0];\r\n"
"  const targetMonth = _res ? _res.ym : (covFieldToYM(targetField) || '2026-09');\r\n"
"  const _isHistMonth = !!(_res && _res.history);\r\n"
"  window._planSkuAggMonth = targetMonth;\r\n"
"  window._planSkuAggLabel = _res ? _res.label : targetMonth;\r\n"
"  // v452: 分子口径分流 —— 该月有实际出货就用实际出货（严格口径，取不到即 0，与当月一致）；\r\n"
"  //   没有实际出货（2026-01~08 源表无「分仓需求」sheet）才回退「该月订单量」，并置口径标记供 UI 标注。\r\n"
"  const _shipIsHist = ymOverride ? !_hasActualShipMonth(targetMonth) : _isHistMonth;\r\n"
"  window._planSkuAggShipBasis = _shipIsHist ? 'order' : 'actual';\r\n"
"  // v400: 历史月分子 = 当月订单量（全库视角：不套海南/RDC 筛选，与本函数口径注释一致）\r\n"
"  const _ordShipAgg = _shipIsHist ? buildOrderShipMapForMonth(targetMonth, orders, 'all', null, 'all') : null;\r\n")
rep1(old_res, new_res, '2) 月份解析支持 ymOverride + 分子口径分流')

# ---- 3) 分子取值改用 _shipIsHist ----
rep1("    const _shAgg = planMonthShipOf(sku, rdcN, targetMonth, _isHistMonth, _ordShipAgg);",
     "    const _shAgg = planMonthShipOf(sku, rdcN, targetMonth, _shipIsHist, _ordShipAgg);",
     '3) 分子取值改用 _shipIsHist')

# ---- 4) 时间进度按月 ----
old_tp = (
"  const _nowAgg = new Date();\r\n"
"  const _daysAgg = new Date(Date.UTC(_nowAgg.getFullYear(), _nowAgg.getMonth() + 1, 0)).getUTCDate();\r\n"
"  const _lastAgg = Math.max(_nowAgg.getDate() - 1, 0);\r\n"
"  const _tpAgg = Math.min(_lastAgg / _daysAgg, 1);\r\n")
new_tp = (
"  const _nowAgg = new Date();\r\n"
"  // v452: 显式月份时按**该月**算时间进度 —— 过去月已收官 = 100%、未来月 = 0%、当月沿用自然日 T-1 口径。\r\n"
"  //   不给 ymOverride 时保持原公式（分仓计划监控会选未来月，那里的 comp 若对 0% 会全判「超额」）。\r\n"
"  let _tpAgg;\r\n"
"  if (ymOverride) {\r\n"
"    const _curYMA = _nowAgg.getFullYear() + '-' + String(_nowAgg.getMonth() + 1).padStart(2, '0');\r\n"
"    if (targetMonth < _curYMA) _tpAgg = 1;\r\n"
"    else if (targetMonth > _curYMA) _tpAgg = 0;\r\n"
"    else {\r\n"
"      const _daysA = new Date(Date.UTC(_nowAgg.getFullYear(), _nowAgg.getMonth() + 1, 0)).getUTCDate();\r\n"
"      _tpAgg = Math.min(Math.max(_nowAgg.getDate() - 1, 0) / _daysA, 1);\r\n"
"    }\r\n"
"  } else {\r\n"
"    const _daysAgg = new Date(Date.UTC(_nowAgg.getFullYear(), _nowAgg.getMonth() + 1, 0)).getUTCDate();\r\n"
"    const _lastAgg = Math.max(_nowAgg.getDate() - 1, 0);\r\n"
"    _tpAgg = Math.min(_lastAgg / _daysAgg, 1);\r\n"
"  }\r\n")
rep1(old_tp, new_tp, '4) 时间进度按月')

# ---- 5) 调用点传入 period ----
rep1("  var spAgg = (typeof buildPlanSkuAgg === 'function') ? buildPlanSkuAgg() : {};",
     "  // v452: 必须传 period —— 原来不带参 → 恒取当月（11 月）完成率去判 10 月的缺货，归因整体串月\r\n"
     "  var spAgg = (typeof buildPlanSkuAgg === 'function') ? buildPlanSkuAgg(period) : {};",
     '5a) buildHiAttribution 传入 period')

rep1("              var skuAgg = buildPlanSkuAgg(); // v185: 销售进度（与长期清单同口径、顺序无关）",
     "              var skuAgg = buildPlanSkuAgg(period); // v452: 跟随本页所选月份（原不带参 → 恒取当月，串月）",
     '5b) 清单销售进度列传入 period')

rep1("  const skuAggExport = buildPlanSkuAgg();",
     "  const skuAggExport = buildPlanSkuAgg(period); // v452: 跟随导出时的所选月份",
     '5c) 严重度高清单 CSV 导出传入 period')

io.open(P, 'w', encoding='utf-8', newline='').write(s)
crlf1 = s.count('\r\n'); bare1 = s.count('\n') - crlf1
print('\n行尾自检: CRLF=%d 裸LF=%d' % (crlf1, bare1))
assert bare1 == 0, '写回后出现裸 LF！'
print('✅ 全部补丁完成')
