# -*- coding: utf-8 -*-
"""检查 JSON 中间层是否保留 SKU 前导零。只读。"""
import json, os

BASE = r'C:\Users\zhangyufei1\WorkBuddy\2026-06-30-09-24-40'

def check(fn, sheet, col, label, n=6):
    fp = os.path.join(BASE, fn)
    if not os.path.exists(fp):
        print(f'[skip] {fn}')
        return
    with open(fp, 'r', encoding='utf-8') as f:
        j = json.load(f)
    sh = (j.get('sheets') or {}).get(sheet)
    if not sh:
        print(f'[{fn}/{sheet}] 不存在，可用: {list((j.get("sheets") or {}).keys())}')
        return
    print(f'\n== {label} :: {fn} / {sheet} (col{col}) ==')
    print('   type:', type(sh).__name__)
    rows = sh if isinstance(sh, list) else sh.get('rows') or []
    if isinstance(sh, dict):
        print('   sheet keys:', list(sh.keys())[:8])
        rows = sh.get('rows') or sh.get('data') or []
    print('   行数:', len(rows))
    for r in rows[:n]:
        v = r[col] if isinstance(r, list) and col < len(r) else None
        print('   raw:', repr(v), type(v).__name__)
    # 统计
    from collections import Counter
    t = Counter(); lead = 0
    for r in rows:
        if not isinstance(r, list) or col >= len(r):
            continue
        v = r[col]
        if v is None or v == '':
            continue
        t[type(v).__name__] += 1
        if str(v).startswith('0'):
            lead += 1
    print('   类型分布:', dict(t), ' 以0开头:', lead)

print('data.json / inventory*.json 顶层 keys')
for fn in ['data.json', 'inventory-core.json', 'inventory-plan.json', 'inventory-master.json']:
    fp = os.path.join(BASE, fn)
    if not os.path.exists(fp):
        continue
    with open(fp, 'r', encoding='utf-8') as f:
        j = json.load(f)
    sh = j.get('sheets') or {}
    print(f'  {fn}: {list(sh.keys())}')

check('data.json', '订单明细', 4, '订单明细 SKU编码')
check('inventory-plan.json', '分仓计划', 0, '分仓计划 产品Code (2026-08块)')
check('inventory-core.json', '分仓计划', 0, '分仓计划 产品Code')
check('inventory-core.json', '基础数据', 0, '基础数据 产品编码')
