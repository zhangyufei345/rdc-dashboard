# v338: 分仓计划（inventory-plan.json）就绪后自动重算「每日补货建议」卡片
#   根因：ensureInventoryPlan 完成回调只处理 plan-monitor / inventory-structure，
#        补货建议页的下调预警卡片在 plan 未就绪时用 cov7 回退列表渲染（266 条），
#        plan 就绪后不会重算 → 首屏就导出时 Sheet2 与稳态 262 条不一致。
import re
from pathlib import Path

p = Path(r'C:\Users\zhangyufei1\WorkBuddy\2026-06-30-09-24-40\rdc-dashboard.html')
s = p.read_text(encoding='utf-8')

old = """    const cur = (typeof currentPage === 'string') ? currentPage : '';
    if ((cur === 'plan-monitor' || cur === 'inventory-structure') && typeof renderPage === 'function') renderPage();"""

new = """    const cur = (typeof currentPage === 'string') ? currentPage : '';
    // v338: 分仓计划就绪后自动重算依赖 planBySkuRdc 的页面。
    //   用户 2026-09-11 反馈：首屏进「补货建议」页时 plan 未就绪 → 下调预警卡片走 cov7 回退列表(266条)，
    //   plan 就绪后不重算 → 刚进页面就导出时 Sheet2 条数与稳态(262)不一致。此处补 replenishment 分支。
    //   renderReplenishment 从 window._replRdc 读 RDC 筛选，重算不会丢用户已选的 RDC。
    if (cur === 'replenishment' && typeof renderReplenishment === 'function') renderReplenishment();
    // ⚠️ 遗留（本版未改，行为零变化）：下面这行 renderPage() 漏传 page 参数 → switch(undefined) 不命中任何
    //    分支 → 实际是空操作。当前 plan-monitor / inventory-structure 各自有轮询自愈（1500ms×30），
    //    所以未暴露。是否修成 renderPage(cur) 待用户确认，不擅自改这两页行为。
    if ((cur === 'plan-monitor' || cur === 'inventory-structure') && typeof renderPage === 'function') renderPage();"""

assert s.count(old) == 1, f'old count={s.count(old)}'
s = s.replace(old, new)

new_ver = 'const BUILD_VERSION = 338; // v338: ensureInventoryPlan 就绪后自动重算「每日补货建议」卡片（补 replenishment 分支），修复首屏 plan 未就绪时下调预警/导出 Sheet2 走 cov7 回退(266条)不刷新的问题。'
s, n = re.subn(r'const BUILD_VERSION = 337;[^\n]*', new_ver, s, count=1)
assert n == 1, f'BUILD_VERSION replace n={n}'

p.write_text(s, encoding='utf-8')
print('PATCH_OK v337->v338')
