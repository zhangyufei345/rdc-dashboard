# -*- coding: utf-8 -*-
"""生成 dp-history.json —— 「分仓需求」sheet 的 DP_共识数量 逐次部署切片。

为什么需要它（v453）：
  页面运行态只有 DP 的**期末值**（demand.json 的 plan），没有任何逐日切片。
  而「计划员在月中/月末把计划往上调」会让归因从「超销」翻成「滞后 D」——用户在
  2026-11-04 观察到 40057·华北 就是这类假 D（10 月中计划 2,000 出货 9,576=478%，
  10-27 计划被改成 13,000 → 73.7% → 归因变 D「需重点排查」，行动方向完全相反）。

数据来源：
  git 历史里 data.json 的每次提交 = 当天部署时「分仓需求」sheet 的原值
  （当月文件就是 data.json，跨月后才归档成 data-YYYY-MM.json）。
  所以 `git log -- data.json` 就是用户说的「每天的需求调整切片」。

输出（紧凑，只存变化点）：
  { "generatedAt": "...",
    "months": {
      "2026-10": {
        "40057|华北RDC": { "revs": [["2026-10-10",3000],["2026-10-12",2000],
                                     ["2026-10-19",3500],["2026-10-27",13000]],
                           "fs": "2026-10-16" }   // fs = 首次缺货日（排除双休）
      } } }
  key = normSkuCode(sku) + '|' + normalizeRdcName(rdc)  ← 与 buildPlanSkuAgg 完全一致

用法： python tools/build_dp_history.py
"""
import json
import os
import subprocess
import sys
import datetime
from collections import defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, 'dp-history.json')

RDC_ALIAS = {
    '广东RDC': '华南RDC', '广东仓': '华南RDC', '广东': '华南RDC',
    '华南仓': '华南RDC', '华北仓': '华北RDC', '东北仓': '东北RDC',
    '西北仓': '西北RDC', '华中仓': '华中RDC', '西南仓': '西南RDC',
}


def norm_rdc(s):
    s = '' if s is None else str(s).strip()
    if s.endswith('仓') and s not in RDC_ALIAS:
        s = s[:-1]
        s = RDC_ALIAS.get(s + '仓', s + 'RDC' if s else s)
    return RDC_ALIAS.get(s, s)


def norm_sku(s):
    s = '' if s is None else str(s).strip()
    if not s:
        return ''
    return str(int(s)) if s.isdigit() else s


