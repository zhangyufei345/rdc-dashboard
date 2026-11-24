# -*- coding: utf-8 -*-
"""
一键重建「补货模拟」页静态数据包（订单部署后必跑）。

背景：补货模拟页的图表（山姆各 FDC 库存趋势）不读 data.json，而是读项目根的
静态产物 sams-sim-data.json + sams-sim-engine.js。它依赖 git 里 data.xlsx 的
每日部署提交链做「累计出货差分 + 当日可得 DP 快照」，浏览器无法自己重建。
因此每次「更新订单部署」提交新的 data.xlsx 后必须重跑本脚本，否则图表时间轴
会停在旧日期（2026-11-24 实测：漏跑两次 → 图表停在 11-19，而订单已到 11-23）。

用法：python tools/refresh_sams_sim_bundle.py
依赖：openpyxl（pip install openpyxl）；git 在项目 PATH 中可用。

顺序不可换：
  ① build_fdc_sim_data.py   → .cache/_fdc_sim/fdc-sim-data.json（切片链 + 逐日差分）
  ② build_fdc_sim_rows.py   → .cache/_fdc_sim/slice_rows.json（DP 快照原始行）
  ③ build_sams_sim_bundle.py → sams-sim-data.json + sams-sim-engine.js（线上产物）

末尾硬校验：包末日必须 == git 链末提交日期 − 1 天，且引擎 sha 与包内一致。
"""
import datetime
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'sams-sim-data.json')
STEPS = (
    'build_fdc_sim_data.py',
    'build_fdc_sim_rows.py',
    'build_sams_sim_bundle.py',
)


def main():
    for name in STEPS:
        path = os.path.join(ROOT, 'tools', name)
        print('\n===== 步骤: %s =====' % name, flush=True)
        subprocess.run([sys.executable, path], cwd=ROOT, check=True)

    with open(OUT, encoding='utf-8') as f:
        d = json.load(f)

    # 硬校验 1：差分末日 == git 链末提交日 − 1 天
    log = subprocess.check_output(
        ['git', 'log', '--date=short', '--pretty=%ad', '-1', '--', 'data.xlsx'],
        cwd=ROOT, text=True, encoding='utf-8').strip().split('\n')
    last_commit = log[-1]
    expected_end = (datetime.date.fromisoformat(last_commit) - datetime.timedelta(days=1)).isoformat()
    actual_end = d['dateRange'][1]
    if actual_end != expected_end:
        raise SystemExit(
            '❌ 模拟数据包末日 %s ≠ git 链末提交日 %s − 1 天（应为 %s）；图表会落后，请检查切片链'
            % (actual_end, last_commit, expected_end))

    # 硬校验 2：零前视 + 引擎 sha 同源（构建器已断言，这里再对线上产物验一次）
    if not d['verification'].get('noLookAhead'):
        raise SystemExit('❌ DP 快照出现前视')
    js = os.path.join(ROOT, 'sams-sim-engine.js')
    with open(js, encoding='utf-8') as f:
        head = f.read(4096)
    if d['engineSha16'] not in head:
        raise SystemExit('❌ sams-sim-engine.js 与 sams-sim-data.json 的 sha16 不一致')

    print('\n✅ 补货模拟数据包已刷新：%s ~ %s（来源 %s）'
          % (d['dateRange'][0], actual_end, d['generatedAt']))
    print('   决策日 %d / 快照 %d / sha16 %s'
          % (len(d['daily']), len(d['slices']), d['engineSha16']))
    print('   🔴 提交时把 sams-sim-data.json 与 sams-sim-engine.js 一起 add（不进 manifest）')


if __name__ == '__main__':
    main()
