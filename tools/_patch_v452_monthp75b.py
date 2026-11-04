# -*- coding: utf-8 -*-
"""v452 补丁 2：11 月这类「有效组合不足 4 天」的月份，清单标题不能再说「本月 P75」。
   sevByMonth 里没有该月键 → _thMoSel=null → 回落全局 P75。此时标注必须改成「跨月合并 P75」。"""
import os

P = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'rdc-dashboard.html')
txt = open(P, 'r', encoding='utf-8', newline='').read()
assert (txt.count('\n') - txt.count('\r\n')) == 0 and txt.count('\r\n') > 25000, '换行符不是纯 CRLF'


def rep(old, new, tag):
    global txt
    n = txt.count(old)
    assert n == 1, '[%s] 命中 %d 次（要求 1）' % (tag, n)
    txt = txt.replace(old, new, 1)
    print('  OK  %s' % tag)


# 清单卡标题：阈值来源改名（本月 / 跨月合并）
rep(
    "严重度评分 ≥ ${SEV_DOUBLE_TXT}（本月 P75，前 25%））</span>",
    "严重度评分 ≥ ${SEV_DOUBLE_TXT}（${_thMoSel ? '本月 P75，前 25%' : '跨月合并 P75：该月有效组合不足 4 天，未单独计算'}））</span>",
    '清单标题阈值来源'
)

# 说明面板那一行同样标注来源
rep(
    "严重度 ≥ ${SEV_DOUBLE_TXT}（前 25%）</span> 入选「严重度高重点跟进清单」　",
    "严重度 ≥ ${SEV_DOUBLE_TXT}（${_thMoSel ? '本月 P75，前 25%' : '跨月合并 P75'}）</span> 入选「严重度高重点跟进清单」　",
    '说明面板阈值来源'
)

assert '\n' not in txt.replace('\r\n', ''), '混入裸 LF'
open(P, 'w', encoding='utf-8', newline='').write(txt)
print('')
print('CRLF %d / 裸LF %d' % (txt.count('\r\n'), txt.count('\n') - txt.count('\r\n')))