def git_show(sha, path):
    p = subprocess.run(['git', 'show', '%s:%s' % (sha, path)], cwd=REPO,
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return p.stdout if p.returncode == 0 else None


def list_commits():
    out = subprocess.run(['git', 'log', '--format=%h|%ad', '--date=short', '--', 'data.json'],
                         cwd=REPO, stdout=subprocess.PIPE).stdout.decode('utf-8')
    rows = []
    for ln in out.strip().splitlines():
        if '|' not in ln:
            continue
        sha, d = ln.split('|', 1)
        rows.append((sha.strip(), d.strip()))
    rows.reverse()          # 从旧到新
    return rows


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


def first_short_map(month):
    """该月「首次缺货日」：weekday only（项目红线：缺货排除双休日），首日缺货量>0。"""
    for name in ('data-%s.json' % month, 'data.json'):
        f = os.path.join(REPO, name)
        if not os.path.exists(f):
            continue
        d = json.load(open(f, encoding='utf-8'))
        od = (d.get('sheets') or {}).get('订单明细')
        if not od:
            continue
        hdr = [str(h) for h in od[0]]
        try:
            ci = {h: i for i, h in enumerate(hdr)}
            c_date, c_sku, c_wh, c_short = ci['SAP放行日期'], ci['SKU编码'], ci['仓库名称'], ci['首日缺货量']
        except KeyError:
            continue
        m = {}
        for r in od[1:]:
            if r is None or len(r) <= max(c_date, c_sku, c_wh, c_short):
                continue
            dt = xl_date(r[c_date])
            if not dt or not dt.startswith(month):
                continue
            if datetime.date.fromisoformat(dt).weekday() >= 5:
                continue
            s = r[c_short] if isinstance(r[c_short], (int, float)) else 0
            if not s or s <= 0:
                continue
            k = norm_sku(r[c_sku]) + '|' + norm_rdc(r[c_wh])
            if k not in m or dt < m[k]:
                m[k] = dt
        if m:
            return m, name
    return {}, None


def _read_csv_style_sheet(day_label, sheets):
    """从 data.json 的「分仓需求」里取 (月份列列表, {month: {key: dp}})。"""
    fd = (sheets or {}).get('分仓需求')
    if not fd or not fd[0]:
        return [], {}
    hdr = fd[0]
    mcols = [(i, str(h)) for i, h in enumerate(hdr)
             if h is not None and len(str(h)) == 7 and str(h)[4] == '-']
    res = {}
    for r in fd[1:]:
        if r is None or len(r) < 6 or str(r[5]) != 'DP_共识数量':
            continue
        key = norm_sku(r[0]) + '|' + norm_rdc(r[2])
        for ci, mo in mcols:
            v = r[ci] if ci < len(r) else None
            if not isinstance(v, (int, float)):
                continue
            res.setdefault(mo, {})[key] = float(v)
    return [m for _, m in mcols], res


def append_today():
    """增量模式：把当前 data.json「分仓需求」的 DP 追加为今天的变化点，并刷新当月首次缺货日。

    用途：全量回填只能读到已提交的 git 历史；日常部署后跑一次本模式，
          当月的 DP 变动与首次缺货日就能持续累积（否则 E 判定要等月末归档才生效）。
    """
    cur_path = os.path.join(REPO, 'data.json')
    if not os.path.exists(cur_path):
        print('❌ 找不到 data.json')
        return 1
    cur = json.load(open(cur_path, encoding='utf-8'))
    months, snap = _read_csv_style_sheet('today', cur.get('sheets') or {})
    if not snap:
        print('❌ data.json 没有可用的「分仓需求」DP 列')
        return 1

    old = {}
    if os.path.exists(OUT):
        try:
            old = json.load(open(OUT, encoding='utf-8'))
        except Exception as e:
            print('   ⚠️ 现有 dp-history.json 解析失败(%s)，将重建' % e)
    if not isinstance(old, dict) or not isinstance(old.get('months'), dict):
        old = {'months': {}}
    hist = old
    # 幂等闸门必须留存「修改前」的深拷贝：hist 与 old 是同一对象引用，
    # 直接 old['months'] == hist['months'] 恒为真 → 增量永远写不进去（v453 遗留 bug）
    import copy
    old_months = copy.deepcopy(old.get('months', {}))
    today = datetime.date.today().isoformat()

    n_add = n_new = n_fs = 0
    for mo, kv in snap.items():
        bucket = hist['months'].setdefault(mo, {})
        for key, v in kv.items():
            rec = bucket.get(key)
            if not isinstance(rec, dict) or not rec.get('revs'):
                bucket[key] = {'revs': [[today, v]]}
                n_new += 1
                continue
            revs = rec['revs']
            if revs[-1][0] == today:
                if revs[-1][1] != v:
                    revs[-1] = [today, v]
                    n_add += 1
            elif revs[-1][1] != v:
                revs.append([today, v])
                n_add += 1
        # 刷新该月首次缺货日（只增不删：归档换月后仍保留已知值）
        fsm, src = first_short_map(mo)
        if fsm:
            for key, dt in fsm.items():
                rec = bucket.get(key)
                if isinstance(rec, dict) and rec.get('fs') != dt:
                    rec['fs'] = dt
                    n_fs += 1
            print('   %s 首次缺货日：%d 键（源 %s）' % (mo, len(fsm), src))

    hist['generatedAt'] = datetime.datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
    hist['src'] = old.get('src') or 'git history of data.json + 每日部署增量'
    hist['ver'] = 1
    payload = json.dumps(hist, ensure_ascii=False, separators=(',', ':'))
    if old_months == hist['months']:
        print('⏭️ DP 无变化，跳过写入（新增变化点 %d，新键 %d，首次缺货日更新 %d）' % (n_add, n_new, n_fs))
        return 0
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(payload)
    print('✅ 增量写入 dp-history.json（%.1f KB）｜新增变化点 %d、新键 %d、首次缺货日更新 %d' % (
        len(payload.encode('utf-8')) / 1024, n_add, n_new, n_fs))
    return 0


def main():
    commits = list_commits()
    print('data.json 提交数 =', len(commits))

    # month -> {key: [(date, dp)]}（按提交顺序）
    series = defaultdict(lambda: defaultdict(list))
    skipped = 0
    for i, (sha, day) in enumerate(commits):
        raw = git_show(sha, 'data.json')
        if not raw:
            skipped += 1
            continue
        try:
            d = json.loads(raw.decode('utf-8'))
        except Exception:
            skipped += 1
            continue
        fd = (d.get('sheets') or {}).get('分仓需求')
        if not fd or not fd[0]:
            continue
        hdr = fd[0]
        mcols = [(i2, str(h)) for i2, h in enumerate(hdr)
                 if h is not None and len(str(h)) == 7 and str(h)[4] == '-']
        if not mcols:
            continue
        for r in fd[1:]:
            if r is None or len(r) < 6 or str(r[5]) != 'DP_共识数量':
                continue
            key = norm_sku(r[0]) + '|' + norm_rdc(r[2])
            for ci2, mo in mcols:
                v = r[ci2] if ci2 < len(r) else None
                if not isinstance(v, (int, float)):
                    continue
                lst = series[mo][key]
                if lst and lst[-1][0] == day:
                    lst[-1] = (day, float(v))      # 同一天多次提交 → 取最后一次
                else:
                    lst.append((day, float(v)))
        if (i + 1) % 10 == 0:
            print('  已扫 %d/%d' % (i + 1, len(commits)))

    out = {'generatedAt': datetime.datetime.now().strftime('%Y-%m-%dT%H:%M:%S'),
           'src': 'git history of data.json（每次提交 = 当天部署的「分仓需求」DP_共识数量原值）',
           'ver': 1,
           'months': {}}

    for mo in sorted(series.keys()):
        fsm, srcname = first_short_map(mo)
        keys = series[mo]
        # 只留变化点
        recs = {}
        nchg = 0
        for key, lst in keys.items():
            revs = [lst[0]]
            for p in lst[1:]:
                if p[1] != revs[-1][1]:
                    revs.append(p)
            if len(revs) > 1:
                nchg += 1
            rec = {'revs': [[p[0], int(p[1]) if float(p[1]).is_integer() else p[1]] for p in revs]}
            if key in fsm:
                rec['fs'] = fsm[key]
            recs[key] = rec
        out['months'][mo] = recs
        print('  %s: 键 %d（改过 %d）｜首次缺货覆盖 %d 键（源 %s）' % (
            mo, len(recs), nchg, len(fsm), srcname))

    payload = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    old = None
    if os.path.exists(OUT):
        try:
            old = json.load(open(OUT, encoding='utf-8'))
        except Exception:
            old = None
    # 幂等闸门：内容（除 generatedAt）完全一致就不写
    if old:
        a = dict(old)
        b = dict(out)
        a.pop('generatedAt', None)
        b.pop('generatedAt', None)
        if a == b:
            print('⏭️ 内容无变化，跳过写入 dp-history.json')
            return
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(payload)
    print('✅ 已写入 dp-history.json  %.1f KB' % (len(payload.encode('utf-8')) / 1024))
    print('   （跳过 %d 个无效提交）' % skipped)


if __name__ == '__main__':
    if '--append' in sys.argv:
        sys.exit(append_today())
    main()
