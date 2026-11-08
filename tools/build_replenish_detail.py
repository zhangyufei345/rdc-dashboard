# -*- coding: utf-8 -*-
"""
补货记录解析器：2611补货记录.xlsx -> replenish-detail.json

用法：
  python tools/build_replenish_detail.py                      # 默认读 桌面/2611补货记录.xlsx
  python tools/build_replenish_detail.py "D:/xxx/其他月份.xlsx"
  python tools/build_replenish_detail.py --emit-adjust        # 额外输出 adjustments 兼容子集（默认不写）

口径（用户 2026-11-08 确认）：
  - 应补量(planBox) / 调整后补货量(adjBox) / 大仓库存箱数(dcStockBox) 为箱
  - 其余数量字段为支（最小单位）
  - 表格中 #N/A 视为空
  - 尾部大量空行必须过滤（本文件 4099 行里只有 368 行有效）
合并策略：按 date|rdc|sku 去重，新文件覆盖同键旧行，历史月份保留。
"""
import sys, os, json, re, datetime, collections

try:
    import openpyxl
except ImportError:
    print("ERROR: 需要 openpyxl")
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "replenish-detail.json")
DEFAULT_SRC = os.path.expanduser(r"~\Desktop\2611补货记录.xlsx")

# xlsx 列名 -> 内部字段名（顺序与表头一致）
COLMAP = [
    ("补货日期", "date", "date"),
    ("RDC", "rdc", "text"),
    ("SKU编码", "sku", "text"),
    ("SKU名称", "skuName", "text"),
    ("供应链品类", "category", "text"),
    ("生命周期", "lifecycle", "text"),
    ("箱规", "boxSpec", "int"),
    ("海南花露水", "hainan", "text"),
    ("SPU缺失&不补货产品", "spuMissing", "text"),
    ("应补量", "planBox", "num"),
    ("调整后补货量", "adjBox", "num"),
    ("安全库存", "safetyStock", "num"),
    ("目标库存", "targetStock", "num"),
    ("期初库存", "openStock", "num"),
    ("未清订单", "openOrder", "num"),
    ("在途库存", "inTransit", "num"),
    ("周期库存", "cycleStock", "num"),
    ("当日订单", "dayOrder", "num"),
    ("经销商需求", "dealerDemand", "num"),
    ("京喜通需求", "jxtDemand", "num"),
    ("KA需求", "kaDemand", "num"),
    ("大仓库存箱数", "dcStockBox", "num"),
    ("大仓占比", "dcRatio", "num"),
    ("补货后大仓占比", "dcRatioAfter", "num"),
    ("低销预警", "lowSellWarn", "text"),
    ("补货后覆盖天数", "coverDays", "num"),
    ("调整类型", "adjType", "text"),
]
BOX_FIELDS = ["planBox", "adjBox", "dcStockBox"]
PCS_FIELDS = ["safetyStock", "targetStock", "openStock", "openOrder", "inTransit",
              "cycleStock", "dayOrder", "dealerDemand", "jxtDemand", "kaDemand"]
NA_TOKENS = {"#N/A", "#N/A N/A", "#NA", "N/A", "#REF!", "#VALUE!", "#DIV/0!"}


def norm_rdc(x):
    s = str(x or "").strip()
    if not s:
        return ""
    base = s.replace("RDC", "").replace("仓", "").strip()
    base = {"广东": "华南"}.get(base, base)
    return base + "RDC" if base else ""


