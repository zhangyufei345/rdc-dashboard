# -*- coding: utf-8 -*-
"""backfill_demand_history.py —— 从 git 历史回填 demand-history.json 的 MTD 快照点

背景
----
源表「分仓需求」的「实际出货_数量」**本身就是当月累计（MTD）值**，用户每天更新一次，
但每天覆盖同一个文件名 → 日度 MTD 序列平时不落盘、会永久丢失。
2026-09-21 起由 tools/export_demand.py 每次运行自动追加当日快照；
**此前的时点只能从 git 历史里挖**（demand.json 的历任版本）。

用途
----
把 git 中 demand.json 的每一个历史版本的「按 RDC 汇总 MTD 实际出货」补进 demand-history.json，
快照日取该 commit 的作者日期。可重复运行（同日覆盖），不会破坏已有数据。

用法
----
  python tools/backfill_demand_history.py [<demand-history.json 路径>]
"""
import sys, os, json, subprocess, datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
DEFAULT_HISTORY = os.path.join(ROOT, "demand-history.json")


def git(args):
    p = subprocess.run(["git"] + args, capture_output=True, cwd=ROOT)
    if p.returncode != 0:
        raise RuntimeError("git %s 失败: %s" % (" ".join(args), p.stderr.decode("utf-8", "replace")[:200]))
    return p.stdout.decode("utf-8", "replace")


def snapshot_by_rdc(actual_ship):
    """{sku:{rdc:{month:qty}}} → {month: {rdc: 合计}}"""
    agg = {}
    for rdcs in actual_ship.values():
        for r, md in rdcs.items():
            for m, v in md.items():
                if v:
                    agg.setdefault(m, {})
                    agg[m][r] = agg[m].get(r, 0.0) + float(v)
    return agg


def main():
    hp = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_HISTORY
    # 1) 取 demand.json 的历任 commit（新→旧）
    log = git(["log", "--format=%H|%ad", "--date=format:%Y-%m-%d", "--", "demand.json"])
    revs = [l.split("|") for l in log.strip().split("\n") if "|" in l]
    if not revs:
        print("❌ git 历史里没有 demand.json")
        sys.exit(1)
    hist = {}
    if os.path.exists(hp):
        try:
            with open(hp, encoding="utf-8") as f:
                hist = json.load(f)
        except Exception:
            hist = {}
    hist.setdefault("months", {})
    added, skipped = [], []
    # 2) 旧→新遍历，保证同日多次提交时后者覆盖前者（与真实时间顺序一致）
    for rev, d in reversed(revs):
        raw = git(["show", "%s:demand.json" % rev])
        try:
            obj = json.loads(raw)
        except Exception as e:
            skipped.append("%s 解析失败(%s)" % (rev[:7], e))
            continue
        snap = snapshot_by_rdc(obj.get("actualShip", {}))
        if not snap:
            skipped.append("%s 无实际出货数据" % rev[:7])
            continue
        for m, byrdc in snap.items():
            days = hist["months"].setdefault(m, {}).setdefault("days", {})
            if d in days:
                skipped.append("%s %s 已存在(保留现值)" % (rev[:7], d))
                continue
            days[d] = {k: round(v, 2) for k, v in sorted(byrdc.items())}
            added.append("%s %s 合计%.0f" % (rev[:7], d, sum(byrdc.values())))
    # 3) 排序 + 落盘
    for m in hist["months"]:
        days = hist["months"][m].get("days", {})
        hist["months"][m]["days"] = {k: days[k] for k in sorted(days)}
    hist.setdefault("note", ("每日 MTD 实际出货快照（源表「分仓需求」的实际出货_数量本身就是当月累计值）"
                             "按 RDC 汇总；同日覆盖、跨月保留。供分仓计划监控页「MTD 累计完成率曲线」使用。"))
    hist["backfilledAt"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(hp, "w", encoding="utf-8") as f:
        json.dump(hist, f, ensure_ascii=False, separators=(",", ":"))
    print("✅ 已回填 %s" % os.path.relpath(hp, ROOT))
    for a in added:
        print("   + %s" % a)
    for s in skipped:
        print("   - 跳过: %s" % s)
    for m, v in sorted(hist["months"].items()):
        ds = sorted(v.get("days", {}))
        print("   [%s] %d 个数据点: %s" % (m, len(ds), ", ".join(ds)))


if __name__ == "__main__":
    main()
