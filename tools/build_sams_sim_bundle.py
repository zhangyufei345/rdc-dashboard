# -*- coding: utf-8 -*-
"""
山姆前置仓「补货量 → 库存演化模拟」上线产物构建器（v484, 2026-11-13）

产出两个**只读静态产物**（项目根，进 git，不进 manifest，页面按需 fetch + ?t= 破缓存）：

  ① sams-sim-engine.js
     把 rdc-dashboard.html 里 L2830~L3770 的「山姆纯函数块」**逐字**包进一个沙箱工厂。
     形参 window / Date 遮蔽全局 → 线上公式一字不改，但 new Date() 可被固定到历史决策日，
     且不污染看板主页面的 Date / _samsState（完整仿真红线，含统计法 + 峰值法安全库存）。
  ② sams-sim-data.json
     把离线原型的「每日真实出货（累计切片差分）+ 当日可得 DP 快照原始行」合成一份线上数据。

🔴 生成时机：每次 rdc-dashboard.html 上线前**最后再跑一次**，确认 sha16 与当前 html 一致；
   若抽取块（线上补货公式）被改动，engine.js 必须同步重建，否则页面跑的是旧公式。

用法：python tools/build_sams_sim_bundle.py
"""
import json
import os
import hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.cache', '_fdc_sim')
HTML = os.path.join(ROOT, 'rdc-dashboard.html')

# ---------- 1. 逐字抽取线上山姆纯函数块（边界与 tools/fdc_sams_lib.cjs 完全一致） ----------
with open(HTML, encoding='utf-8') as f:
    lines = f.read().splitlines()
i_start = next(i for i, l in enumerate(lines) if l.strip() == 'window._samsState = {')
i_ret = next(i for i, l in enumerate(lines) if 'planPerWeek: W_plan, ropVsLast:' in l)
src = '\n'.join(lines[i_start:i_ret + 3])
for key in (
    'function samsBuild(', 'function samsFutureDemand(', 'function samsDemandAxis(',
    'function samsRopAt(', 'var rop = reqCover + ssFinal;',
    'var coverTarget = coverDemandArr + ssFinalC;',
    'var coverDays = (st.coverDays > 0) ? st.coverDays : 14;',
    'var _carFrac = _carQ - _carWhole;',
):
    if key not in src:
        raise SystemExit('抽取块缺少关键行: ' + key)
if not src.rstrip().endswith('}'):
    raise SystemExit('抽取块尾部不是函数结束，html 结构已变')
sha16 = hashlib.sha256(src.encode('utf-8')).hexdigest()[:16]

# ---------- 2. 合并模拟数据 ----------
with open(os.path.join(CACHE, 'fdc-sim-data.json'), encoding='utf-8') as f:
    sim = json.load(f)
with open(os.path.join(CACHE, 'slice_rows.json'), encoding='utf-8') as f:
    slice_rows = json.load(f)
with open(os.path.join(ROOT, 'sams-exclude.json'), encoding='utf-8') as f:
    exclude = json.load(f)

ACTIVE = sim['activeWarehouses']            # 天津 / 惠州 / 嘉兴
daily = []
used_slices = set()
for x in sim['daily']:
    daily.append({
        'date': x['date'],
        'ship': {w: x['ship'].get(w, 0) for w in ACTIVE},
        'dpSnapshotDate': x['dpSnapshotDate'],
        'dpCarryForward': x.get('dpCarryForward', False),
        'shipIntervalDays': x.get('shipIntervalDays', 1),
        'dpUsable': {w: bool(x['dpUsable'].get(w)) for w in ACTIVE},
        'decisionAllowed': {w: bool(x['decisionAllowed'].get(w)) for w in ACTIVE},
    })
    used_slices.add(x['dpSnapshotDate'])

slices = {}
for d in sorted(used_slices):
    o = slice_rows.get(d)
    if not o:
        raise SystemExit('决策日 %s 的 DP 快照缺原始行' % d)
    slices[d] = {'sheetName': o['sheetName'], 'rows': o['rows']}

rules = {
    'ship': '每日实际出货 = 相邻两次「山姆需求」切片的累计出货差分（T 出货 = 截止 T+1 累计 − 截止 T 累计），整笔记在区间末日，不摊分',
    'dp': '每个决策日只用当日可得的最近一次切片 DP 快照（LOCF，零前视）',
    'stock': '期初不取真实库存：假设各仓起算日 0 点在库正好等于当日真实预警线（需求覆盖 + 安全库存）',
    'start': '逐仓起点：各仓从「该仓首次有正数 DP 共识」那天开始模拟，不把三仓起算日拉平',
    'grayZone': '起点之前只占位、不消耗库存、不下单；该段真实出货如实披露，不删除数据',
    # v486：窗口/切片数全部动态取，不再写死 10-18~11-11 或「19 个切片、18 笔差分」。
    'axis': '三张图共用 %s~%s 的显示时间轴（只是显示坐标，各仓起算日不同；非工作日跳开）'
            % (sim['startMin'][5:], sim['end'][5:]),
    'weekend': '默认非工作日不补货（机会顺延到下一个工作日）；当天有入库或有出货的周末保留在显示轴',
    'openingSource': 'git data.xlsx 每日部署提交链（%d 个切片，%d 笔差分）'
                     % (len(sim['slices']), len(sim['_events'])),
}

