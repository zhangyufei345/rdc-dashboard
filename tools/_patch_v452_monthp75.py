# -*- coding: utf-8 -*-
"""v452 补丁：把「严重度高」入选线改成真正的「本月 P75」（按月分组算分位）。
另附两处 UI：历史月「销售进度=订单量口径」提示条 + 长期标记 tooltip 口径说明更新。
"""
import io, sys, os

P = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'rdc-dashboard.html')
txt = open(P, 'r', encoding='utf-8', newline='').read()
assert txt.count('\r\n') > 25000 and (txt.count('\n') - txt.count('\r\n')) == 0, '换行符不是纯 CRLF'
NL = '\r\n'
orig_len = len(txt)


def rep(old, new, tag):
    global txt
    n = txt.count(old)
    assert n == 1, '[%s] 命中 %d 次（要求 1）' % (tag, n)
    txt = txt.replace(old, new, 1)
    print('  OK  %s' % tag)


# ---------------- P1: 空列表早退补 sevByMonth ----------------
rep(
    "  if (!list.length) return { shortP75: 0, sizeDivisor: 4.5, sevP50: 0.55, sevP75: 0.65, sevP90: 0.75 };",
    "  if (!list.length) return { shortP75: 0, sizeDivisor: 4.5, sevP50: 0.55, sevP75: 0.65, sevP90: 0.75, sevByMonth: {} };",
    'P1 空列表早退'
)

# ---------------- P2: 阶段2 整体改写为按月分组 ----------------
START = '  // 阶段2：动态阈值（v159 收窄：P75 严重度高 / P90 紧急升级）'
ENDMARK = 'sevP90: sevP90 };'
assert txt.count(START) == 1, '阶段2 注释锚点不唯一'
assert txt.count(ENDMARK) == 1, 'return 锚点不唯一'
_s = txt.index(START)
_e = txt.index(ENDMARK, _s) + len(ENDMARK)
old_p2 = txt[_s:_e]
# 自检：老块必须包含这两行关键代码，防止锚点漂移到别处
assert 'q.isPersistent = q.severity >= sevP75;' in old_p2 and 'var sevP75 = quantile(sevs, 0.75);' in old_p2, '阶段2 老块内容不符'

