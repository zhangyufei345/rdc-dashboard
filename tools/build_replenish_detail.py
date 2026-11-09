# -*- coding: utf-8 -*-
"""
补货记录统一构建器：2611补货记录.xlsx -> replenish-detail.json + adjustments.json

【用户 2026-11-09 裁定】从今天开始，**补货决策复盘** 和 **补货调整跟踪** 两个模块
都改用同一张源表《2611补货记录.xlsx》更新，不再分别维护两张表。

两个模块的分工（前端代码不变）：
  · 补货决策复盘 (renderReplenishReview)  ← replenish-detail.json：全量补货决策行（含未调整）
  · 补货调整跟踪 (renderAdjustTrack)        ← adjustments.json：仅「被调整过」的行（有调整类型）

用法：
  python tools/build_replenish_detail.py                  # 正式构建（两个 json 都写）
  python tools/build_replenish_detail.py --dry-run        # 只打印差异，不落盘
  python tools/build_replenish_detail.py --detail-only    # 只更新 replenish-detail.json
  python tools/build_replenish_detail.py "D:/其他/其他月份.xlsx"

口径（用户 2026-11-08 确认，2026-11-09 沿用）：
  - 应补量(planBox) / 调整后补货量(adjBox) / 大仓库存箱数(dcStockBox) 为箱
  - 其余数量字段为支（最小单位）
  - 表格中 #N/A 视为空
  - 尾部大量空行必须过滤（本文件 4100 行里只有 746 行有效）

合并策略（关键，勿改）：
  · replenish-detail.json：按 date|rdc|sku 去重，**新文件覆盖同键旧行**，历史月份保留。
  · adjustments.json：以「**调整类型非空**」的行为调整记录（与旧《RDC补货调整记录.xlsx》
    的构造规则一致——那份表 4150 条全部带类型）。
    - 新表覆盖到的补货日 → **以新表为准**（同键覆盖；新表没有的旧键**保留**，不擅自删历史）
    - 新表未覆盖的补货日 → 保留旧记录（历史积累，源头是已停用的旧表）
    - 覆盖时保留旧记录的 adjReason（新表没有「调整原因」列，历史 4 条手写原因不能丢）
"""
import sys, os, json, re, datetime, collections

try:
    import openpyxl
except ImportError:
    print("ERROR: 需要 openpyxl")
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DETAIL = os.path.join(ROOT, "replenish-detail.json")
OUT_ADJ = os.path.join(ROOT, "adjustments.json")
MANIFEST = os.path.join(ROOT, "manifest.json")

# 源表候选（按优先级）：S 盘工作记录为准，桌面副本兜底
SRC_CANDIDATES = [
    "S:/供应链/供应链计划部/03.创新/12.补货计划工作记录/2611补货记录.xlsx",
    os.path.expanduser(r"~\Desktop\2611补货记录.xlsx"),
]

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


def parse_source(src):
    wb = openpyxl.load_workbook(src, data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]
    raw = [list(r) for r in ws.iter_rows(values_only=True)]
    wb.close()
    if not raw:
        raise SystemExit("ERROR: 空表")

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
    return rows, body, blank, dup, na_cnt, bad_box, bad_num


def adj_key(date, rdc, sku):
    """adjustments.json 的键：rdc 不带 RDC 后缀（与旧《RDC补货调整记录.xlsx》一致）"""
    return "%s|%s|%s" % (date, str(rdc or "").replace("RDC", "").strip(), str(sku or "").strip())


def to_adj_record(r):
    return {
        "date": r["date"],
        "rdc": r["rdc"].replace("RDC", ""),
        "sku": r["sku"],
        "skuName": r.get("skuName") or "",
        "category": r.get("category") or "",
        "lifecycle": r.get("lifecycle") or "",
        "hainan": r.get("hainan") or "",
        "spuMissing": r.get("spuMissing") or "",
        "planQty": int(r["planBox"]) if r.get("planBox") is not None else 0,
        "adjQty": int(r["adjBox"]) if r.get("adjBox") is not None else 0,
        "dcStock": int(r["dcStockBox"]) if r.get("dcStockBox") is not None else 0,
        "adjType": (r.get("adjType") or "").strip(),
        "adjReason": "",
    }


