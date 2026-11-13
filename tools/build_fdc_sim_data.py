# -*- coding: utf-8 -*-
"""
山姆前置仓「补货量 → 逐日库存演化」模拟器 · 数据层构建器（v1，仅离线产出，不改看板代码）

【用户 2026-11-12 裁定的口径】
  1. 实际出货：T-1 出货 = 截止 T 日累计 − 截止 T-1 日累计（切片差分），记在业务日 T-1。
  2. 补货决策：用「当时的 DP」（该决策日可得的最近一次切片 DP 快照），零前视。
  3. 期初库存：给「具体日期 + 当日库存」，从该日期开始推演；最早 2026-10-18。
  4. 跨天区间量：整笔记在区间末日，不摊分；页面标注「含 N 天累计」。
  5. 嘉兴 2026-11-06 之前无 DP 共识计划 → 该段不下补货决策（只消耗库存）。
  6. 参数复用现有「山姆补货跟踪」全套（整车/最小起补/覆盖天数/服务水平/免租/时效）。

【数据源】只用 git 里 data.xlsx 的每日部署提交链（同一来源链，避免混用本地备份产生假负差分）。
  实测两种 sheet schema：
    W 周桶（63 列，表头 `2026-10 W3 (1012~1018)`）——18 个切片
    M 月度（29 列，表头 `2026-10` / `2026-11`）——1 个切片（10-19 89d8335）
  归一：W 取 10/11 月所有周列求和；M 取 10/11 月两列求和。两者都等于「累计出货」。
  M 格式没有周级 DP，DP 快照沿用上一次可用的 W 快照（LOCF），并如实标注。

【产出】.cache/_fdc_sim/fdc-sim-data.json
  slices  —— 每个切片的累计出货 + 当时 DP 周桶（含起止日期/天数）
  daily   —— 10-18 ~「最后一个切片前一天」每个日历日：当日出货、跨天标记、当日可用 DP 快照、是否允许补货决策
  该文件不进 manifest、不进 git（原型阶段）；UI 阶段再决定静态文件名与部署方式。
"""
import subprocess, io, os, re, json, datetime, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, '.cache', '_fdc_sim')
OUT = os.path.join(OUT_DIR, 'fdc-sim-data.json')
WHS = ['天津', '惠州', '嘉兴', '武汉', '成都', '常州']
ACTIVE = ['天津', '惠州', '嘉兴']
SKU = '69001'
START = '2026-10-18'
# v486：END 不再写死。差分只能算到「最后一个切片日期 − 1 天」，
#   故在 main() 里按实际切片链动态推导；每次订单部署新增 git 切片会自动延长推演窗口。
JX_DP_FROM = '2026-11-06'   # 嘉兴首次有 DP 共识的切片日
SHIP_METRIC, PLAN_METRIC = '实际出货_数量', 'DP_共识数量'

DAY = datetime.timedelta(days=1)
def d(s): return datetime.date.fromisoformat(s)
def wh_short(v):
    return str(v).replace('山姆-', '').replace('FDC', '')


def git_slices():
    """按时间正序取 data.xlsx 的部署提交链；同日多提交取最后一个。"""
    log = subprocess.check_output(
        ['git', 'log', '--date=short', '--reverse', '--pretty=%H|%ad', '--', 'data.xlsx'],
        cwd=ROOT, text=True, encoding='utf-8').strip().split('\n')
    out = {}
    for line in log:
        sha, date = line.split('|')
        if date < '2026-10-01':
            continue
        try:
            blob = subprocess.check_output(['git', 'show', sha + ':data.xlsx'], cwd=ROOT)
        except subprocess.CalledProcessError:
            continue
        out[date] = (sha[:7], blob)
    return [(k, v[0], v[1]) for k, v in sorted(out.items())]


def parse_week_header(k):
    """'2026-10 W3 (1012~1018)' -> (label, start, end, days)"""
    m = re.match(r'(\d{4})-(\d{2}) (W[\w]+) \((\d{2})(\d{2})~(\d{2})(\d{2})\)$', k)
    if not m:
        return None
    y, mo, wlab, sm, sd, em, ed = m.groups()
    y, mo = int(y), int(mo)
    s = datetime.date(y, int(sm), int(sd))
    e = datetime.date(y, int(em), int(ed))
    if e < s:                      # 跨年周（本项目未出现，留防御）
        e = datetime.date(y + 1, int(em), int(ed))
    return {'label': k, 'week': wlab, 'start': s.isoformat(), 'end': e.isoformat(),
            'days': (e - s).days + 1}