new_p2 = NL.join([
"  // 阶段2：动态阈值（v159 收窄：P75 严重度高 / P90 紧急升级）",
"  // v452（2026-11-04，用户要求「改成真正的本月 P75」）：",
"  //   原实现对本函数入参 list 的**全部月份合并**算一套 P75/P90 → 高严重度清单实际用的是",
"  //   「跨 11 个月合并样本的全局 P75 = 0.576」，各月入选率实测 10月 15.7%(36/229) /",
"  //   9月 24.6%(72/293) / 8月 33.6%(115/342) / 1月 36.3%(145/399) —— 而 UI 上一直写着",
"  //   「本月 P75、前 25%」，名实不符。现改为**按月分组**各算一套分位。",
"  //   口径范围（刻意收窄，不动 severity 数值本身）：",
"  //     · sizePct 分位排名 + hardFloor 仍是跨月合并算一次 → severity 跨月可比、清单排序稳定；",
"  //       改的只是「入选线」= 该组合**自己所属月**的 P75/P90。",
"  //     · 全局 sevP50/P75/P90 原样返回，供 sevDimCalc / 长期标记等跨月可比场景继续用。",
"  //     · 本来就是按月独立调用的使用方（月度画像 / byRdc / 长期画像）一月一批，",
"  //       分组后只有一组 → 与改动前完全一致，零回归。",
"  var sevs = base.map(function(q) { return q.severity; }).sort(function(a, b) { return a - b; });",
"  var sevP50 = quantile(sevs, 0.50);   // 全局：跨月合并（中位数参考）",
"  var sevP75 = quantile(sevs, 0.75);   // 全局：跨月合并 P75（保留供跨月可比场景）",
"  var sevP90 = quantile(sevs, 0.90);   // 全局：跨月合并 P90",
"",
"  // v452: 按月分组求分位（分组键优先 q.month，回退 q.period，都没有则归入 '_' 单组）",
"  var _sevByMo = {};",
"  base.forEach(function(q) {",
"    var mo = q.month || q.period || '_';",
"    (_sevByMo[mo] = _sevByMo[mo] || []).push(q.severity);",
"  });",
"  var sevByMonth = {};",
"  Object.keys(_sevByMo).forEach(function(mo) {",
"    var arr = _sevByMo[mo].sort(function(a, b) { return a - b; });",
"    sevByMonth[mo] = {",
"      cnt: arr.length,",
"      sevP50: quantile(arr, 0.50),",
"      sevP75: quantile(arr, 0.75),",
"      sevP90: quantile(arr, 0.90)",
"    };",
"  });",
"  list.forEach(function(q) {",
"    var mo = q.month || q.period || '_';",
"    var _moTh = sevByMonth[mo];",
"    // 进不了 base 的组合（无缺货 / 有单天数 < MIN_DAYS）沿用全局阈值 → 与改动前行为一致",
"    var _inBase = (q.shortQty || 0) > 0 && (q.orderDayCnt || 0) >= MS_PROFILE.MIN_DAYS;",
"    var _t = (_inBase && _moTh) ? _moTh : { sevP75: sevP75, sevP90: sevP90 };",
"    q.sevThP75 = _t.sevP75;          // v452: 该行实际使用的入选线（供展示层标注）",
"    q.sevThP90 = _t.sevP90;",
"    q.sevThMonth = (_inBase && _moTh) ? mo : null;",
"    q.isHighSeverity = q.severity >= _t.sevP90;   // 紧急升级 = 本月的前 10%",
"    // v167: isPersistent 改为仅看严重度评分（去掉 isPersistentOld OR 关系）",
"    //   之前 isPersistent = isPersistentOld || severity >= sevP75",
"    //   isPersistentOld 是「率 ≥ 50% 且 频 ≥ 50%」硬门槛——不看缺货量",
"    //   导致「率 100% 频 53% 缺 360 支」这种小 SKU 通过老口径直接入选严重度高清单",
"    //   去掉 OR 后：严重度高 = 严重度评分 ≥ P75，缺货量下限由 v163 hardFloor (几何平均) 兜底",
"    q.isPersistent = q.severity >= _t.sevP75;     // v452: 本月 P75（前 25%）",
"  });",
"  return { shortP50: shortP50, geoMean: geoMean, hardFloor: hardFloor, shortP75: shortP75, sizeDivisor: sizeDivisor, sevP50: sevP50, sevP75: sevP75, sevP90: sevP90, sevByMonth: sevByMonth };",
])
txt = txt[:txt.index(START)] + new_p2 + txt[txt.index(ENDMARK, txt.index(START)) + len(ENDMARK):]
print('  OK  P2 阶段2 → 按月分组')

# ---------------- P3: 展示层阈值取所选月份 ----------------
old = NL.join([
"  const dynTh = prof.dynamicThresholds || { shortP75: 0, sizeDivisor: 4.5, sevP75: MS_SEVERITY.SEV_DOUBLE, sevP90: MS_SEVERITY.SEV_HIGH };",
"  const SEV_DOUBLE = dynTh.sevP75 != null ? dynTh.sevP75 : dynTh.sevP50;",
"  const SEV_HIGH = dynTh.sevP90 != null ? dynTh.sevP90 : dynTh.sevP75;",
"  const SEV_DOUBLE_TXT = SEV_DOUBLE.toFixed(2);",
"  const SEV_HIGH_TXT = SEV_HIGH.toFixed(2);",
])
new = NL.join([
"  const dynTh = prof.dynamicThresholds || { shortP75: 0, sizeDivisor: 4.5, sevP75: MS_SEVERITY.SEV_DOUBLE, sevP90: MS_SEVERITY.SEV_HIGH };",
"  // v452: 入选线改成「按月 P75/P90」后，页面展示的阈值必须取**当前所选月份**的那一套，",
"  //   否则会出现「显示 0.58、实际按 0.47 入选」的名实不符（正是本轮要修的问题）。",
"  const _thMoSel = (dynTh.sevByMonth && dynTh.sevByMonth[period]) || null;",
"  const SEV_DOUBLE = _thMoSel ? _thMoSel.sevP75 : (dynTh.sevP75 != null ? dynTh.sevP75 : dynTh.sevP50);",
"  const SEV_HIGH = _thMoSel ? _thMoSel.sevP90 : (dynTh.sevP90 != null ? dynTh.sevP90 : dynTh.sevP75);",
"  const SEV_DOUBLE_TXT = SEV_DOUBLE.toFixed(2);",
"  const SEV_HIGH_TXT = SEV_HIGH.toFixed(2);",
"  const SEV_P50_TXT = (_thMoSel && _thMoSel.sevP50 != null ? _thMoSel.sevP50 : (dynTh.sevP50 || 0)).toFixed(2);",
"  const SEV_TH_MO_CNT = _thMoSel ? _thMoSel.cnt : 0;",
])
rep(old, new, 'P3 展示层阈值取所选月')

