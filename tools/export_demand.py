# -*- coding: utf-8 -*-
"""
export_demand.py —— 从「订单部署」Excel 抽取「分仓需求」sheet → demand.json

用途
----
张宇飞把"分仓计划 / 实际出货"从庞大的库存分析模版挪到了更常更新的"订单部署"文件里。
本工具把这个文件的「分仓需求」sheet 抽成轻量 demand.json，看板启动即 fetch 它。

新表格式（2026-09 起）
----------------------
表头：产品 Code | 产品 Name | 计划仓 Name | 供应链品类 | 生命周期标签 | 计划指标 | 2026-09 | 2026-10 | 2026-11
同一个 SKU×仓有**两行**：
  · 计划指标 = 实际出货_数量  → 只在当月（2026-09）有数（这是"出货量"，已合并 已放行+未放行+大仓直发）
  · 计划指标 = DP_共识数量    → 当月+未来两月都有数（这是"计划/分仓计划"）

输出 demand.json 结构（键与看板现有 planBySkuRdc 完全一致：原始SKU编码 / RDC名 / 月份）
{
  "generatedAt": "2026-09-18 ...",
  "source": "<xlsx 文件名>",
    "plan":        { "09865": { "华北RDC": { "2026-09": 264, "2026-10": ..., "2026-11": ... } }, ... },
    "actualShip":  { "09865": { "华北RDC": { "2026-09": 264 } }, ... },
    "meta":        { "09865": { "name": "美加净...", "cat": "常规品", "life": "成熟期" }, ... }  # 每 SKU 的品名/供应链品类/生命周期（来自 分仓需求 表头列）
}

同时输出 demand-history.json（📌 2026-09-21 新增）
------------------------------------------------
源表「分仓需求」的「实际出货_数量」**本身就是当月累计（MTD）值**，用户每天更新一次。
但它每天覆盖同一个文件 → 日度 MTD 序列会永久丢失。故本脚本每次运行时，
把当日的「按 RDC 汇总的 MTD 实际出货」追加进 demand-history.json（**同日覆盖、跨月保留**），
逐步积累出真正的日度曲线，供分仓计划监控页的「MTD 累计完成率曲线」使用。

{
  "generatedAt": "2026-09-21 10:31:53",
  "note": "...",
  "months": { "2026-09": { "days": { "2026-09-18": {"东北RDC": 330524, ...}, "2026-09-21": {...} } } }
}
⚠️ 曲线数据不能回溯：本机制自 2026-09-21 起生效，此前只有 git 历史里的零星时点
   （已由 tools/backfill_demand_history.py 回填 9/18、9/20、9/21）。9/1~9/17 的 MTD 值无处可寻。

用法
----
  python tools/export_demand.py [<订单部署xlsx路径>] [<输出demand.json路径>]
默认输入：桌面 "9月RDC订单满足汇总.xlsx"
默认输出：脚本所在目录的父目录 demand.json（即项目根目录，与 rdc-dashboard.html 同目录）
"""
import sys, os, json, datetime
import openpyxl

DEFAULT_SRC = r"C:\Users\zhangyufei1\Desktop\9月RDC订单满足汇总.xlsx"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(SCRIPT_DIR, "..", "demand.json")

PLAN_METRIC = "DP_共识数量"      # 计划（分仓计划）
SHIP_METRIC = "实际出货_数量"     # 实际出货（出货量，已合并 已放行+未放行+大仓直发）

HISTORY_FILE = "demand-history.json"   # 每日 MTD 实际出货快照（与 demand.json 同目录）


def snapshot_by_rdc(actualShip, months):
    """把 actualShip({sku:{rdc:{month:qty}}}) 折成 {month: {rdc: 合计}}。"""
    agg = {}
    for m in months:
        d = {}
        for rdcs in actualShip.values():
            for r, md in rdcs.items():
                v = md.get(m)
                if v:
                    d[r] = d.get(r, 0.0) + float(v)
        if d:
            agg[m] = d
    return agg


