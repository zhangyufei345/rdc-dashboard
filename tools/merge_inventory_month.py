# -*- coding: utf-8 -*-
"""
merge_inventory_month.py — 库存月度「合并件」构建器（换月部署的数据侧准备）

背景 / 为什么需要这个脚本
------------------------------------------------------------------
桌面《N月库存分析模版.xlsx》是**单月增量模板**，项目根 inventory.xlsx 是
**历月合并件**。二者的 sheet 结构不一样，直接 cp 覆盖会静默丢历史数据：

  | sheet        | 项目合并件(9月窗口) | 桌面10月模板 | 直接覆盖后果        |
  |--------------|--------------------|--------------|---------------------|
  | 基础数据      | 10644 x 29         | 15 x 9       | 产品主数据全丢      |
  | 拉回数据      | 16943 行(1-9月)    | 771 行(10月) | 丢 1-9 月历史       |
  | 转储数据      | 10919 行(7-9月)    | 3596 行(10月)| 丢 7-9 月历史       |
  | 库存金额      | 358 行(2025+2026)  | 171 行(2026) | 丢 2025 全年        |

v395(9月部署, commit b7da023) 的做法就是「以 8月合并件为底，把 9月模板增量并进来」。
本脚本把这套做法固化、可复用，避免每次靠记忆手敲。

用法
------------------------------------------------------------------
  python tools/merge_inventory_month.py                      # 默认 10 月，输出到 .cache
  python tools/merge_inventory_month.py --month 10 --apply  # 真正覆盖项目根 inventory.xlsx

  --base      项目根合并件（默认 ./inventory.xlsx）
  --template  桌面单月模板（默认 桌面/更新部署/{month}月库存分析模版.xlsx）
  --out       输出路径（默认 .cache/inventory-YYYY-MM-merged.xlsx）
  --apply     把合并结果写回 --base（默认关闭，防止误覆盖）
  --report    校验报告路径

合并口径（用户 2026-11-11 裁定：以项目合并件为底，保留历史 + 追加当月）
------------------------------------------------------------------
  KEEP      原样保留项目合并件（历史数据，零真实变化）
            订单满足率 / 2025周转 / 基础数据 / 5-9月库存状态分析 / 5-9月库存覆盖数据
  REPLACE   整体用新模板替换（当月刷新的快照/计划，不存在"历史"语义）
            2026周转 / 库存覆盖 / 分仓计划
  APPEND    项目合并件的有效行 + 新模板当月的有效行（先过滤尾部空行！）
            拉回数据 / 转储数据
  STITCH    左右两半分别「旧 2025 段 + 新 2026 段」拼接后逐行对齐
            库存金额
  NEW       新模板独有、整体新增
            {month}月库存状态分析 / {month}月库存覆盖数据 / 山姆转储（前端0引用，不进JSON白名单）

🔴 关键坑（都实测过）
  1. 桌面模板的 拉回数据/转储数据 sheet 尾部有上千行空行（10月: 拉回 771行仅273有效、
     转储 3596行仅2153有效）。追加前必须过滤整行空，否则 JSON 里塞进一堆 null 行。
  2. 库存金额是**一张 sheet 里横向贴了左右两张互不相关的表**：左表 4 个金额趋势透视块
     (c1-c10，按 r[1] 的 '求和项:库存金额_考核' 分块)，右表 2 个库存结构分析块
     (c12-c19，按 r[12] 的 '是否海南花露水' 分块)。两半共享行号但**各自按标签扫描**，
     所以可以分别拼接、再按行索引对齐；不能按固定行号切。
  3. 历史 sheet (5/6/7/8/9月状态分析·覆盖数据) 的全表 hash 差异经逐格核对 **100% 是
     '' vs None 或浮点末位精度**，真实值零变化 → 保留项目合并件是安全的，不要用模板覆盖。
  4. 2026周转右表「出货成本统计」列位置会漂移（9月 c12 → 10月 c13）。前端
     parseInventoryTurnoverSheet 在 v395 已把探测上界放宽到 c<=20，能自动识别，无需改代码。
  5. 分仓计划右侧月份列随模板平移（2026-09/10/11 → 2026-11/12/2027-01），且 v478 起
     demand.json 是计划权威源、会回填覆盖，故整体替换是安全的。
"""
import argparse
import hashlib
import os
import re
import shutil
import sys
import time
import warnings
from collections import Counter
from datetime import datetime, date

