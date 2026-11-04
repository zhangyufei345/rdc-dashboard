# -*- coding: utf-8 -*-
"""任务1 终版：用页面权威口径（buildPlanSkuAgg 导出的 plan/shipped）做「假 D」翻转测试。

关键更正：
  · 清单「订单量」列 ≠ 销售进度分子（后者已并入大仓直发，v360）
    → 例：20881 华南 清单订单量 8,616，页面出货 22,464
  · demand.json 的 plan 键保留前导零（如 '09539'），查表不能去零
"""
import json
import os

REPO = r'C:\Users\zhangyufei1\WorkBuddy\2026-06-30-09-24-40'
MONTH = '2026-10'


def nk(s):
    s = '' if s is None else str(s).strip()
    return s.lstrip('0') or s


def nrdc(s):
    s = (s or '').strip()
    return '华南RDC' if s in ('广东RDC', '广东仓', '广东', '华南仓') else s


psa = json.load(open(os.path.join(REPO, '.cache/_psa_2026-10.json'), encoding='utf-8'))['keep']
dem = json.load(open(os.path.join(REPO, 'demand.json'), encoding='utf-8'))
plan_dem = dem.get('plan') or {}
scan = json.load(open(os.path.join(REPO, '.cache/_dp_raise_scan_2026-10.json'), encoding='utf-8'))


def dem_plan(sku, rdc, month):
    for cand in (sku, nk(sku), sku.zfill(5)):
        b = plan_dem.get(cand) or {}
        for rcand in (rdc, nrdc(rdc)):
            v = (b.get(rcand) or {}).get(month)
            if v is not None:
                return v
    return None


rows = []
for x in scan:
    if not x['attr'].startswith('D'):
        continue
    key = nk(x['sku']) + '|' + nrdc(x['rdc'])
    p = psa.get(key) or {}
    plan = p.get('plan')
    ship = p.get('shipped')
    comp = p.get('comp')
    dp = dem_plan(x['sku'], x['rdc'], MONTH)
    low = x['dp_at_short']
    comp_low = None
    if low and low > 0 and ship is not None:
        comp_low = ship / low
    elif low == 0 and ship:
        comp_low = float('inf')
    src = 'DP_共识' if dp is not None else ('分仓计划表/覆盖' if plan else '无')
    fake = bool(dp is not None and comp is not None and comp < 1.0
                and comp_low is not None and comp_low >= 1.0)
    rows.append(dict(x, psa_key=key, page_plan=plan, page_ship=ship, page_comp=comp,
                     dem_plan=dp, plan_low=low, comp_low=comp_low, plan_src=src, fakeD=fake))

print('%-7s %-9s %-7s %-7s %-8s %-8s %-9s %-9s %-9s %-6s' % (
    'SKU', 'RDC', '计划源', '缺货前', '页面出货', '页面计划', '按缺货前%', '按期末%', '期末DP', '假D'))
print('-' * 108)
for x in sorted(rows, key=lambda y: -(y['comp_low'] if y['comp_low'] is not None else -9)):
    f = lambda v, pct=False: ('-' if v is None else ('∞' if v == float('inf') else
                                ('%.1f%%' % (v * 100) if pct else '%g' % v)))
    print('%-7s %-9s %-7s %-7s %-8s %-8s %-9s %-9s %-9s %-6s' % (
        x['sku'], x['rdc'], x['plan_src'], f(x['plan_low']), f(x['page_ship']),
        f(x['page_plan']), f(x['comp_low'], True), f(x['page_comp'], True),
        f(x['dp_at_short'] if False else x['dp_last']), '★是' if x['fakeD'] else '否'))

fake = [x for x in rows if x['fakeD']]
print('\n【终版结论】10 月「严重度高重点跟进清单」')
print('  总行数 58｜D（需重点排查）17 行｜其中假 D = %d 行（占 D 的 %.0f%%，占全清单 %.0f%%）' % (
    len(fake), 100.0 * len(fake) / len(rows), 100.0 * len(fake) / 58))
print('\n  假 D 明细（这批应从 D 改判为 C1 结构性超销）：')
for x in sorted(fake, key=lambda y: -y['comp_low']):
    print('   %-6s %-9s 按缺货前计划 %.1f%% → 按期末计划 %.1f%%｜计划 %s 起被上调' % (
        x['sku'], x['rdc'], x['comp_low'] * 100, x['page_comp'] * 100, x['raise_date']))
json.dump(rows, open(os.path.join(REPO, '.cache/_fakeD_final.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print('\n已写入 .cache/_fakeD_final.json')
