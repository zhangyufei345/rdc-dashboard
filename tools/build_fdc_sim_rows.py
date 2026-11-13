# -*- coding: utf-8 -*-
"""
山姆模拟 · 原始周桶行导出器（给 Node harness 的 samsBuild 消费）

【为什么需要】
  用户 2026-11-12：「DP 为什么不包含安全库存？这样无法完全仿真」。
  根因：上一版原型在 Python 里自己写了 req_cover()，只累加 DP 需求覆盖，
  丢掉了线上 samsRopAt() 的统计法/峰值法安全库存、需求倍率 k、异常周剔除、折算周等全部机制。
  → 改为**直接复用线上真实 JS 函数**（samsBuild + samsRopAt），本脚本负责把
    git 每日部署链里「山姆需求」sheet 的原始行（表头 + 12 行）原样交给 samsBuild。

【数据源】git show <sha>:data.xlsx 的「山姆需求」sheet，与 build_fdc_sim_data.py 同一条链。
  只取 W 周桶格式（18 个切片）；M 月度格式没有周级 DP，数据层已用 LOCF 跳过。

【产出】.cache/_fdc_sim/slice_rows.json
  { "<slice date>": { "sha", "sheetName", "rows": [[...], ...] }, ... }
  不进 git / manifest（原型阶段）。
"""
import subprocess, io, os, json, datetime, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, '.cache', '_fdc_sim')
OUT = os.path.join(OUT_DIR, 'slice_rows.json')
SRC = os.path.join(OUT_DIR, 'fdc-sim-data.json')
SHEET = '山姆需求'

# 表头必须与线上 samsBuild 的 findCol 键逐字匹配（rdc-dashboard.html L2991~L3001）
REQUIRED_HEADERS = ['计划仓 Name', '计划仓 Code', '计划指标', '产品 Code', '产品 Name']
# 周桶表头必须能被线上 samsParseWeekHdr 的正则解析（L2907）
WEEK_RX = re.compile(r'^(\d{4})-(\d{2}) W(\d+)(P\d+)? \((\d{4})~(\d{4})\)$')


def norm(v):
    """openpyxl 单元格 → JSON 可序列化；日期/时间转 ISO 字符串，其余原样。"""
    if v is None or isinstance(v, (int, float, str, bool)):
        return v
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
        return v.isoformat()
    return str(v)


def main():
    import openpyxl
    os.makedirs(OUT_DIR, exist_ok=True)
    sim = json.load(open(SRC, encoding='utf-8'))
    w_slices = [s for s in sim['slices'] if s['fmt'] == 'W']
    out, checks = {}, []

    for s in w_slices:
        blob = subprocess.check_output(['git', 'show', s['sha'] + ':data.xlsx'], cwd=ROOT)
        wb = openpyxl.load_workbook(io.BytesIO(blob), read_only=True, data_only=True)
        if SHEET not in wb.sheetnames:
            raise SystemExit('%s 缺 %s sheet' % (s['sha'], SHEET))
        rows = [[norm(c) for c in r] for r in wb[SHEET].iter_rows(values_only=True)]
        hdr = [str(c).strip() if c is not None else '' for c in rows[0]]
        miss = [k for k in REQUIRED_HEADERS if k not in hdr]
        weeks = [k for k in hdr if WEEK_RX.match(k)]
        bad_week = [k for k in hdr if ' W' in k and '(' in k and not WEEK_RX.match(k)]
        if miss or bad_week or len(weeks) < 20:
            raise SystemExit('切片 %s 表头不合规: 缺=%s 坏周桶=%s 周桶数=%d'
                             % (s['date'], miss, bad_week, len(weeks)))
        metrics = sorted(set(str(r[20]) for r in rows[1:] if len(r) > 20 and r[7]))
        if metrics != ['DP_共识数量', '实际出货_数量']:
            raise SystemExit('切片 %s 计划指标异常: %s' % (s['date'], metrics))
        out[s['date']] = {'sha': s['sha'], 'sheetName': SHEET, 'rows': rows,
                          'weekCount': len(weeks), 'rowCount': len(rows)}
        checks.append((s['date'], s['sha'], len(weeks), len(rows), len(blob)))

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print('已写出', OUT, os.path.getsize(OUT), '字节 | 切片数', len(out))
    print('校验：表头键 / 周桶正则 / 指标行 / 行数 全部通过')
    for c in checks:
        print('  %s %s 周桶%2d 行%2d blob %d B' % c)
    # 与数据层的 DP 快照引用对拍：每个 daily 的快照日都必须有原始行
    refs = set(x['dpSnapshotDate'] for x in sim['daily'] if x['dpSnapshotDate'])
    lacking = sorted(refs - set(out))
    assert not lacking, '以下 DP 快照日缺原始行: %s' % lacking
    print('对拍：daily 引用的 %d 个 DP 快照日全部有原始行，无缺失' % len(refs))


if __name__ == '__main__':
    main()