warnings.filterwarnings('ignore')
import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESKTOP = r'C:/Users/zhangyufei1/Desktop/更新部署'

KEEP_SHEETS = [
    '订单满足率', '2025周转', '基础数据',
    '5月库存状态分析', '6月库存状态分析', '7月库存状态分析',
    '8月库存状态分析', '9月库存状态分析',
    '5月库存覆盖数据', '6月库存覆盖数据', '7月库存覆盖数据',
    '8月库存覆盖数据', '9月库存覆盖数据',
]
REPLACE_SHEETS = ['2026周转', '库存覆盖', '分仓计划']
APPEND_SHEETS = ['拉回数据', '转储数据']
STITCH_SHEET = '库存金额'


def log(msg, f=None):
    print(msg, flush=True)
    if f:
        f.write(msg + '\n')


def rows_of(ws):
    return [list(r) for r in ws.iter_rows(values_only=True)]


def is_blank(row):
    return all(v is None or (isinstance(v, str) and v.strip() == '') for v in row)


def ym_of(v):
    if isinstance(v, (datetime, date)):
        return '%04d-%02d' % (v.year, v.month)
    if isinstance(v, str) and len(v) >= 7 and v[4] == '-':
        return v[:7]
    return None


def trim_trailing_blank(rows):
    n = len(rows)
    while n > 0 and is_blank(rows[n - 1]):
        n -= 1
    return rows[:n]


def sheet_md5(rows):
    m = hashlib.md5()
    for r in rows:
        m.update(repr(r).encode('utf-8', 'ignore'))
    return m.hexdigest()[:10]


def rows_equal_loose(a, b):
    """逐格比较，容忍两类 Excel 往返噪声：① ''/None 等价 ② 浮点末位精度。
    openpyxl 写回时会把 19115.314000000002 归一成 19115.314，属存储精度归一化，
    不是数据差异；用全行 repr hash 比较会产生假红（v423 同款教训）。"""
    if len(a) != len(b):
        return False
    for x, y in zip(a, b):
        if len(x) != len(y):
            return False
        for u, v in zip(x, y):
            if u == v:
                continue
            if u in (None, '') and v in (None, ''):
                continue
            if isinstance(u, (int, float)) and isinstance(v, (int, float)) \
                    and not isinstance(u, bool) and not isinstance(v, bool) \
                    and abs(float(u) - float(v)) < 1e-6:
                continue
            if isinstance(u, str) and isinstance(v, str) and u.strip() == v.strip():
                continue
            return False
    return True


# ---------------------------------------------------------------- 库存金额拼接
def _year_label(v):
    s = str(v).strip() if v is not None else ''
    m = re.match(r'^(\d{4})年$', s)
    return m.group(1) if m else None


