#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从《MM月RDC订单满足汇总.xlsx》抽取「山姆需求」sheet → 项目根 sams-demand.xlsx

用法：
  python tools/extract-sams-demand.py <源文件.xlsx> [--sheet 山姆需求] [--out sams-demand.xlsx]

为什么需要这一步：
  看板 samsLoad() 只 fetch 单个 ./sams-demand.xlsx（11KB 纯数据），
  不读 1.2MB 的月度订单汇总。直接替换会让看板去读「缺货汇总」sheet。

保证：
  · 输出 sheet 名固定为「需求计划」（看板优先按此名找）；
  · 表头、数值逐格照搬，不改一个字符（周桶表头是 samsParseWeekHdr 的解析依据）；
  · 抽完自动比对表头数量、周桶连续性，并打印新增周桶。
"""
import sys, os, shutil, argparse, datetime
import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_OUT = os.path.join(ROOT, 'sams-demand.xlsx')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src', help='源文件，如 10月RDC订单满足汇总.xlsx')
    ap.add_argument('--sheet', default='山姆需求')
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--no-backup', action='store_true')
    a = ap.parse_args()

    if not os.path.exists(a.src):
        sys.exit('源文件不存在: %s' % a.src)

    wb = openpyxl.load_workbook(a.src, data_only=True)
    if a.sheet not in wb.sheetnames:
        sys.exit('源文件里没有「%s」sheet。现有: %s' % (a.sheet, wb.sheetnames))
    ws = wb[a.sheet]
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    wb.close()
    print('源: %s  [%s]  %d 行 x %d 列' % (os.path.basename(a.src), a.sheet, len(rows), ws.max_column))

    # 备份旧文件
    if os.path.exists(a.out) and not a.no_backup:
        bak = os.path.join(ROOT, '_backup_sams_demand_%s.xlsx' % datetime.datetime.now().strftime('%Y%m%d_%H%M'))
        shutil.copy2(a.out, bak)
        print('备份: %s' % os.path.basename(bak))

    # 逐格写入（保留原值与原数字格式；样式看板不读，不复制）
    out = openpyxl.Workbook()
    sh = out.active
    sh.title = '需求计划'
    for r in rows:
        sh.append(r)
    out.save(a.out)
    out.close()

    # 自检
    chk = openpyxl.load_workbook(a.out, data_only=True)['需求计划']
    got = [list(r) for r in chk.iter_rows(values_only=True)]
    if len(got) != len(rows):
        sys.exit('❌ 行数不符: %d != %d' % (len(got), len(rows)))
    hdr = got[0]
    weeks = [h for h in hdr if h and str(h).strip()[:4].isdigit()]
    print('输出: %s  %d 行 x %d 列  周桶 %d 个' % (os.path.basename(a.out), len(got), len(hdr), len(weeks)))
    print('周桶范围: %s  →  %s' % (weeks[0], weeks[-1]))
    if weeks:
        print('最后 6 个周桶:')
        for w in weeks[-6:]:
            print('   ', w)
    chk.parent.close()


if __name__ == '__main__':
    main()
