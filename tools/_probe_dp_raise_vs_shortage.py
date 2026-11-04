# -*- coding: utf-8 -*-
"""任务1：全量扫描 —— 10 月「严重度高重点跟进清单」58 行中，
   有多少行的 D（需重点排查）是由「DP 在缺货发生之后被上调 ≥2 倍」造成的假 D。

证据链：
  1) git 历史里 data.json 每次提交 = 当天部署时的「分仓需求」原值
     （11-03 e70d699 才归档成 data-2026-10.json）
  2) 订单明细（data-2026-10.json）→ 每个 SKU×RDC 的「首次缺货日期」
  3) 两者交叉 → DP 最大单次上调倍数 / 上调日期 / 上调前值 / 期末值
"""
import json
import os
import subprocess
import datetime
from collections import defaultdict

REPO = r'C:\Users\zhangyufei1\WorkBuddy\2026-06-30-09-24-40'
MONTH = '2026-10'

SHAS = [
    ('6efd33a', '2026-10-10'),
    ('7b07e20', '2026-10-12'),
    ('d3fd53d', '2026-10-13'),
    ('e93a42a', '2026-10-14'),
    ('bd4d413', '2026-10-15'),
    ('e43b1c3', '2026-10-16'),
    ('bd32128', '2026-10-18'),
    ('89d8335', '2026-10-19'),
    ('0a624ee', '2026-10-20'),
    ('377762a', '2026-10-20b'),
    ('bfe14a9', '2026-10-21'),
    ('3daee1f', '2026-10-22'),
    ('8bcf869', '2026-10-23'),
    ('7df989d', '2026-10-26'),
    ('ff93156', '2026-10-27'),
    ('5dc6201', '2026-10-28'),
    ('4d83ef1', '2026-10-29'),
    ('f72ceb4', '2026-10-30'),
    ('e70d699', '2026-11-03'),
]


def norm_rdc(s):
    s = (s or '').strip()
    if s in ('广东RDC', '广东仓', '广东'):
        return '华南RDC'
    if s in ('华南仓',):
        return '华南RDC'
    return s


def norm_sku(s):
    s = '' if s is None else str(s).strip()
    return s.lstrip('0') or s


def xl_date(v):
    if v is None or v == '':
        return None
    try:
        n = float(v)
    except Exception:
        return None
    if n < 20000:
        return None
    return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(n))).isoformat()


