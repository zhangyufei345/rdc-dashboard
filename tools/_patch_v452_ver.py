# -*- coding: utf-8 -*-
"""v452 补丁 3：BUILD_VERSION 451 → 452 + 顶部版本说明。"""
import os

P = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'rdc-dashboard.html')
txt = open(P, 'r', encoding='utf-8', newline='').read()
NL = '\r\n'
assert (txt.count('\n') - txt.count('\r\n')) == 0 and txt.count('\r\n') > 25000, '换行符不是纯 CRLF'

old = "const BUILD_VERSION = 451;" + NL
assert txt.count(old) == 1, 'BUILD_VERSION 锚点不唯一'

note = NL.join([
    "// v452: 【月份筛选失效（串月）修复 + 严重度高入选改为真正的「本月 P75」】用户 2026-11-04 截图：",
    "//   ① 月份下拉选 2026-10，但「高严重度产品归因分析」与「严重度高重点跟进清单」里仍是 11 月的计划/出货。",
    "//   ② 三层根因：",
    "//      (a) buildHiAttribution 调 buildPlanSkuAgg() **不带月份参数** → 月份走 planMonthResolved() 取",
    "//          window._planMonthYM，默认=当前日历月(2026-11)；清单侧同理 → 拿 11 月的计划/出货去判 10 月的缺货。",
    "//      (b) 时间进度用 new Date() 算 (4-1)/30=10%，与所选月无关 → 清单显示「↓-10.0pt」这类假偏差。",
    "//      (c) 缺货四象限页**从不触发 ensureDemandMerged()** → actualShipBySkuRdc 恒空 → 销售进度分子恒 0。",
    "//   ③ 修法（只改这三层，不动任何口径公式）：",
    "//      buildPlanSkuAgg(ymOverride) 新增月份参数，三个调用点（归因 L8940 / 清单 L9845 / CSV 导出 L11059）",
    "//      传 period；时间进度按月判定（历史月=1、未来月=0、当月=已过自然日/当月天数）；",
    "//      renderShortage 顶部补 ensureDemandMerged()，并给 ensureDemandMerged 加「库存未就绪」有界重试",
    "//      （25×800ms，实测进缺货页时 dataStore.inventory 还是 null → 原实现静默早退后再无人触发）。",
    "//   ④ 历史月要能算实际出货 → tools/export_demand.py 新增 merge_archived_months()：把项目根",
    "//      data-YYYY-MM.json 里「分仓需求」sheet 的该月列补进 demand.json（10月 3,676,348支/1,181键、",
    "//      9月 8,383,281支/1,289键）。1~8 月该 sheet 尚不存在（2026-09 才引入）→ 分子退化为",
    "//      「订单明细已放行订单量」，此时**必须**在归因卡/清单卡打「销售进度：订单量口径」提示条。",
    "//   ⑤ 「本月 P75」名实不符一并修：finalizeSeverity 原对入参 list 的**全部月份合并**算一套 P75/P90",
    "//      （全局 0.576），各月入选率实测 10月 15.7% / 9月 24.6% / 8月 33.6% / 1月 36.3%，而 UI 一直写",
    "//      「本月 P75，前 25%」。现改为**按月分组**各算一套分位（10月 0.485 / 9月 0.572 / 8月 0.645），",
    "//      实测各月入选率 25.1%~25.4%。severity 数值本身不动（sizePct 排名与 hardFloor 仍跨月合并算一次，",
    "//      保证跨月可比与排序稳定），改的只是入选线；全局 sevP50/P75/P90 原样返回供 sevDimCalc 等继续用。",
    "//      ⚠ 代价：月与月阈值不再可直接横比（淡季阈值低、旺季阈值高）。",
    "//      ⚠ 副作用（诚实记录、未修）：月初不足 4 个工作日的月份，有效组合=0 → 该月两个模块天然为空",
    "//        （2026-11 仅 2 个工作日 → 清单 0 条）；此时 sevByMonth 里没有该月键，标题回落显示",
    "//        「跨月合并 P75：该月有效组合不足 4 天，未单独计算」，不再谎称「本月 P75」。",
    "//   ⑥ 未改：DB_VERSION（纯前端算法 + demand.json 内容更新，缓存结构未变）。",
    "const BUILD_VERSION = 452;" + NL,
])
txt = txt.replace(old, note, 1)
print('  OK  BUILD_VERSION 451 → 452 + 版本说明')

assert '\n' not in txt.replace('\r\n', ''), '混入裸 LF'
open(P, 'w', encoding='utf-8', newline='').write(txt)
print('CRLF %d / 裸LF %d' % (txt.count('\r\n'), txt.count('\n') - txt.count('\r\n')))
