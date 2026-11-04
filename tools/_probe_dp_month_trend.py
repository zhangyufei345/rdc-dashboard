# -*- coding: utf-8 -*-
"""辅助证据：10 月每次部署相对上一次，「分仓需求」sheet 2026-10 列的 DP 变动规模。
   验证「月末集中上调计划」是系统性行为而非个案。"""
import json
import subprocess

REPO = r'C:\Users\zhangyufei1\WorkBuddy\2026-06-30-09-24-40'
SHAS = [
    ('6efd33a', '10-10'), ('7b07e20', '10-12'), ('d3fd53d', '10-13'),
    ('e93a42a', '10-14'), ('bd4d413', '10-15'), ('e43b1c3', '10-16'),
    ('bd32128', '10-18'), ('89d8335', '10-19'), ('0a624ee', '10-20'),
    ('377762a', '10-20b'), ('bfe14a9', '10-21'), ('3daee1f', '10-22'),
    ('8bcf869', '10-23'), ('7df989d', '10-26'), ('ff93156', '10-27'),
    ('5dc6201', '10-28'), ('4d83ef1', '10-29'), ('f72ceb4', '10-30'),
]


def snap(sha):
    p = subprocess.run(['git', 'show', '%s:data.json' % sha], cwd=REPO,
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if p.returncode != 0:
        return None
    d = json.loads(p.stdout.decode('utf-8'))
    fd = (d.get('sheets') or {}).get('分仓需求')
    if not fd:
        return None
    mi = [i for i, h in enumerate(fd[0]) if h is not None and str(h) == '2026-10']
    if not mi:
        return None
    mi = mi[0]
    m = {}
    for r in fd[1:]:
        if r is None or len(r) < 6 or str(r[5]) != 'DP_共识数量':
            continue
        v = r[mi]
        if isinstance(v, (int, float)):
            m[(str(r[0]).lstrip('0'), str(r[2]))] = float(v)
    return m


print('%-7s %-6s %-6s %-6s %-12s %-12s %-9s' % (
    '部署', '键数', '上调', '下调', '上调合计', '下调合计', '净变动'))
print('-' * 78)
prev = None
prev_lab = None
rows = []
for sha, lab in SHAS:
    cur = snap(sha)
    if cur is None:
        print('%-7s 读取失败' % lab)
        continue
    if prev is not None:
        up = dn = 0
        sumup = sumdn = 0.0
        for k, v in cur.items():
            pv = prev.get(k)
            if pv is None:
                continue
            if v > pv:
                up += 1
                sumup += v - pv
            elif v < pv:
                dn += 1
                sumdn += pv - v
        print('%-7s %-6d %-6d %-6d %-12s %-12s %-9s' % (
            '%s→%s' % (prev_lab, lab), len(cur), up, dn,
            format(int(sumup), ','), format(int(sumdn), ','),
            format(int(sumup - sumdn), ',')))
        rows.append((lab, up, dn, sumup, sumdn))
    prev, prev_lab = cur, lab

print('\n--- 上调键数最多的 3 次部署 ---')
for lab, up, dn, su, sd in sorted(rows, key=lambda r: -r[1])[:3]:
    print('  %s：上调 %d 键，合计 +%s' % (lab, up, format(int(su), ',')))