def sha256_file(p):
    import hashlib
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    argv = sys.argv[1:]
    dry_run = "--dry-run" in argv
    detail_only = "--detail-only" in argv
    args = [a for a in argv if not a.startswith("--")]

    src = args[0] if args else next((p for p in SRC_CANDIDATES if os.path.exists(p)), None)
    if not src or not os.path.exists(src):
        print("ERROR: 未找到源表 2611补货记录.xlsx，候选：")
        for p in SRC_CANDIDATES:
            print("   ", p, "(存在)" if os.path.exists(p) else "(缺失)")
        sys.exit(2)

    rows, body, blank, dup, na_cnt, bad_box, bad_num = parse_source(src)
    print("源文件:", src)
    print("  大小 %d B / 修改时间 %s" % (
        os.path.getsize(src),
        datetime.datetime.fromtimestamp(os.path.getmtime(src)).strftime("%Y-%m-%d %H:%M:%S")))
    print("  原始行(含表头后) %d / 空行或无效 %d / 去重丢弃 %d / 有效 %d / #N/A 命中 %d"
          % (len(body), blank, dup, len(rows), na_cnt))

    # ---------- 1) replenish-detail.json（全量决策行）----------
    old_detail = []
    if os.path.exists(OUT_DETAIL):
        try:
            old_detail = json.load(open(OUT_DETAIL, encoding="utf-8")).get("rows") or []
        except Exception as e:
            print("WARN: 旧 replenish-detail.json 读取失败，忽略 ->", e)
    merged = {}
    for r in old_detail:
        merged["%s|%s|%s" % (r.get("date"), r.get("rdc"), r.get("sku"))] = r
    d_add = d_upd = 0
    for r in rows:
        k = "%s|%s|%s" % (r["date"], r["rdc"], r["sku"])
        if k in merged:
            d_upd += 1
        else:
            d_add += 1
        merged[k] = r
    detail_rows = sorted(merged.values(),
                         key=lambda r: (str(r.get("date")), str(r.get("rdc")), str(r.get("sku"))))
    months = sorted({str(r["date"])[:7] for r in detail_rows if r.get("date")})
    detail_payload = {
        "generatedAt": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "source": src,
        "count": len(detail_rows),
        "months": months,
        "columns": {key: col for col, key, _ in COLMAP},
        "boxFields": BOX_FIELDS,
        "pcsFields": PCS_FIELDS,
        "rows": detail_rows,
    }
    print("\n[复盘] replenish-detail.json: %d -> %d 行（新增 %d / 覆盖 %d）月份 %s"
          % (len(old_detail), len(detail_rows), d_add, d_upd, months))

    # ---------- 2) adjustments.json（被调整过的行）----------
    new_adj_rows = []
    for r in rows:
        t = (r.get("adjType") or "").strip()
        if not t or t == "0":
            continue
        new_adj_rows.append(to_adj_record(r))
    new_adj_by_key = {adj_key(r["date"], r["rdc"], r["sku"]): r for r in new_adj_rows}
    # 新表覆盖到的补货日（该日至少有 1 条带类型的行，才认为新表对该日有权威口径）
    new_days = collections.Counter(r["date"] for r in new_adj_rows)
    covered_days = {d for d, n in new_days.items() if n > 0}

    old_adj = []
    if os.path.exists(OUT_ADJ):
        try:
            old_adj = json.load(open(OUT_ADJ, encoding="utf-8")).get("adjust") or []
        except Exception as e:
            print("WARN: 旧 adjustments.json 读取失败，忽略 ->", e)
    old_by_key = {adj_key(r.get("date"), r.get("rdc"), r.get("sku")): r for r in old_adj}

    kept_hist = []       # 新表未覆盖的历史补货日 → 原样保留
    kept_stale = []      # 新表覆盖日里、旧表有但新表整行没有的键 → **保留**（不擅自删历史）
    overwritten = []     # 同键被新表覆盖
    for k, r in old_by_key.items():
        d = str(r.get("date") or "")
        if d in covered_days:
            if k in new_adj_by_key:
                overwritten.append((k, r, new_adj_by_key[k]))
            else:
                kept_stale.append((k, r))
        else:
            kept_hist.append(r)

    final_adj = list(kept_hist) + [r for _, r in kept_stale]
    for k, r in new_adj_by_key.items():
        prev = old_by_key.get(k)
        rec = dict(r)
        if prev and prev.get("adjReason"):
            rec["adjReason"] = prev["adjReason"]   # 新表无「调整原因」列，历史手写原因必须保留
        final_adj.append(rec)
    final_adj.sort(key=lambda r: (str(r.get("date")), str(r.get("rdc")), str(r.get("sku"))))

    type_changed = collections.Counter()
    for k, o, n in overwritten:
        if (o.get("adjType") or "").strip() != (n.get("adjType") or "").strip():
            type_changed["%s → %s" % (o.get("adjType") or "(空)", n.get("adjType") or "(空)")] += 1

    print("\n[跟踪] adjustments.json: %d -> %d 条" % (len(old_adj), len(final_adj)))
    print("  新表带类型行 %d 条，覆盖补货日 %s" % (len(new_adj_rows), sorted(covered_days)))
    print("  历史保留（不在新表覆盖范围）%d 条" % len(kept_hist))
    print("  同键被新表覆盖 %d 条，其中调整类型变更 %d 条" % (len(overwritten), sum(type_changed.values())))
    for k, v in type_changed.most_common():
        print("     %-28s %d" % (k, v))
    print("  新表未含、旧记录保留 %d 条（新表对应行整行不存在，非类型清空）：" % len(kept_stale))
    for k, r in kept_stale:
        print("     %s | %s | %s | 应补%s 实补%s | %s"
              % (r.get("date"), r.get("rdc"), r.get("sku"), r.get("planQty"), r.get("adjQty"), r.get("adjType")))
    adj_dates = collections.Counter(r["date"] for r in final_adj)
    print("  最终按日期:", dict(sorted(adj_dates.items())))
    print("  最终按类型:", dict(collections.Counter(r.get("adjType") or "(空)" for r in final_adj).most_common()))
    print("  最终按RDC:", dict(collections.Counter(r.get("rdc") for r in final_adj).most_common()))
    if bad_box:
        print("\n  箱规缺失 SKU:", len(bad_box), dict(list(bad_box.items())[:6]))
    if bad_num:
        print("  数值列非数字:", {k: v for k, v in bad_num.items()})

    if dry_run:
        print("\n--dry-run：未写任何文件")
        return

    # ---------- 落盘 ----------
    with open(OUT_DETAIL, "w", encoding="utf-8") as f:
        json.dump(detail_payload, f, ensure_ascii=False, separators=(",", ":"))
    print("\n已写:", OUT_DETAIL, os.path.getsize(OUT_DETAIL), "bytes")

    if not detail_only:
        adj_payload = {
            "generatedAt": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": src,
            "count": len(final_adj),
            "adjust": final_adj,
        }
        with open(OUT_ADJ, "w", encoding="utf-8") as f:
            json.dump(adj_payload, f, ensure_ascii=False, separators=(",", ":"))
        print("已写:", OUT_ADJ, os.path.getsize(OUT_ADJ), "bytes")

        # manifest 只翻 adjustments.json 一项 + generatedAt，其余文件哈希不动
        if os.path.exists(MANIFEST):
            manifest = json.load(open(MANIFEST, encoding="utf-8"))
            before = manifest["files"].get("adjustments.json", "(无)")
            manifest["files"]["adjustments.json"] = sha256_file(OUT_ADJ)
            manifest["generatedAt"] = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S") + "Z"
            with open(MANIFEST, "w", encoding="utf-8") as f:
                json.dump(manifest, f, ensure_ascii=False, indent=2)
            print("manifest: adjustments.json %s -> %s（其余 %d 项哈希未动）"
                  % (str(before)[:12], manifest["files"]["adjustments.json"][:12],
                     len(manifest["files"]) - 1))


if __name__ == "__main__":
    main()