def parse_slice(blob):
    """返回 (fmt, cumulativeShip, dpWeeks, dpUsable)；不合规返回 None。"""
    import openpyxl
    try:
        wb = openpyxl.load_workbook(io.BytesIO(blob), read_only=True, data_only=True)
    except Exception:
        return None
    if '山姆需求' not in wb.sheetnames:
        return None
    rows = list(wb['山姆需求'].iter_rows(values_only=True))
    if len(rows) < 7:
        return None
    hdr = rows[0]
    week_cols, month_cols = [], []
    for i, k in enumerate(hdr):
        if not isinstance(k, str) or i < 21:
            continue
        if parse_week_header(k) and re.match(r'2026-(10|11) ', k):
            week_cols.append((i, k))
        elif re.fullmatch(r'2026-(10|11)', k):
            month_cols.append((i, k))
    fmt = 'W' if week_cols else ('M' if month_cols else None)
    if not fmt:
        return None
    cols = week_cols if fmt == 'W' else month_cols

    cum, dpw = {}, {}
    for r in rows[1:]:
        if not r[7] or r[20] not in (SHIP_METRIC, PLAN_METRIC):
            continue
        w = wh_short(r[7])
        if w not in WHS:
            continue
        if r[20] == SHIP_METRIC:
            cum[w] = sum(r[i] for i, _ in cols
                         if i < len(r) and isinstance(r[i], (int, float)))
        elif fmt == 'W':
            arr = []
            for i, k in cols:
                meta = parse_week_header(k)
                v = r[i] if i < len(r) else None
                arr.append(dict(meta, dp=(v if isinstance(v, (int, float)) else None)))
            dpw[w] = arr
    if len(cum) != 6:
        return None
    dp_usable = {}
    for w in WHS:
        arr = dpw.get(w) or []
        dp_usable[w] = fmt == 'W' and any(
            x['dp'] is not None and x['dp'] > 0 for x in arr)
    return fmt, cum, dpw, dp_usable


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    raw = git_slices()
    slices = []
    for date, sha, blob in raw:
        p = parse_slice(blob)
        if not p:
            continue
        fmt, cum, dpw, usable = p
        slices.append({'date': date, 'sha': sha, 'fmt': fmt,
                       'cumulativeShip': cum, 'dpWeeks': dpw,
                       'dpUsable': usable})
    if not slices:
        raise SystemExit('没有可用切片')

    # v486：推演末日 = 最后一个可用切片的前一天（T 日出货需要 T+1 切片才能差分出来）。
    #   2026-11-13 的 fb40d86 切片此前被写死的 END=11-11 挡在窗口外，导致 11-12 出货缺失。
    END = (d(slices[-1]['date']) - DAY).isoformat()
    print('切片链末日 %s → 推演窗口 %s ~ %s' % (slices[-1]['date'], START, END))

    # ---- 差分事件：pair(a,b) 覆盖业务日 a .. b-1，整笔记在末日 b-1 ----
    events = []
    for a, b in zip(slices, slices[1:]):
        s, e = d(a['date']), d(b['date']) - DAY
        span = (e - s).days + 1
        qty = {w: b['cumulativeShip'][w] - a['cumulativeShip'][w] for w in WHS}
        events.append({'from': s.isoformat(), 'to': e.isoformat(), 'days': span,
                       'qty': qty, 'srcSlice': b['sha'], 'prevSlice': a['sha']})

    # ---- 逐日表：每个日历日一行；无事件日出库 0 ----
    by_end = {ev['to']: ev for ev in events}
    daily, cur = [], d(START)
    last_w = None                      # 最近一次「有周级 DP」的切片（LOCF）
    while cur <= d(END):
        day = cur.isoformat()
        ev = by_end.get(day)
        # 当日可得的 DP 快照 = 日期 <= 当日 的最后一个切片（不偷看未来）
        avail = [s for s in slices if s['date'] <= day]
        snap = avail[-1] if avail else None
        has_today = bool(snap and snap['date'] == day and snap['fmt'] == 'W')
        # M 格式没有周级 DP，或当日根本没有新切片 → 沿用上一次 W 快照（LOCF）
        if has_today:
            last_w = snap
        dp_ref = last_w
        # 该快照周桶覆盖到的最后一天：超过它做 30 天免租校验时会走「外推」，页面须标注
        fc_end = None
        if dp_ref:
            ends = [a['end'] for w in WHS for a in (dp_ref['dpWeeks'].get(w) or [])]
            if ends:
                fc_end = max(ends)
        daily.append({
            'date': day,
            'ship': {w: (ev['qty'][w] if ev else 0) for w in WHS},
            'shipIntervalDays': ev['days'] if ev else 0,
            'shipEventFrom': ev['from'] if ev else None,
            'shipSrcSlice': ev['srcSlice'] if ev else None,
            'dpSnapshotDate': dp_ref['date'] if dp_ref else None,
            'dpSnapshotSha': dp_ref['sha'] if dp_ref else None,
            'dpCarryForward': not has_today,          # 当日无新 W 切片 / M 格式 → 沿用
            'dpForecastEnd': fc_end,                  # 有 DP 计划的最后一天
            'dpUsable': {w: bool(dp_ref and dp_ref['dpUsable'].get(w)) for w in WHS},
            # 用户裁定：嘉兴 11-06 前不下补货决策
            'decisionAllowed': {w: (day >= JX_DP_FROM) if w == '嘉兴' else True for w in WHS},
        })
        cur += DAY

    # ---- 自检（写盘前） ----
    ver = {}
    ver['sliceCount'] = len(slices)
    ver['fmtCount'] = dict(collections.Counter(s['fmt'] for s in slices))
    ver['eventCount'] = len(events)
    ver['negativeDiff'] = sum(1 for e in events for w in WHS if e['qty'][w] < 0)
    ver['intervalDays'] = dict(collections.Counter(e['days'] for e in events))
    ver['dailyCount'] = len(daily)
    ver['dateRange'] = [daily[0]['date'], daily[-1]['date']]
    ver['shipTotal'] = {w: sum(x['ship'][w] for x in daily) for w in ACTIVE}
    ver['diffTotal'] = {w: sum(e['qty'][w] for e in events) for w in ACTIVE}
    ver['cumLast'] = {w: slices[-1]['cumulativeShip'][w] for w in ACTIVE}
    ver['cumFirst'] = {w: slices[0]['cumulativeShip'][w] for w in ACTIVE}
    ver['dpNoLookAhead'] = all(
        (not x['dpSnapshotDate']) or x['dpSnapshotDate'] <= x['date'] for x in daily)
    ver['jxDecisionBefore1106'] = sum(
        1 for x in daily if x['date'] < JX_DP_FROM and x['decisionAllowed']['嘉兴'])
    ver['nonZeroShipDays'] = sum(1 for x in daily if any(x['ship'][w] for w in ACTIVE))
    ver['dpCarryDays'] = sum(1 for x in daily if x['dpCarryForward'])
    ver['dpForecastEndRange'] = [
        min(x['dpForecastEnd'] for x in daily if x['dpForecastEnd']),
        max(x['dpForecastEnd'] for x in daily if x['dpForecastEnd'])]
    assert ver['negativeDiff'] == 0, '出现负差分：切片链/格式归一有问题'
    assert ver['dpNoLookAhead'], 'DP 快照出现前视'
    assert ver['jxDecisionBefore1106'] == 0, '嘉兴违规提前触发补货'
    for w in ACTIVE:
        assert ver['shipTotal'][w] == ver['diffTotal'][w], w + ' 逐日合计与差分不符'
        assert ver['diffTotal'][w] == ver['cumLast'][w] - ver['cumFirst'][w], w + ' 差分与累计不符'
    assert ver['dailyCount'] == (d(END) - d(START)).days + 1

    data = {
        # v486 幂等：不用构建时间（每次重跑都产生只改时间戳的假 diff，v484 已踩过），
        #   改为标明数据真正来自哪个 git 切片；页面文案同步改为「模拟数据基于」。
        'generatedAt': 'git 切片链末 %s（%s）' % (slices[-1]['date'], slices[-1]['sha']),
        'source': 'git data.xlsx 每日部署提交链（只用同一来源链，不混本地备份）',
        'sku': SKU, 'unit': '箱', 'warehouses': WHS, 'activeWarehouses': ACTIVE,
        'startMin': START, 'end': END,
        'rules': {
            'ship': 'T-1 出货 = 截止 T 日累计 − 截止 T-1 日累计；记业务日 T-1',
            'crossInterval': '跨天区间量整笔记在区间末日，不摊分',
            'dp': '补货决策用当日可得的最近一次切片 DP 快照（LOCF，零前视）',
            'jiaxing': '嘉兴 %s 之前无 DP 共识 → 不下补货决策，只消耗库存' % JX_DP_FROM,
            'openingStock': '用户给具体日期 + 当日库存（箱），从该日期开始推演',
        },
        'slices': slices, 'daily': daily,
        '_events': events, 'verification': ver,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    print('已写出', OUT, os.path.getsize(OUT), '字节')
    print(json.dumps(ver, ensure_ascii=False, indent=2))
    print('\n非零出货日样例：')
    for x in daily:
        if any(x['ship'][w] for w in ACTIVE):
            print(' ', x['date'], '跨%dt' % x['shipIntervalDays'],
                  [x['ship'][w] for w in ACTIVE],
                  'DP快照', x['dpSnapshotDate'],
                  '嘉兴可决策', x['decisionAllowed']['嘉兴'])


if __name__ == '__main__':
    main()
