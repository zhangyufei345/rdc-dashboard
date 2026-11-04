# -*- coding: utf-8 -*-
"""v452 补丁 4：把「两套 P75 口径不一致」的旧说明改成 v452 后的真实口径。
   L10024-10026（口径说明面板）+ L9908（长期标记列 tooltip）。"""
import os

P = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'rdc-dashboard.html')
raw = open(P, 'r', encoding='utf-8', newline='').read()
assert (raw.count('\n') - raw.count('\r\n')) == 0 and raw.count('\r\n') > 25000, '换行符不是纯 CRLF'
L = raw.split('\r\n')


def find_line(mark, expect=1):
    hits = [i for i, s in enumerate(L) if mark in s]
    assert len(hits) == expect, '[%s] 命中 %d 行（要求 %d）: %s' % (mark[:30], len(hits), expect, hits)
    return hits[0]


# ---------- ① 口径说明面板：整段重写 ----------
i24 = find_line('⚠️ <strong>两套 P75 口径不一致</strong>')
i26 = find_line('所以少数行会显示「已缓解」')
assert i26 == i24 + 2, '两段不连续（%d / %d）' % (i24, i26)
i25 = i24 + 1

new24 = (
    '      ✅ <strong>入选阈值口径（v452 起已统一为「本月 P75」）</strong>：本清单按 <strong>所选月份自己的</strong>严重度分布取 P75/P90'
    '<span style="color:#065F46">（${period} 有效组合 ${valid.length} 个，命中 ${hi.length} = ${valid.length ? (hi.length / valid.length * 100).toFixed(1) : \'0\'}%，'
    'P75 = ${SEV_DOUBLE_TXT}）</span>，不再用「跨月全局 P75」——旧口径下各月入选率实测 10月 15.7% / 9月 24.6% / 8月 33.6% / 1月 36.3%，'
    '与页面写的「前 25%」不符，v452 已改为每月各算一套（实测各月 25.1%~25.4%）。<br>'
)
new25 = (
    '      ⚠️ <strong>但仍有一处口径差异</strong>：<strong>长期标记列</strong>判断「是否在 P75」固定用<strong>最新月</strong>'
    '<span style="color:#A32D2D">（${ltProf.effectiveCurMonth}，${(ltProf.monthMeta[ltProf.effectiveCurMonth] || {}).validCnt || 0} 个有效 SKU，'
    'P75 = ${(ltProf.monthMeta[ltProf.effectiveCurMonth] || {}).sevP75 != null ? ltProf.monthMeta[ltProf.effectiveCurMonth].sevP75.toFixed(3) : \'—\'}）</span>'
    '，且在 <strong>SKU 层跨 RDC 合并</strong>判定；本清单判 <strong>所选月份</strong>、且在 <strong>SKU×RDC 组合层</strong>判定。'
    '${ltProf.effectiveCurMonth !== ltProf.curMonth ? \'<br>⚠ 最新月 \'+ltProf.curMonth+\' 数据不足（有效 SKU &lt; \'+LT_PARAMS.MIN_VALID_CNT_MONTH+\' 个），「在 P75」判定已自动回退到 \'+ltProf.effectiveCurMonth+\'。\' : \'\'}'
    '→ 因此<strong>选历史月时出现「已缓解」是预期行为</strong>（含义：该 SKU 在最新月已不在 P75），不是本清单算错。<br>'
)
print('替换 L%d:' % (i24 + 1), L[i24][:60], '...')
print('替换 L%d:' % (i25 + 1), L[i25][:60], '...')
L[i24] = new24
L[i25] = new25
L[i26] = ''          # 旧结论句作废（已并入上面两行）

# ---------- ② 长期标记列 tooltip：精确定位「最新月 vs 所选月」 ----------
i_tip = find_line('本清单（v452 起）入选也用「各月独立计算」的同一个 P75')
old_sub = '本清单（v452 起）入选也用「各月独立计算」的同一个 P75 → 两处口径已统一。若仍出现「已缓解」，通常是因为本列按 SKU 层（跨 RDC 合并）判定、本清单按 SKU×RDC 组合层判定，两者样本不同。'
assert L[i_tip].count(old_sub) == 1, 'tooltip 子串不唯一/不存在'
new_sub = ('本清单（v452 起）入选也用「各月独立计算」的 P75，但判的是**所选月份**且在 SKU×RDC 组合层；本列固定判**最新月**（${ltProf.effectiveCurMonth}）且在 SKU 层。'
           '→ 选历史月时两处必然不同：「已缓解」表示该 SKU 在最新月已不在 P75，属预期行为。')
L[i_tip] = L[i_tip].replace(old_sub, new_sub, 1)
L[i_tip] = L[i_tip].replace('**所选月份**', '所选月份').replace('**最新月**', '最新月')   # title 里不用 markdown 粗体
print('替换 L%d tooltip' % (i_tip + 1))

out = '\r\n'.join(L)
assert '\n' not in out.replace('\r\n', ''), '混入裸 LF'
open(P, 'w', encoding='utf-8', newline='').write(out)
print('')
print('CRLF %d / 裸LF %d' % (out.count('\r\n'), out.count('\n') - out.count('\r\n')))
