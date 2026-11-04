# -*- coding: utf-8 -*-
"""v452 补丁 3：ensureDemandMerged 在库存未就绪时有界重试（避免并入被静默跳过）"""
import io
P = 'rdc-dashboard.html'
s = io.open(P, encoding='utf-8', newline='').read()
assert s.count('\n') - s.count('\r\n') == 0, '含裸 LF'

old = ("    const inv = dataStore.inventory;\r\n"
       "    if (!inv) { window._demandMerging = false; window._demandMergingSince = 0; return; }\r\n")
new = ("    const inv = dataStore.inventory;\r\n"
       "    if (!inv) {\r\n"
       "      window._demandMerging = false; window._demandMergingSince = 0;\r\n"
       "      // v452: 库存还没解析完就早退 —— 缺货四象限页会在**订单数据就绪、库存未就绪**时先渲染，\r\n"
       "      //   此时若直接放弃，之后再没人触发并入 → actualShipBySkuRdc 恒空 → 销售进度分子恒 0\r\n"
       "      //   → 完成率恒 0% → 归因全判「D 需重点排查」（用户 2026-11-04 实测）。\r\n"
       "      //   改为有界重试（25 次 × 800ms ≈ 20s 封顶），成功路径会清零计数。\r\n"
       "      var _rty = window._demandInvRetry || 0;\r\n"
       "      if (_rty < 25 && !window._demandInvRetryTimer) {\r\n"
       "        window._demandInvRetry = _rty + 1;\r\n"
       "        window._demandInvRetryTimer = setTimeout(function () {\r\n"
       "          window._demandInvRetryTimer = null;\r\n"
       "          if (typeof _demandReady !== 'function' || !_demandReady()) ensureDemandMerged();\r\n"
       "        }, 800);\r\n"
       "      }\r\n"
       "      return;\r\n"
       "    }\r\n")
assert s.count(old) == 1, '库存早退分支命中 %d 次' % s.count(old)
s = s.replace(old, new, 1)
print('✅ 1) 库存未就绪时有界重试')

# 成功后清零重试计数
old2 = "    _demandMerged = true;\r\n    window._demandMerging = false;\r\n    window._demandMergingSince = 0;\r\n"
new2 = ("    _demandMerged = true;\r\n    window._demandMerging = false;\r\n    window._demandMergingSince = 0;\r\n"
        "    window._demandInvRetry = 0;                       // v452: 并入成功，清零库存重试计数\r\n"
        "    if (window._demandInvRetryTimer) { clearTimeout(window._demandInvRetryTimer); window._demandInvRetryTimer = null; }\r\n")
assert s.count(old2) == 1, '成功分支命中 %d 次' % s.count(old2)
s = s.replace(old2, new2, 1)
print('✅ 2) 成功清零重试计数')

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('裸LF=', s.count('\n') - s.count('\r\n'))