def to_date(v):
    if isinstance(v, datetime.datetime):
        return v.date()
    if isinstance(v, datetime.date):
        return v
    if isinstance(v, (int, float)) and 40000 < v < 60000:
        return datetime.date(1899, 12, 30) + datetime.timedelta(days=int(v))
    s = str(v or "").strip()
    m = re.match(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", s)
    if m:
        return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


def clean_num(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s or s in NA_TOKENS or s.startswith("#"):
        return None
    s = s.replace(",", "").replace("，", "")
    try:
        return float(s)
    except ValueError:
        return None


def clean_int(v):
    f = clean_num(v)
    return None if f is None else int(round(f))


def clean_text(v):
    if v is None:
        return None
    s = str(v).strip()
    if not s or s in NA_TOKENS or s.startswith("#"):
        return None
    return s


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    emit_adjust = "--emit-adjust" in sys.argv
    src = args[0] if args else DEFAULT_SRC
    if not os.path.exists(src):
        print("ERROR: 文件不存在 ->", src)
        sys.exit(2)

    wb = openpyxl.load_workbook(src, data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]
    raw = [list(r) for r in ws.iter_rows(values_only=True)]
    if not raw:
        print("ERROR: 空表")
        sys.exit(3)

    header = [str(h).strip() if h is not None else "" for h in raw[0]]
    hidx = {h: i for i, h in enumerate(header)}
    missing = [c for c, _, _ in COLMAP if c not in hidx]
    if missing:
        print("ERROR: 缺少列 ->", missing)
        print("实际表头:", header)
        sys.exit(4)

    body = raw[1:]
    blank = 0
    na_cnt = 0
    rows = []
    bad_box = collections.Counter()
    bad_num = collections.Counter()
    dup = 0
    seen = {}
    for r in body:
        if sum(1 for c in r if c not in (None, "")) < 2:
            blank += 1
            continue
        rec = {}
        for col, key, kind in COLMAP:
            v = r[hidx[col]] if hidx[col] < len(r) else None
            if isinstance(v, str) and v.strip() in NA_TOKENS:
                na_cnt += 1
                v = None
            if kind == "date":
                d = to_date(v)
                rec[key] = d.strftime("%Y-%m-%d") if d else None
            elif kind == "int":
                rec[key] = clean_int(v)
            elif kind == "num":
                rec[key] = clean_num(v)
                if rec[key] is None and v not in (None, "") and str(v).strip() not in NA_TOKENS:
                    bad_num[key] += 1
            else:
                rec[key] = clean_text(v)
        rec["rdc"] = norm_rdc(rec.get("rdc"))
        rec["sku"] = (rec.get("sku") or "").strip()
        if not rec["date"] or not rec["rdc"] or not rec["sku"]:
            blank += 1
            continue
        if not rec["boxSpec"] or rec["boxSpec"] <= 0:
            bad_box[rec["sku"]] += 1
            rec["boxSpec"] = None
        k = rec["date"] + "|" + rec["rdc"] + "|" + rec["sku"]
        if k in seen:
            dup += 1
        seen[k] = rec
    rows = list(seen.values())

    # merge 历史
    old_rows = []
    if os.path.exists(OUT):
        try:
            old = json.load(open(OUT, encoding="utf-8"))
            old_rows = old.get("rows") or []
        except Exception as e:
            print("WARN: 旧 json 读取失败，忽略 ->", e)
    merged = {}
    for r in old_rows:
        k = str(r.get("date")) + "|" + str(r.get("rdc")) + "|" + str(r.get("sku"))
        merged[k] = r
    added = updated = 0
    for r in rows:
        k = r["date"] + "|" + r["rdc"] + "|" + r["sku"]
        if k in merged:
            updated += 1
        else:
            added += 1
        merged[k] = r
    all_rows = sorted(merged.values(), key=lambda r: (str(r.get("date")), str(r.get("rdc")), str(r.get("sku"))))
    months = sorted({str(r["date"])[:7] for r in all_rows if r.get("date")})

    out = {
        "generatedAt": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "source": src,
        "count": len(all_rows),
        "months": months,
        "columns": {key: col for col, key, _ in COLMAP},
        "boxFields": BOX_FIELDS,
        "pcsFields": PCS_FIELDS,
        "rows": all_rows,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    print("源文件:", src)
    print("原始行(含表头后):", len(body), " 空行/无效:", blank, " 去重丢弃:", dup)
    print("本次解析有效:", len(rows), " 新增:", added, " 覆盖:", updated, " 合并后总计:", len(all_rows))
    print("月份:", months)
    print("RDC:", dict(collections.Counter(r["rdc"] for r in all_rows if r["date"][:7] == months[-1])))
    print("#N/A 命中:", na_cnt)
    print("箱规缺失 SKU:", len(bad_box), dict(list(bad_box.items())[:6]))
    if bad_num:
        print("数值列非数字:", {k: v for k, v in bad_num.items()})
    print("输出:", OUT, os.path.getsize(OUT), "bytes")

    if emit_adjust:
        adj = []
        for r in all_rows:
            adj.append({
                "date": r["date"], "rdc": r["rdc"].replace("RDC", ""), "sku": r["sku"],
                "skuName": r.get("skuName") or "", "category": r.get("category") or "",
                "lifecycle": r.get("lifecycle") or "", "hainan": r.get("hainan") or "",
                "spuMissing": r.get("spuMissing") or "",
                "planQty": int(r["planBox"]) if r.get("planBox") is not None else 0,
                "adjQty": int(r["adjBox"]) if r.get("adjBox") is not None else 0,
                "dcStock": int(r["dcStockBox"]) if r.get("dcStockBox") is not None else 0,
                "adjType": r.get("adjType") or "", "adjReason": "",
            })
        p = os.path.join(ROOT, "adjustments.from-replenish.json")
        json.dump({"generatedAt": out["generatedAt"], "source": src, "count": len(adj), "adjust": adj},
                  open(p, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        print("已额外输出(不覆盖线上):", p, len(adj), "行")


if __name__ == "__main__":
    main()
