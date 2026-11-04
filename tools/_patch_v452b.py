# -*- coding: utf-8 -*-
"""v452 补丁 2：让缺货四象限页也触发 demand.json 并入（否则销售进度分子恒 0）"""
import io

P = 'rdc-dashboard.html'
s = io.open(P, encoding='utf-8', newline='').read()
assert s.count('\n') - s.count('\r\n') == 0, '含裸 LF'

def rep1(old, new, label):
    global s
    n = s.count(old)
    assert n == 1, '❌ %s 命中 %d 次' % (label, n)
    s = s.replace(old, new, 1)
    print('✅ ' + label)

# 1) ensureDemandMerged 并入成功后重渲染缺货页（用前后行锁定唯一位置）
rep1(
"    if (cur === 'plan-monitor' && typeof renderPlanMonitor === 'function') renderPlanMonitor();\r\n"
"    if (cur === 'replenishment' && typeof renderReplenishment === 'function') renderReplenishment();\r\n"
"    // v443: 已移除 adjust-track 分支 —— demand.json 的 plan 合并只服务 plan-monitor/replenishment\r\n",
"    if (cur === 'plan-monitor' && typeof renderPlanMonitor === 'function') renderPlanMonitor();\r\n"
"    if (cur === 'replenishment' && typeof renderReplenishment === 'function') renderReplenishment();\r\n"
"    // v452: 缺货四象限（高严重度归因分析 / 严重度高重点跟进清单）的「销售进度」现在按**所选月份**取实际出货，\r\n"
"    //   但本页原先从不触发 ensureDemandMerged → actualShipBySkuRdc 恒空 → 分子恒 0 → 完成率 0% →\r\n"
"    //   归因把绝大多数组合判成「D 需重点排查」。并入完成后必须重渲染，否则页面停在回退口径。\r\n"
"    if (cur === 'shortage' && typeof renderShortage === 'function') renderShortage();\r\n"
"    // v443: 已移除 adjust-track 分支 —— demand.json 的 plan 合并只服务 plan-monitor/replenishment\r\n",
'1) 并入成功后重渲染缺货页')

# 2) ensureInventoryPlan 就绪自愈也带上缺货页（分仓计划变权威源后同步刷新）
rep1(
"    if (cur === 'replenishment' && typeof renderReplenishment === 'function') renderReplenishment();\r\n"
"    // v443: 已移除 adjust-track 分支 —— 本页不再依赖 planBySkuRdc（原依赖点=砍量冗余折算，模块已删）\r\n",
"    if (cur === 'replenishment' && typeof renderReplenishment === 'function') renderReplenishment();\r\n"
"    // v452: 分仓计划变为权威源后，缺货页的「计划量」也会跟着变（原来走 cov7 回退），同步刷新\r\n"
"    if (cur === 'shortage' && typeof renderShortage === 'function') renderShortage();\r\n"
"    // v443: 已移除 adjust-track 分支 —— 本页不再依赖 planBySkuRdc（原依赖点=砍量冗余折算，模块已删）\r\n",
'2) ensureInventoryPlan 自愈带上缺货页')

# 3) 缺货页进入时触发并入（放在 renderShortage 顶部，覆盖 5 个子页签）
rep1(
"function renderShortage() {\r\n"
"  setTitle('缺货分析');\r\n"
"  const page = document.getElementById('page-shortage');\r\n"
"  if (!page) return;\r\n",
"function renderShortage() {\r\n"
"  setTitle('缺货分析');\r\n"
"  const page = document.getElementById('page-shortage');\r\n"
"  if (!page) return;\r\n"
"\r\n"
"  // v452: 「销售进度」列与归因判定都读 demand.json 的实际出货，而本页原先从不触发 ensureDemandMerged\r\n"
"  //   → 直接进缺货页时 actualShipBySkuRdc 恒为空 → 分子恒 0 → 完成率 0% → 归因全判「需重点排查」\r\n"
"  //   （用户 2026-11-04 截图：08472·华中 计划 301 / 出货 0 / 0.0% / ↓-10.0pt）。\r\n"
"  //   并入是异步的，完成后会回调 renderShortage 自动刷新；取不到实际出货的月份\r\n"
"  //   （2026-01~08 源表还没有「分仓需求」sheet）会在页面上明确标注「订单量口径」，不静默冒充。\r\n"
"  if (typeof _demandReady === 'function' && !_demandReady() && typeof ensureDemandMerged === 'function') ensureDemandMerged();\r\n",
'3) renderShortage 触发 demand 并入')

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('裸LF=', s.count('\n') - s.count('\r\n'))