data_obj = {
    # 🔴 幂等：用源切片链的构建时间，不用「本次运行时间」——否则每次重跑构建
    #    都会产生一个只改时间戳的 diff，本地 / git / 线上永远对不上。
    'generatedAt': sim.get('generatedAt', ''),
    'engineSha16': sha16,
    'sku': sim['sku'],
    'unit': sim['unit'],
    'activeWarehouses': ACTIVE,
    'dateRange': [sim['startMin'], sim['end']],
    'rules': rules,
    'exclude': exclude,
    'daily': daily,
    'slices': slices,
    'verification': {
        'dailyCount': len(daily),
        'sliceCount': len(slices),
        'shipTotal': {w: round(sum(d['ship'][w] for d in daily)) for w in ACTIVE},
        'noLookAhead': all(d['dpSnapshotDate'] <= d['date'] for d in daily),
    },
}
if not data_obj['verification']['noLookAhead']:
    raise SystemExit('DP 快照出现前视，数据不可用')

# ---------- 3. 生成沙箱引擎 js ----------
head = """/* ==========================================================================
 * 山姆前置仓「补货量 → 库存演化」沙箱引擎 —— 自动生成，请勿手改
 * 生成脚本 : tools/build_sams_sim_bundle.py
 * 来源     : rdc-dashboard.html 逐字抽取 L%d~L%d（%d 行，sha16=%s）
 * 用法     : 页面按需 fetch 本文件文本，用 new Function('window', code) 编译，
 *            取 window.SamsSimEngine.create() 得到与线上公式完全同源的引擎。
 *
 * 🔴 完整仿真红线：水位/安全库存/车数全部由线上 samsRopAt 自己算，
 *    本文件不重写任何公式，只做两件事：
 *      ① 用形参 window / Date 遮蔽全局，令 new Date() 可固定到历史决策日（零前视）；
 *      ② 把模拟的「库存位置 = 在库 + 在途」代入 st.curStock[仓] 作为当前库存入参。
 * 🔴 不加 'use strict'：线上 samsDemandAxis 有隐式全局 i，严格模式会 ReferenceError。
 * ========================================================================== */
(function (global) {
  var RealDate = global.Date;
  var SHA16 = '%s';

  // 形参 window / Date 遮蔽全局：SRC 里的 window._samsState 落在沙箱对象上，
  // new Date() 走 FakeDate，绝不污染看板主页面的 Date / _samsState。
  // var i 接住线上 samsDemandAxis 的隐式全局 i，避免把变量挂到真 window 上。
  function makeEngine(window, Date) {
    var i;
""" % (i_start + 1, i_ret + 3, i_ret + 3 - i_start, sha16, sha16)

tail = """
    return {
      samsBuild: samsBuild, samsRopAt: samsRopAt, samsProbit: samsProbit,
      SAMS_LEAD: SAMS_LEAD, SAMS_SSU: SAMS_SSU, state: window._samsState
    };
  }

  function create() {
    var fixedMs = 0;
    class FakeDate extends RealDate {
      constructor() {
        if (arguments.length === 0) super(fixedMs);
        else super(...Array.prototype.slice.call(arguments));
      }
      static now() { return fixedMs; }
    }
    var eng = makeEngine({}, FakeDate);
    var st = eng.state;
    return {
      sha16: SHA16,
      state: st,
      lead: eng.SAMS_LEAD,
      setToday: function (iso) {
        var p = String(iso).split('-').map(Number);
        fixedMs = new RealDate(p[0], p[1] - 1, p[2], 0, 0, 0, 0).getTime();
      },
      build: function (rows, sheetName, exList) {
        return eng.samsBuild(rows, sheetName, [sheetName], exList);
      },
      // coverW 缺省 1（线上默认）：页面把「覆盖周数」参数透传进来，
      // 让预警线 / 统计法安全库存也随参数联动；不传时与离线原型口径完全一致。
      calc: function (whShort, coverDays, invPos, coverW) {
        var wh = st.data.whs.find(function (w) { return w.name === '山姆-' + whShort + 'FDC'; });
        if (!wh) throw new Error('找不到仓 ' + whShort);
        st.coverDays = coverDays;
        st.curStock = {}; st.curStock[whShort] = invPos;
        return eng.samsRopAt(wh, (Number(coverW) > 0 ? Number(coverW) : 1), st);
      }
    };
  }

  global.SamsSimEngine = { create: create, sha16: SHA16 };
})(window);
"""

engine_js = head + src + tail

# ---------- 4. 落盘 + 自检 ----------
p_data = os.path.join(ROOT, 'sams-sim-data.json')
p_eng = os.path.join(ROOT, 'sams-sim-engine.js')
# 🔴 必须强制 LF：Windows 下 open(...,'w') 默认把 \n 写成 \r\n，
#    git 提交时又归一化成 LF，会出现「本地 73,267 B / 线上 72,262 B」的假不一致
#    （按行 diff 为 0，纯换行符差异）。固定 newline='\n' 后三端逐字节一致。
with open(p_data, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(data_obj, f, ensure_ascii=False, separators=(',', ':'))
with open(p_eng, 'w', encoding='utf-8', newline='\n') as f:
    f.write(engine_js)

if sha16 in open(p_eng, encoding='utf-8').read() and data_obj['engineSha16'] == sha16:
    pass
else:
    raise SystemExit('sha16 写入校验失败')

print('抽取线上函数块 L%d~L%d，%d 行，sha16=%s' % (i_start + 1, i_ret + 3, i_ret + 3 - i_start, sha16))
print('sams-sim-data.json  %d 字节 | %d 决策日 / %d 份 DP 快照 / 出货合计 %s'
      % (os.path.getsize(p_data), len(daily), len(slices), data_obj['verification']['shipTotal']))
print('sams-sim-engine.js  %d 字节' % os.path.getsize(p_eng))
print('零前视校验:', data_obj['verification']['noLookAhead'])