def append_history(out_path, actualShip, months, day=None):
    """把当日 MTD 快照追加进 demand-history.json（同日覆盖、跨月保留）。返回 (路径, 内容)。"""
    hp = os.path.join(os.path.dirname(os.path.abspath(out_path)), HISTORY_FILE)
    hist = {}
    if os.path.exists(hp):
        try:
            with open(hp, encoding="utf-8") as f:
                hist = json.load(f)
        except Exception as e:
            print("   ⚠️ %s 解析失败(%s)，将重建" % (HISTORY_FILE, e))
            hist = {}
    if not isinstance(hist, dict):
        hist = {}
    hist.setdefault("months", {})
    d = (day or datetime.date.today()).isoformat()
    snap = snapshot_by_rdc(actualShip, months)
    for m, byrdc in snap.items():
        days = hist["months"].setdefault(m, {}).setdefault("days", {})
        days[d] = {k: round(v, 2) for k, v in sorted(byrdc.items())}
        hist["months"][m]["days"] = {k: days[k] for k in sorted(days)}
    hist["generatedAt"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    hist["note"] = ("每日 MTD 实际出货快照（源表「分仓需求」的实际出货_数量本身就是当月累计值）"
                    "按 RDC 汇总；同日覆盖、跨月保留。供分仓计划监控页「MTD 累计完成率曲线」使用。")
    with open(hp, "w", encoding="utf-8") as f:
        json.dump(hist, f, ensure_ascii=False, separators=(",", ":"))
    return hp, hist

def norm_sku(s):
    s = str(s).strip()
    return s  # 保留原始编码（含前导0），与 planBySkuRdc 原始键一致

# RDC 别名表：源表「计划仓 Name」出现的新叫法 → 看板 6 大 RDC 标准名。
# 看板全套口径（RDC_FULL / rdcOrder / normalizeRdcName / 各页 RDC 列）只认
# 「东北RDC/华北RDC/华南RDC/华中RDC/西北RDC/西南RDC」六个名；源表一旦换成别的写法，
# 键就会与查询侧对不上 → 该仓的计划不会被更新、实际出货**静默丢失**（不报错）。
# 2026-09-21 实测：订单部署文件「分仓需求」sheet 把「华南RDC」改成了「广东RDC」，
#   两版键集 2328/2328 完全一致、SKU 388/388 完全一致，其余 5 仓一字未变 → 判定为改名，
#   故在此归一化（前端零改动，不改 BUILD_VERSION/DB_VERSION，属数据管道适配）。
# ✅ 2026-09-21 用户裁决：「后续遇到广东RDC请默认为华南RDC」—— 故本别名表是**长期业务口径**，
#    不是临时适配。（同一口径在 batch-pull-calculator skill 里也有：「广东仓=华南仓」。）
#    🔴 不要再把「广东」当作可能新建的第 7 个仓来考虑；真有第 7 仓会由用户显式提出。
#    别名归一化后的标准名全集仍由 tools/verify-demand-merge.cjs 的 A5 门控把关。
RDC_ALIAS = {
    "广东RDC": "华南RDC",
    "广东": "华南RDC",
    "广东仓": "华南RDC",
}
_ALIAS_HIT = {}


def norm_rdc(s):
    s = str(s).strip()
    if s.endswith("仓"):
        s = s[:-1] + "RDC"
    if s in RDC_ALIAS:
        t = RDC_ALIAS[s]
        _ALIAS_HIT[s] = _ALIAS_HIT.get(s, 0) + 1
        return t
    return s

def merge_archived_months(plan, actualShip, out_path):
    """把归档 data-YYYY-MM.json 里「分仓需求」sheet 的**该月列**补进 plan / actualShip。

    背景（2026-11-04，用户实测截图）：源表「分仓需求」的实际出货_数量是**当月 MTD**，
      用户每天覆盖同一个文件、每月切换时上月值随文件被替换 → demand.json 天生只带当月。
      但归档的 data-YYYY-MM.json 保留了该月工作簿的**完整「分仓需求」sheet**
      （该 sheet 2026-09 才引入，故 2026-01~08 的归档里没有，属真·不可得）。
    不补这段的后果：用户在看板把缺货四象限切到历史月时，销售进度分子取不到实际出货
      → 被静默当成 0 → 显示「完成率 0% / 销售进度落后」→ 归因分析把绝大多数组合误判成
      「D 需重点排查」（10 月 36 条里 28 条被误判）。
    规则：
      · 只取该归档文件**自己那个月**（文件名 YYYY-MM）的列，不碰它带的未来月（那些当月源更新）；
      · 当月源已覆盖的月份**不覆盖**（用户更新的永远优先）；
      · 键归一化与主流程完全一致（norm_sku 保留原始编码、norm_rdc 走 RDC_ALIAS）。
    返回 (补入的 {月份: [计划键数, 出货键数]}, 跳过说明列表)
    """
    import re as _re
    root = os.path.dirname(os.path.abspath(out_path))
    done, skipped = {}, []
    if not os.path.isdir(root):
        return done, skipped
    for fn in sorted(os.listdir(root)):
        m = _re.match(r"^data-(\d{4}-\d{2})\.json$", fn)
        if not m:
            continue
        ym = m.group(1)
        # 当月源已带该月 → 不覆盖
        cur_plan_hit = any(ym in md for rdcs in plan.values() for md in rdcs.values())
        cur_ship_hit = any(ym in md for rdcs in actualShip.values() for md in rdcs.values())
        if cur_ship_hit:
            skipped.append("%s(当月源已含)" % ym)
            continue
        try:
            with open(os.path.join(root, fn), "r", encoding="utf-8") as fh:
                arc = json.load(fh)
        except Exception as e:
            skipped.append("%s(读取失败:%s)" % (ym, e))
            continue
        sheets = arc.get("sheets") or {}
        rows = sheets.get("分仓需求")
        if not rows or len(rows) < 2:
            skipped.append("%s(无分仓需求sheet)" % ym)
            continue
        hdr = rows[0] or []
        hi = {}
        for i, h in enumerate(hdr):
            if h is not None:
                hi[str(h).strip()] = i
        if "产品 Code" not in hi or "计划仓 Name" not in hi or "计划指标" not in hi or ym not in hi:
            skipped.append("%s(表头不符/无该月列)" % ym)
            continue
        ci, ri, mi, yi = hi["产品 Code"], hi["计划仓 Name"], hi["计划指标"], hi[ym]
        namei, cati, lifei = hi.get("产品 Name"), hi.get("供应链品类"), hi.get("生命周期标签")
        np_, ns_ = 0, 0
        for r in rows[1:]:
            if not r or r[ci] is None:
                continue
            code = norm_sku(r[ci])
            rdc = norm_rdc(r[ri])
            if not code or not rdc:
                continue
            met = str(r[mi]).strip() if r[mi] is not None else ""
            v = r[yi] if yi < len(r) else None
            if v is None or v == "":
                continue
            try:
                fv = float(v)
            except (ValueError, TypeError):
                continue
            if met == PLAN_METRIC:
                plan.setdefault(code, {}).setdefault(rdc, {})[ym] = fv
                np_ += 1
            elif met == SHIP_METRIC:
                actualShip.setdefault(code, {}).setdefault(rdc, {})[ym] = fv
                ns_ += 1
        if np_ or ns_:
            done[ym] = [np_, ns_]
        else:
            skipped.append("%s(该月列为空)" % ym)
    return done, skipped


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    out = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    if not os.path.exists(src):
        print("❌ 源文件不存在:", src)
        sys.exit(1)
    wb = openpyxl.load_workbook(src, data_only=True, read_only=True)
    if "分仓需求" not in wb.sheetnames:
        print("❌ 工作簿缺少「分仓需求」sheet，现有:", wb.sheetnames)
        sys.exit(1)
    ws = wb["分仓需求"]
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        print("❌ 分仓需求 为空")
        sys.exit(1)
    hdr = rows[0]
    idx = {str(h).strip(): i for i, h in enumerate(hdr) if h is not None}
    need = ["产品 Code", "产品 Name", "计划仓 Name", "供应链品类", "生命周期标签", "计划指标"]
    month_cols = [str(h).strip() for h in hdr if h is not None and __import__("re").match(r"^\d{4}-\d{2}$", str(h).strip())]
    for c in need:
        if c not in idx:
            print("❌ 缺列:", c, "表头=", list(idx.keys()))
            sys.exit(1)
    ci, ni, ri, cati, lifei, mi = idx["产品 Code"], idx["产品 Name"], idx["计划仓 Name"], idx["供应链品类"], idx["生命周期标签"], idx["计划指标"]
    mc = {m: idx[m] for m in month_cols}

    plan = {}
    actualShip = {}
    meta = {}          # sku -> {name, cat, life}（每 SKU 维度，与 DP_共识数量 同维度，整列一致）
    plan_rows = 0
    ship_rows = 0
    for r in rows[1:]:
        if r[ci] is None:
            continue
        code = norm_sku(r[ci])
        rdc = norm_rdc(r[ri])
        metric = str(r[mi]).strip()
        if not code or not rdc:
            continue
        # 每 SKU 捕获一次主数据（品名/供应链品类/生命周期），优先取首个非空行
        if code not in meta:
            meta[code] = {
                "name": str(r[ni]).strip() if r[ni] is not None else "",
                "cat": str(r[cati]).strip() if r[cati] is not None else "",
                "life": str(r[lifei]).strip() if r[lifei] is not None else "",
            }
        if metric == PLAN_METRIC:
            plan_rows += 1
            d = plan.setdefault(code, {}).setdefault(rdc, {})
            for m, col in mc.items():
                v = r[col]
                if v is None or v == "":
                    continue
                try:
                    d[m] = float(v)
                except (ValueError, TypeError):
                    pass
        elif metric == SHIP_METRIC:
            ship_rows += 1
            d = actualShip.setdefault(code, {}).setdefault(rdc, {})
            for m, col in mc.items():
                v = r[col]
                if v is None or v == "":
                    continue
                try:
                    d[m] = float(v)
                except (ValueError, TypeError):
                    pass

    # 收敛 plan 中"全月为空"的脏条目（actualShip 全空 → 该 SKU×仓回退 3-sum）
    plan = {s: {r: v for r, v in rdcs.items() if v} for s, rdcs in plan.items()}
    plan = {s: v for s, v in plan.items() if v}
    actualShip = {s: {r: v for r, v in rdcs.items() if v} for s, rdcs in actualShip.items()}
    actualShip = {s: v for s, v in actualShip.items() if v}

    # v452: 补历史月（归档 data-YYYY-MM.json 的「分仓需求」sheet）—— 见 merge_archived_months 注释
    #   ⚠️ 必须先把「源文件自带的月份」记下来 —— demand-history.json 的 MTD 快照只能按**当月**记录，
    #   若把补进来的历史月也传进去，会把 9 月/10 月的全月合计写到今天（2026-11-04）这条日度点上，
    #   把曲线污染成「11-04 突然多了 838 万支」。
    _srcShipMonths = sorted({m for rdcs in actualShip.values() for md in rdcs.values() for m in md.keys()})
    _arc_done, _arc_skip = merge_archived_months(plan, actualShip, out)
    plan = {s: {r: v for r, v in rdcs.items() if v} for s, rdcs in plan.items()}
    plan = {s: v for s, v in plan.items() if v}
    actualShip = {s: {r: v for r, v in rdcs.items() if v} for s, rdcs in actualShip.items()}
    actualShip = {s: v for s, v in actualShip.items() if v}

    shipMonths = sorted({m for rdcs in actualShip.values() for md in rdcs.values() for m in md.keys()})
    allPlanMonths = sorted({m for rdcs in plan.values() for md in rdcs.values() for m in md.keys()})

    out_obj = {
        "generatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": os.path.basename(src),
        "planMonths": month_cols,
        "allPlanMonths": allPlanMonths,
        "shipMonths": shipMonths,
        "plan": plan,
        "actualShip": actualShip,
        "meta": meta,
    }
    out_dir = os.path.dirname(os.path.abspath(out))
    if not os.path.exists(out_dir):
        os.makedirs(out_dir)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(out_obj, f, ensure_ascii=False, separators=(",", ":"))
    sz = os.path.getsize(out)
    print("✅ 已生成 demand.json（%d 字节）" % sz)
    print("   计划(DC共识): %d SKU / %d SKU×仓 × 月份%s" % (len(plan), sum(len(v) for v in plan.values()), month_cols))
    print("   实际出货:     %d SKU / %d SKU×仓 × 月份%s" % (len(actualShip), sum(len(v) for v in actualShip.values()), out_obj["shipMonths"]))
    if _arc_done:
        print("   ↳ v452 补入历史月（归档分仓需求）：%s"
              % ", ".join("%s[计划%d键/出货%d键]" % (k, v[0], v[1]) for k, v in sorted(_arc_done.items())))
    if _arc_skip:
        print("   ↳ 历史月跳过：%s" % ", ".join(_arc_skip))
    # 输出各 RDC 的键数与合计，便于一眼发现「某仓整列消失」（键对不上时的典型症状）
    for label, obj in (("计划", plan), ("实际出货", actualShip)):
        agg = {}
        for rdcs in obj.values():
            for r, md in rdcs.items():
                a = agg.setdefault(r, [0, 0.0])
                a[0] += 1
                a[1] += sum(md.values())
        print("   [%s] %s" % (label, ", ".join("%s:%d键/%.0f" % (k, v[0], v[1]) for k, v in sorted(agg.items()))))
    if _ALIAS_HIT:
        print("   ⚠️ RDC 别名归一化命中: %s → %s（共 %d 行）"
              % (dict(_ALIAS_HIT), " / ".join(sorted(set(RDC_ALIAS.values()))), sum(_ALIAS_HIT.values())))
        print("      ↑ 源表「计划仓 Name」用了新叫法，已按 RDC_ALIAS 映射到看板标准名（广东RDC=华南RDC 已确认为业务口径）。")
    else:
        print("   ✓ RDC 名全部为看板标准名（无别名命中）")
    # 自守卫：归一化之后仍出现未登记的 RDC 名 = 该仓数据在页面上永远查不到 → 必须大声报错
    STD_RDC = ("东北RDC", "华北RDC", "华南RDC", "华中RDC", "西北RDC", "西南RDC")
    stray = sorted({r for obj in (plan, actualShip) for rdcs in obj.values() for r in rdcs} - set(STD_RDC))
    missing = [r for r in STD_RDC if r not in {r for obj in (plan, actualShip) for rdcs in obj.values() for r in rdcs}]
    if stray or missing:
        print("   🔴 未登记的 RDC 名: %s ；缺失的标准 RDC: %s" % (stray or "无", missing or "无"))
        print("      ↑ 键与看板口径对不上 → 该仓计划/实际出货不会被更新（且不报错）。"
              "请确认是「改名」还是「新建仓」：改名 → 加进 RDC_ALIAS；新建仓 → 需改前端 RDC_FULL。")
    else:
        print("   ✓ 6 大标准 RDC 齐全，无未登记名")

    # ===== 每日 MTD 快照（demand-history.json）=====
    #   「实际出货」本身是当月累计值，源文件每天覆盖 → 不主动留痕就永远画不出日度曲线。
    #   v452: 只传**源文件自带**的月份（_srcShipMonths），不能传补进来的历史月，否则污染日度曲线。
    hp, hist = append_history(out, actualShip, _srcShipMonths)
    _d = datetime.date.today().isoformat()
    _pts = ", ".join("%s:%d天" % (m, len(v.get("days", {}))) for m, v in sorted(hist["months"].items()))
    print("✅ 已更新 %s（快照日 %s；累计数据点 %s）" % (HISTORY_FILE, _d, _pts))
    for m, v in sorted(hist["months"].items()):
        _last = sorted(v.get("days", {}))
        if _last:
            _row = v["days"][_last[-1]]
            print("   [%s] 最新 %s 合计 %.0f 支 ｜ %s" % (
                m, _last[-1], sum(_row.values()),
                ", ".join("%s=%.0f" % (k, x) for k, x in sorted(_row.items()))))

if __name__ == "__main__":
    main()