# ---------------- P4: 「本月基准」文案补月份与样本数 ----------------
old = "            本月基准：严重度评分 P75 = ${SEV_DOUBLE_TXT}、P90 = ${SEV_HIGH_TXT}（中位数 P50 = ${(dynTh.sevP50||0).toFixed(2)} 仅供参考）。<b>阈值跟随当月数据自适应</b>，淡季自动降低、旺季自动提高，清单长度恒定（约 25% / 10%）。"
new = "            本月（${period} · 有效组合 ${SEV_TH_MO_CNT.toLocaleString()} 个）基准：严重度评分 P75 = ${SEV_DOUBLE_TXT}、P90 = ${SEV_HIGH_TXT}（中位数 P50 = ${SEV_P50_TXT} 仅供参考）。<b>阈值按所选月份独立计算</b>（v452 起真正每月各算一套），淡季自动降低、旺季自动提高，各月清单长度恒定为该月有效组合的约 25% / 10%；代价是<b>月与月之间阈值不再可直接横比</b>。"
rep(old, new, 'P4 本月基准文案')

# ---------------- P5: 归因卡「订单量口径」提示 ----------------
old = "    h += '<span style=\"font-size:11px;color:var(--text-secondary)\">基于总仓供应状态 × 分仓完成率交叉判定，区分根因与行动方向</span>';\r\n"
new = old + NL.join([
    "    // v452: 历史月归档里没有「分仓需求」sheet → 销售进度分子只能用订单明细已放行量代替，必须显式标注",
    "    if (window._planSkuAggShipBasis === 'order') {",
    "      h += '<span style=\"padding:2px 8px;border-radius:4px;background:#E0E7FF;color:#3730A3;font-size:11px\" title=\"该月归档数据里没有「分仓需求」sheet（实际出货），销售进度分子改用「订单明细」的已放行订单量代替。月内口径与有实际出货的月份不同，不能直接横比。详情见「严重度高重点跟进清单」同一提示。\">归因口径：销售进度用订单量</span>';",
    "    }",
    "",
])
rep(old, new, 'P5 归因卡口径提示')

# ---------------- P6: 清单卡「订单量口径」提示 ----------------
old = "严重度评分 ≥ ${SEV_DOUBLE_TXT}（本月 P75，前 25%））</span>"
new = ("严重度评分 ≥ ${SEV_DOUBLE_TXT}（本月 P75，前 25%））</span>"
       "${window._planSkuAggShipBasis === 'order' ? '<span style=\"padding:2px 8px;border-radius:4px;background:#E0E7FF;color:#3730A3;font-size:11px\" title=\"该月归档数据里没有「分仓需求」sheet（实际出货），销售进度分子改用「订单明细」的已放行订单量代替。月内口径与有实际出货的月份不同，不能直接横比。\">销售进度：订单量口径</span>' : ''}")
rep(old, new, 'P6 清单卡口径提示')

# ---------------- P7: 长期标记 tooltip 口径说明更新 ----------------
old = "而本清单的入选用的是「跨月全局 P75」。两者不完全一致，所以少数行会出现「已缓解」——含义是：该 SKU 按「本月自身的前 25%」标准已经掉出，但按跨月标准仍在本清单里。"
new = "本清单（v452 起）入选也用「各月独立计算」的同一个 P75 → 两处口径已统一。若仍出现「已缓解」，通常是因为本列按 SKU 层（跨 RDC 合并）判定、本清单按 SKU×RDC 组合层判定，两者样本不同。"
rep(old, new, 'P7 长期标记 tooltip 口径')

# ---------------- 写回 ----------------
assert '\n' not in txt.replace('\r\n', ''), '写回前混入裸 LF'
assert txt.count('\r\n') > 25000
open(P, 'w', encoding='utf-8', newline='').write(txt)
print('')
print('原 %d 字节 → 现 %d 字节（%+d）' % (orig_len, len(txt), len(txt) - orig_len))
print('CRLF %d / 裸LF %d' % (txt.count('\r\n'), txt.count('\n') - txt.count('\r\n')))