def stitch_amount(old_rows, new_rows, month, rep):
    """
    左右两半分别处理，再按行索引对齐。
    左表(c1-c10): 以 r[1]=='求和项:库存金额_考核' 分块；每块 = 块头 + 旧2025段 + 新2026段
    右表(c12-c19): 以 r[12]=='是否海南花露水' 分块；每块 = 块头 + 旧2025段 + 新2026段
    """
    W = 19
    old_rows = [list(r)[:W] + [None] * max(0, W - len(r)) for r in old_rows]
    new_rows = [list(r)[:W] + [None] * max(0, W - len(r)) for r in new_rows]

    # ---- 左半：按透视块拼接 ----
    def left_blocks(rows):
        starts = [i for i, r in enumerate(rows)
                  if str(r[1] or '').strip() == '求和项:库存金额_考核']
        return [(s, starts[k + 1] if k + 1 < len(starts) else len(rows))
                for k, s in enumerate(starts)]

    ob, nb = left_blocks(old_rows), left_blocks(new_rows)
    log('  [左表] 透视块数 旧=%d 新=%d' % (len(ob), len(nb)), rep)
    if len(ob) != len(nb) or len(ob) != 4:
        raise RuntimeError('库存金额左表块数异常，拒绝合并')

    left_out = []
    for k, ((os_, oe), (ns, ne)) in enumerate(zip(ob, nb)):
        oseg, nseg = old_rows[os_:oe], new_rows[ns:ne]
        # 旧 2025 段：从 '2025年' 行到 '2026年' 行之前
        yi = [i for i, r in enumerate(oseg) if _year_label(r[1]) == '2025']
        zi = [i for i, r in enumerate(oseg) if _year_label(r[1]) == '2026']
        nzi = [i for i, r in enumerate(nseg) if _year_label(r[1]) == '2026']
        if not (yi and zi and nzi):
            raise RuntimeError('库存金额左表块%d 年份锚点缺失' % k)
        y25, y26, ny26 = yi[0], zi[0], nzi[0]
        seg25 = oseg[y25:y26]
        # 🔴 左表 2026 段必须截断到**最后一个月份标签行**，不能取到块尾：
        #   第 4 块没有下一个「求和项」边界，块尾一路延伸到 sheet 末尾（含右表区域），
        #   若整段取用会拖进 ~100 行空标签行，把左表块撑坏（10月模板实测 108 行 vs 应有 11 行）。
        seg26_raw = nseg[ny26:]
        last_month = -1
        for i, r in enumerate(seg26_raw):
            if re.match(r'^\d+月$', str(r[1] or '').strip()):
                last_month = i
        if last_month < 0:
            raise RuntimeError('库存金额左表块%d 的 2026 段找不到月份标签行' % k)
        seg26 = seg26_raw[:last_month + 1]
        # 骨架：旧块的块头(0..y25) + 2025段 + 新2026段
        block = oseg[:y25] + seg25 + seg26
        log('    块%d: 块头%d行 + 2025段%d行 + 新2026段%d行' %
            (k, y25, len(seg25), len(seg26)), rep)
        left_out.extend(block)
        if k == 0:
            left_head_len = y25  # 表标题行只在第一块头里
        # 块间补一个空行，避免两块贴太紧（前端按标签扫描，空行无影响）
        left_out.append([None] * W)

    # ---- 右半：按 hainanMode 块拼接 ----
    def right_marks(rows):
        return [i for i, r in enumerate(rows)
                if str(r[12] or '').strip() == '是否海南花露水']

    om, nm = right_marks(old_rows), right_marks(new_rows)
    o_ranges = [(0, om[0])] + [(om[0], len(old_rows))] if om else [(0, len(old_rows))]
    n_ranges = [(0, nm[0])] + [(nm[0], len(new_rows))] if nm else [(0, len(new_rows))]
    log('  [右表] 结构块数 旧=%d 新=%d' % (len(o_ranges), len(n_ranges)), rep)
    if len(o_ranges) != 2 or len(n_ranges) != 2:
        raise RuntimeError('库存金额右表块数异常，拒绝合并')

    right_out = []
    for k, ((os_, oe), (ns, ne)) in enumerate(zip(o_ranges, n_ranges)):
        oseg, nseg = old_rows[os_:oe], new_rows[ns:ne]
        oy = [i for i, r in enumerate(oseg) if _year_label(r[12]) == '2025']
        oz = [i for i, r in enumerate(oseg) if _year_label(r[12]) == '2026']
        ny = [i for i, r in enumerate(nseg) if _year_label(r[12]) == '2026']
        if not (oy and oz and ny):
            raise RuntimeError('库存金额右表块%d 年份锚点缺失' % k)
        seg25 = oseg[oy[0]:oz[0]]
        seg26 = trim_trailing_blank(nseg[ny[0]:])
        # 块头：旧块 0..2025年行（含表头/筛选标签）
        block = oseg[:oy[0]] + seg25 + seg26
        log('    块%d: 块头%d行 + 2025段%d行 + 新2026段%d行' %
            (k, oy[0], len(seg25), len(seg26)), rep)
        right_out.extend(block)

    # ---- 左右按行对齐 ----
    H = max(len(left_out), len(right_out))
    out = []
    for i in range(H):
        r = [None] * W
        if i < len(left_out):
            for c in range(0, 11):
                r[c] = left_out[i][c]
        if i < len(right_out):
            for c in range(11, W):
                r[c] = right_out[i][c]
        out.append(r)
    out = trim_trailing_blank(out)
    log('  [对齐] 左%d行 右%d行 -> 输出%d行 x %d列' %
        (len(left_out), len(right_out), len(out), W), rep)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--month', type=int, default=10)
    ap.add_argument('--base', default=os.path.join(ROOT, 'inventory.xlsx'))
    ap.add_argument('--template', default=None)
    ap.add_argument('--out', default=None)
    ap.add_argument('--report', default=None)
    ap.add_argument('--apply', action='store_true')
    a = ap.parse_args()

    M = a.month
    tpl = a.template or os.path.join(DESKTOP, '%d月库存分析模版.xlsx' % M)
    out = a.out or os.path.join(ROOT, '.cache', 'inventory-2026-%02d-merged.xlsx' % M)
    rep_path = a.report or os.path.join(ROOT, '.cache', '_inv_merge_2026-%02d_report.txt' % M)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    os.makedirs(os.path.dirname(rep_path), exist_ok=True)

    for p in (a.base, tpl):
        if not os.path.exists(p):
            log('ERROR: 文件不存在 %s' % p)
            return 2

    rep = open(rep_path, 'w', encoding='utf-8')
    log('=== 库存合并件构建 %s ===' % datetime.now().strftime('%Y-%m-%d %H:%M:%S'), rep)
    log('底本  : %s (%.2f MB)' % (a.base, os.path.getsize(a.base) / 1e6), rep)
    log('模板  : %s (%.2f MB)' % (tpl, os.path.getsize(tpl) / 1e6), rep)
    log('输出  : %s' % out, rep)
    log('口径  : 以项目合并件为底，保留历史 + 追加 %d 月' % M, rep)
    log('', rep)

    t0 = time.time()
    wb_base = openpyxl.load_workbook(a.base, read_only=True, data_only=True)
    wb_tpl = openpyxl.load_workbook(tpl, read_only=True, data_only=True)
    base_names, tpl_names = wb_base.sheetnames, wb_tpl.sheetnames
    log('底本 sheet %d 张 / 模板 sheet %d 张' % (len(base_names), len(tpl_names)), rep)
    new_names = [n for n in tpl_names if n not in base_names]
    log('模板独有 sheet: %s' % new_names, rep)
    log('', rep)

    cache = {}
    def B(n):
        if ('b', n) not in cache:
            cache[('b', n)] = rows_of(wb_base[n])
        return cache[('b', n)]
    def T(n):
        if ('t', n) not in cache:
            cache[('t', n)] = rows_of(wb_tpl[n])
        return cache[('t', n)]

    # sheet 顺序：底本顺序 + 新 sheet 按模板中的相对位置插入
    final_order = list(base_names)
    for n in new_names:
        idx = tpl_names.index(n)
        # 找到模板里该 sheet 之前、且已存在于 final_order 的最近一张
        pos = len(final_order)
        for j in range(idx - 1, -1, -1):
            if tpl_names[j] in final_order:
                pos = final_order.index(tpl_names[j]) + 1
                break
        final_order.insert(pos, n)
    log('输出 sheet 顺序 (%d): %s' % (len(final_order), ' | '.join(final_order)), rep)
    log('', rep)

    payload = {}
    stats = {}

    # 1) KEEP
    for n in KEEP_SHEETS:
        if n not in base_names:
            raise RuntimeError('底本缺 sheet: %s' % n)
        payload[n] = B(n)
        stats[n] = ('KEEP', len(payload[n]))

    # 2) REPLACE
    for n in REPLACE_SHEETS:
        if n not in tpl_names:
            raise RuntimeError('模板缺 sheet: %s' % n)
        payload[n] = T(n)
        stats[n] = ('REPLACE', len(payload[n]))

    # 3) APPEND
    log('=== APPEND（过滤尾部空行 + 只追加目标月）===', rep)
    for n in APPEND_SHEETS:
        old = trim_trailing_blank(B(n))
        new = trim_trailing_blank(T(n))
        hdr, old_data, new_data = new[0], old[1:], new[1:]
        ci = 0 if n == '拉回数据' else 1  # 日期列索引
        old_valid = [r for r in old_data if not is_blank(r)]
        new_nonblank = [r for r in new_data if not is_blank(r)]
        tgt = '2026-%02d' % M
        cur_months = Counter(ym_of(r[ci]) for r in new_nonblank)
        log('  %s: 底本有效 %d 行 / 模板非空 %d 行 (原 %d 行) 模板月份 %s' %
            (n, len(old_valid), len(new_nonblank), len(new_data), dict(cur_months)), rep)
        if set(k for k in cur_months if k) != {tgt}:
            raise RuntimeError('%s 模板含非目标月数据 %s，拒绝合并' % (n, dict(cur_months)))
        # 🔴 只追加「日期字段确实是目标月」的行。模板尾部常有残留脏行：
        #   10月「拉回数据」r274 整行只有一个采购凭证号 4800174840、日期为空，
        #   若按「非空行」过滤会把它当有效数据追加（实测多出 1 行）。
        new_valid = [r for r in new_nonblank if ym_of(r[ci]) == tgt]
        dirty = len(new_nonblank) - len(new_valid)
        log('     过滤无日期残留行 %d 行 -> 实际追加 %d 行' % (dirty, len(new_valid)), rep)
        # 追加行补齐到同样列宽
        w = max(len(hdr), max((len(r) for r in old_valid), default=0))
        add = []
        for r in new_valid:
            rr = list(r)[:w] + [None] * max(0, w - len(r))
            add.append(rr)
        payload[n] = [list(hdr)[:w] + [None] * max(0, w - len(hdr))] + old_valid + add
        stats[n] = ('APPEND +%d' % len(add), len(payload[n]))
        log('     -> 合并后 %d 行（底本 %d + 新增 %d）' %
            (len(payload[n]), len(old_valid), len(add)), rep)

    # 4) STITCH 库存金额
    log('', rep)
    log('=== STITCH 库存金额（旧2025段 + 新2026段，左右分别拼接）===', rep)
    payload[STITCH_SHEET] = stitch_amount(B(STITCH_SHEET), T(STITCH_SHEET), M, rep)
    stats[STITCH_SHEET] = ('STITCH', len(payload[STITCH_SHEET]))

    # 5) NEW
    for n in new_names:
        payload[n] = T(n)
        stats[n] = ('NEW', len(payload[n]))

    wb_base.close()
    wb_tpl.close()

    # ---- 写出（纯值，前端只读值，格式无关）----
    log('', rep)
    log('=== 写出 ===', rep)
    owb = openpyxl.Workbook()
    owb.remove(owb.active)
    for n in final_order:
        ws = owb.create_sheet(n)
        for r in payload[n]:
            ws.append([None if (isinstance(v, str) and v == '') else v for v in r])
    owb.save(out)
    log('已写出 %s (%.2f MB, %.1fs)' %
        (out, os.path.getsize(out) / 1e6, time.time() - t0), rep)

    # ---- 全量校验 ----
    log('', rep)
    log('=== 全量校验 ===', rep)
    vw = openpyxl.load_workbook(out, read_only=True, data_only=True)
    fails = []
    def chk(cond, msg):
        log(('  PASS | ' if cond else '  FAIL | ') + msg, rep)
        if not cond:
            fails.append(msg)

    chk(set(vw.sheetnames) == set(final_order), 'sheet 集合完整 (%d 张)' % len(final_order))
    for n in KEEP_SHEETS:
        a1, b1 = sheet_md5(B(n)), sheet_md5(rows_of(vw[n]))
        chk(a1 == b1, 'KEEP %s 内容未变 (hash %s)' % (n, a1))
    for n in REPLACE_SHEETS:
        chk(rows_equal_loose(T(n), rows_of(vw[n])),
            'REPLACE %s == 新模板（容忍浮点末位/空值归一）' % n)

    # 历史不丢
    for n, col, expect in [('拉回数据', 0, '2026-09'), ('转储数据', 1, '2026-09')]:
        rr = rows_of(vw[n])
        months = Counter(ym_of(r[col]) for r in rr[1:] if not is_blank(r))
        chk(expect in months, '%s 保留 %s (%d 行)' % (n, expect, months.get(expect, 0)))
        chk(months.get('2026-%02d' % M, 0) > 0,
            '%s 新增 %d 月 (%d 行)' % (n, M, months.get('2026-%02d' % M, 0)))
        chk(sum(1 for r in rr[1:] if is_blank(r)) == 0, '%s 无空白行' % n)

    # 产品主数据
    bd = rows_of(vw['基础数据'])
    chk(len(bd) >= 10644, '基础数据产品主数据 %d 行' % len(bd))
    chk(any(str(v or '').strip() == '箱规转化因子' for v in bd[0]),
        '基础数据 block C 表头完整（箱规转化因子）')

    # 2026周转新增当月列
    rr = vw['2026周转']
    r2 = list(rr.iter_rows(min_row=2, max_row=2, values_only=True))[0]
    serials = [v for v in r2 if isinstance(v, (int, float)) and v > 40000]
    chk(len(serials) >= 10, '2026周转月份列 %d 个（含 %d 月）' % (len(serials), M))
    cost_col = None
    for i, r in enumerate(rr.iter_rows(values_only=True)):
        for c, v in enumerate(r):
            if isinstance(v, str) and '出货成本统计' in v:
                cost_col = c + 1
    chk(cost_col is not None, '2026周转右表「出货成本统计」可定位 (c%d)' % (cost_col or 0))

    # 库存金额 2025 + 2026(含当月)
    ar = rows_of(vw['库存金额'])
    ly = Counter(); ry = Counter(); lm = set(); rm = set()
    for r in ar:
        yl = _year_label(r[1] if len(r) > 1 else None)
        yrv = _year_label(r[12] if len(r) > 12 else None)
        if yl: ly[yl] += 1
        if yrv: ry[yrv] += 1
        ml = re.match(r'^(\d+)月$', str(r[1] or '').strip())
        mr = re.match(r'^(\d+)月$', str(r[12] or '').strip())
        if ml: lm.add(int(ml.group(1)))
        if mr: rm.add(int(mr.group(1)))
    chk('2025' in ly and '2026' in ly, '库存金额左表含 2025 + 2026 段 %s' % dict(ly))
    chk('2025' in ry and '2026' in ry, '库存金额右表含 2025 + 2026 段 %s' % dict(ry))
    chk(M in lm and M in rm, '库存金额左右表均含 %d 月' % M)

    # 新 sheet
    for n in new_names:
        chk(n in vw.sheetnames and vw[n].max_row > 1, 'NEW %s (%d 行)' % (n, vw[n].max_row))

    vw.close()
    log('', rep)
    log('=== 逐 sheet 汇总 ===', rep)
    for n in final_order:
        kind, cnt = stats.get(n, ('?', 0))
        log('  %-22s %-12s %6d 行' % (n, kind, cnt), rep)
    log('', rep)
    log('结果: %s（%d 项失败）' % ('ALL PASS' if not fails else 'FAILED', len(fails)), rep)
    if fails:
        for f in fails:
            log('  - ' + f, rep)
    rep.close()

    if a.apply:
        if fails:
            log('校验未通过，拒绝 --apply 覆盖项目根 inventory.xlsx')
            return 1
        shutil.copy2(out, a.base)
        log('已覆盖 %s' % a.base)
    return 0 if not fails else 1


if __name__ == '__main__':
    sys.exit(main())