def git_show(sha, path='data.json'):
    p = subprocess.run(['git', 'show', '%s:%s' % (sha, path)], cwd=REPO,
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return p.stdout if p.returncode == 0 else None


# ---------- 1. 逐次部署的 DP 快照 ----------
snapshots = []   # [(date_str, {(sku_norm, rdc_norm): dp})]
for sha, when in SHAS:
    raw = git_show(sha)
    if not raw:
        print('!! %s %s 读不到' % (sha, when))
        continue
    d = json.loads(raw.decode('utf-8'))
    fd = (d.get('sheets') or {}).get('分仓需求')
    if not fd:
        print('!! %s %s 无分仓需求' % (sha, when))
        continue
    hdr = fd[0]
    mi = None
    for i, h in enumerate(hdr):
        if h is not None and str(h).strip() == MONTH:
            mi = i
            break
    if mi is None:
        print('!! %s %s 表头无 %s : %s' % (sha, when, MONTH, hdr))
        continue
    cur = None
    m = {}
    for r in fd[1:]:
        if r is None or len(r) < 6:
            continue
        ind = str(r[5]) if r[5] is not None else ''
        if ind == 'DP_共识数量':
            cur = r
            key = (norm_sku(r[0]), norm_rdc(r[2]))
            v = r[mi]
            if isinstance(v, (int, float)):
                m[key] = float(v)
    snapshots.append((when, m))
    print('快照 %-11s %-8s DP keys=%d' % (when, sha, len(m)))

# ---------- 2. 订单明细：首次缺货日期 ----------
d = json.load(open(os.path.join(REPO, 'data-2026-10.json'), encoding='utf-8'))
od = d['sheets']['订单明细']
hdr = od[0]
ci = {str(h): i for i, h in enumerate(hdr) if h is not None}
c_date, c_sku, c_wh = ci['SAP放行日期'], ci['SKU编码'], ci['仓库名称']
c_short = ci['首日缺货量']
c_ord = ci['订单支数']

short_days = defaultdict(set)      # (sku,rdc) -> {date}
short_amt = defaultdict(float)     # (sku,rdc) -> total shortage
ord_amt = defaultdict(float)
for r in od[1:]:
    if r is None or len(r) <= c_short:
        continue
    dt = xl_date(r[c_date])
    if not dt:
        continue
    wd = datetime.date.fromisoformat(dt).weekday()
    if wd >= 5:
        continue                    # 项目红线：缺货排除双休日
    key = (norm_sku(r[c_sku]), norm_rdc(r[c_wh]))
    o = r[c_ord] if isinstance(r[c_ord], (int, float)) else 0
    s = r[c_short] if isinstance(r[c_short], (int, float)) else 0
    ord_amt[key] += o
    if s and s > 0:
        short_days[key].add(dt)
        short_amt[key] += s

print('\n订单明细 SKU×RDC 组合=%d，有缺货组合=%d' % (len(ord_amt), len(short_days)))

# ---------- 3. 交叉 ----------
focus = json.load(open(os.path.join(REPO, '.cache/_focus_dump_2026-10.json'), encoding='utf-8'))
rows = focus['rows']
COL = {'brand': 0, 'sku': 1, 'name': 2, 'cat': 3, 'lt': 4, 'rdc': 5,
       'ord': 6, 'short': 7, 'rate': 8, 'sdays': 9, 'odays': 10, 'freq': 11,
       'wh': 12, 'whabn': 13, 'bottle': 14, 'attr': 15, 'prog': 16, 'gap': 17}


def toint(s):
    try:
        return int(str(s).replace(',', ''))
    except Exception:
        return 0


out = []
for r in rows:
    sku = norm_sku(r[COL['sku']])
    rdc = norm_rdc(r[COL['rdc']])
    key = (sku, rdc)
    seq = []
    for when, m in snapshots:
        if key in m:
            seq.append((when, m[key]))
    fsd = sorted(short_days.get(key, []))
    first_short = fsd[0] if fsd else None

    # 最大单次上调
    best = None   # (ratio, date, prev, new)
    for i in range(1, len(seq)):
        pv, nv = seq[i - 1][1], seq[i][1]
        if pv and pv > 0 and nv > pv:
            rt = nv / pv
            if best is None or rt > best[0]:
                best = (rt, seq[i][0], pv, nv)
    dp_first = seq[0][1] if seq else None
    dp_last = seq[-1][1] if seq else None
    dp_max = max([v for _, v in seq], default=None)

    # 缺货发生时的 DP：取「首次缺货日期之前最近一次部署」的值
    #   若首缺日早于首个快照（10-10 之前就缺货），回退用最早快照值（这是可知的最低计划）
    dp_at_short = None
    dp_at_short_src = None
    if first_short:
        for when, v in seq:
            if when <= first_short:
                dp_at_short = v
                dp_at_short_src = 'before'
    if dp_at_short is None and seq:
        dp_at_short = seq[0][1]
        dp_at_short_src = 'earliest'
    hit_short = False     # 上调发生在缺货之后
    ratio = best[0] if best else 0
    if best and first_short:
        hit_short = best[1] > first_short

    ship = toint(r[COL['ord']])

    # 页面用的计划量 = 归档 data-2026-10.json「分仓需求」2026-10 列
    #   （已实测 40057/40334/20956/56000 四个 SKU 与该次 git 末次部署值完全一致）
    plan_used = dp_last
    comp_used = None
    if plan_used and plan_used > 0:
        comp_used = ship / plan_used
    elif plan_used == 0 and ship > 0:
        comp_used = float('inf')

    # 翻转测试：用「缺货发生前的计划」重算完成率
    plan_low = dp_at_short
    comp_low = None
    if plan_low and plan_low > 0:
        comp_low = ship / plan_low
    elif plan_low == 0 and ship > 0:
        comp_low = float('inf')

    out.append({
        'sku': r[COL['sku']], 'name': r[COL['name']], 'rdc': r[COL['rdc']],
        'attr': r[COL['attr']], 'lt': r[COL['lt']],
        'order': ship, 'short': toint(r[COL['short']]),
        'sdays': r[COL['sdays']], 'first_short': first_short,
        'dp_first': dp_first, 'dp_at_short': dp_at_short,
        'dp_max': dp_max, 'dp_last': dp_last,
        'plan_used': plan_used, 'comp_used': comp_used,
        'comp_low': (None if comp_low is None else round(comp_low, 4)),
        'max_ratio': round(ratio, 2),
        'raise_date': best[1] if best else None,
        'raise_from': best[2] if best else None,
        'raise_to': best[3] if best else None,
        'raise_after_short': hit_short,
        'flag': bool(ratio >= 2.0 and hit_short),
        # 真·假 D：页面判滞后(comp<1) 但用缺货前的计划算不滞后(comp_low>=1)
        'fakeD': bool(r[COL['attr']].startswith('D') and comp_used is not None
                      and comp_used < 1.0 and comp_low is not None and comp_low >= 1.0),
        'seq': seq,
    })

# ---------- 4. 汇总 ----------
tot = len(out)
flagged = [x for x in out if x['flag']]
print('\n清单总行数 = %d' % tot)
from collections import Counter
print('归因分布:', dict(Counter(x['attr'].split(' ')[0] for x in out)))
print('命中「DP 缺货后上调 >=2 倍」= %d 行 (%.1f%%)' % (len(flagged), 100.0 * len(flagged) / tot))
print('其中归因为 D 的 = %d / %d' % (sum(1 for x in flagged if x['attr'].startswith('D')),
                                    sum(1 for x in out if x['attr'].startswith('D'))))
print('\n命中明细（按倍数降序）:')
print('%-7s %-9s %-8s %-4s %-6s %-6s %-6s %-6s %-11s %-9s' % (
    'SKU', 'RDC', '归因', '缺货天', '首缺日', '上调前', '上调后', '倍数', '上调部署日', '期末DP'))
print('-' * 100)
for x in sorted(flagged, key=lambda y: -y['max_ratio']):
    f = lambda v: '-' if v is None else ('%g' % v)
    print('%-7s %-9s %-8s %-4s %-10s %-8s %-8s %-6s %-11s %-9s' % (
        x['sku'], x['rdc'], x['attr'].split(' ')[0], x['sdays'],
        x['first_short'] or '-', f(x['raise_from']), f(x['raise_to']),
        '%.1fx' % x['max_ratio'], x['raise_date'], f(x['dp_last'])))

# 未命中但 D 的，看看倍数分布（判断阈值是否合适）
print('\n--- 归因 D 但未命中(倍数<2 或 上调早于缺货) 的 %d 行 ---' % (
    sum(1 for x in out if x['attr'].startswith('D') and not x['flag'])))
print('%-7s %-9s %-6s %-10s %-8s %-8s %-6s %-11s' % ('SKU', 'RDC', '倍数', '首缺日', '上调前', '上调后', '上调日', '期末DP'))
for x in out:
    if not x['attr'].startswith('D') or x['flag']:
        continue
    f = lambda v: '-' if v is None else ('%g' % v)
    print('%-7s %-9s %-6s %-10s %-8s %-8s %-6s %-11s' % (
        x['sku'], x['rdc'], '%.2fx' % x['max_ratio'] if x['max_ratio'] else '-',
        x['first_short'] or '-', f(x['raise_from']), f(x['raise_to']), x['raise_date'] or '-', f(x['dp_last'])))

json.dump(out, open(os.path.join(REPO, '.cache/_dp_raise_scan_2026-10.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print('\n明细已写入 .cache/_dp_raise_scan_2026-10.json')

# ---------- 5. 真·假 D 翻转测试 ----------
print('\n' + '=' * 110)
print('【翻转测试】归因 D 的行：页面用的计划量 vs 缺货发生时的计划量，重算完成率')
print('=' * 110)
drows = [x for x in out if x['attr'].startswith('D')]
print('%-7s %-9s %-8s %-11s %-9s %-9s %-9s %-9s %-6s' % (
    'SKU', 'RDC', '出货', '缺货前计划', '缺货前%', '页面计划', '页面%', '期末DP', '假D?'))
print('-' * 110)


def fm(v, pct=False):
    if v is None:
        return '-'
    if v == float('inf'):
        return '∞'
    if pct:
        return '%.1f%%' % (v * 100)
    return '%g' % v


for x in sorted(drows, key=lambda y: -(y['comp_low'] if y['comp_low'] not in (None,) else -9)):
    print('%-7s %-9s %-8s %-11s %-9s %-9s %-9s %-9s %-6s' % (
        x['sku'], x['rdc'], fm(x['order']), fm(x['dp_at_short']),
        fm(x['comp_low'], True), fm(x['plan_used']), fm(x['comp_used'], True),
        fm(x['dp_last']), '★是' if x['fakeD'] else '否'))

fake = [x for x in out if x['fakeD']]
print('\n【结论】清单 %d 行' % tot)
print('  归因 D（需重点排查）共 %d 行' % len(drows))
print('  其中「假 D」= %d 行 (%.0f%% of D, %.0f%% of 全清单)' % (
    len(fake), 100.0 * len(fake) / max(len(drows), 1), 100.0 * len(fake) / tot))
print('  命中「DP 缺货后上调≥2倍」= %d 行，其中同时是假 D 的 = %d 行' % (
    len(flagged), sum(1 for x in flagged if x['fakeD'])))
print('  ★ 说明：≥2倍 不是充分条件，判据应取「用缺货前计划算 comp≥1」')
