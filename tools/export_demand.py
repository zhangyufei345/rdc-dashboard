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
    shipMonths = sorted({m for rdcs in actualShip.values() for md in rdcs.values() for m in md.keys()})

    out_obj = {
        "generatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": os.path.basename(src),
        "planMonths": month_cols,
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

if __name__ == "__main__":
    main()
