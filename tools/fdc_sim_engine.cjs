/* -*- coding: utf-8 -*-
 * 山姆前置仓「补货量 → 逐日库存演化」· 真实函数引擎主程序
 *
 * 【用户 2026-11-12 裁定链】
 *   ①「DP 为什么不包含安全库存？这样无法完全仿真」→ 不再在 Python 里另写简化水位公式，
 *      直接复用线上 rdc-dashboard.html 逐字抽取的 samsBuild / samsRopAt（见 fdc_sams_lib.cjs）。
 *   ②「需求覆盖天数是可调的，对应跑出不同的结果」→ st.coverDays 扫描多档。
 *   ③「有 DP 前的出货都不算，从 DP 的日期开始」+ 用户选定【逐仓起点 / 统一 X 轴】
 *      → 每仓从「该仓首次有正数 DP 共识的日期」开始推演；之前只占位、不消耗库存、
 *        不下单，真实出货记进 excludedShip 如实披露，**不删除数据**。
 *      实测起点：天津 10-18 / 惠州 10-18 / 嘉兴 11-06。
 *      期初 = 各自起点日的真实预警线 rop（与 coverDays 无关，各档共用）。
 *
 * 【口径代入，必须如实标注】
 *   前置仓硬口径：ROP 必须与「库存位置 = 在库 + 在途」比较；
 *   线上单期计算器 v430 的 curStock 不含在途。
 *   本引擎把模拟的 invPos 传入 st.curStock[仓]，让真实 samsRopAt 自己算
 *   coverNeed / nCar / batchBoxes —— 公式与线上逐字相同，只替换「当前库存」这个入参。
 *
 * 【零前视】每个决策日：Date 覆盖成当日 → 用当日可得的最近一次 W 切片原始行跑 samsBuild
 *   → 再跑 samsRopAt()。DP 与历史实际出货都只来自当时那份切片。
 *
 * 【产出】.cache/_fdc_sim/fdc_sim_real.json（原型数据，不进 git / manifest）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./fdc_sams_lib.cjs');

const { ROOT, D, SRC_SHA, iStart, iRet, engine, st, setToday, restoreDate, RealDate, buildFor, calc } = L;
const SIM = JSON.parse(fs.readFileSync(path.join(D, 'fdc-sim-data.json'), 'utf8'));
const ROWS = JSON.parse(fs.readFileSync(path.join(D, 'slice_rows.json'), 'utf8'));
const EX = JSON.parse(fs.readFileSync(path.join(ROOT, 'sams-exclude.json'), 'utf8'));

const ACTIVE = SIM.activeWarehouses;
const CAR = 5568;
const COVER_DAYS_LIST = [7, 10, 14, 21, 30];   // 可调档位（线上默认 14）
const LEAD = { '天津': 5, '惠州': 5, '嘉兴': 3 };

console.log('抽取线上函数块 L%d~L%d，%d 行，sha16=%s',
  iStart + 1, iRet + 3, iRet + 3 - iStart, SRC_SHA);
if (engine.SAMS_LEAD['天津'] !== 5 || engine.SAMS_LEAD['嘉兴'] !== 3) throw new Error('线上 SAMS_LEAD 与模拟参数不一致');
if (Math.abs(engine.samsProbit(0.95) - 1.6449) > 0.001) throw new Error('线上统计法 z 值异常');

function addDays(iso, n) {
  const p = iso.split('-').map(Number);
  const d = new RealDate(p[0], p[1] - 1, p[2] + n);
  return [d.getFullYear(), ('0' + (d.getMonth() + 1)).slice(-2), ('0' + d.getDate()).slice(-2)].join('-');
}
const r2 = n => Math.round(n * 100) / 100;
// v486：与页面 samsSimIsWorkday 同口径。用原生 RealDate 带参构造，避开 FakeDate 覆盖全局 Date。
function isWorkday(iso) {
  const p = iso.split('-').map(Number);
  const w = new RealDate(p[0], p[1] - 1, p[2]).getDay();
  return w !== 0 && w !== 6;
}

/* ---------- 1. 逐仓起点：该仓首次「当日可得 DP 快照有正数共识」的日期 ---------- */
const startOf = {};
for (const w of ACTIVE) {
  const hit = SIM.daily.find(x => x.dpUsable && x.dpUsable[w]);
  if (!hit) throw new Error('仓 ' + w + ' 全窗口无 DP 共识');
  startOf[w] = hit.date;
}
console.log('逐仓推演起点：', ACTIVE.map(w => w + ' ' + startOf[w]).join(' | '));

/* ---------- 2. 每个决策日只构建一次 st.data（零前视） ---------- */
const built = {};
for (const x of SIM.daily) {
  const o = ROWS[x.dpSnapshotDate];
  if (!o) throw new Error('决策日 ' + x.date + ' 的 DP 快照 ' + x.dpSnapshotDate + ' 缺原始行');
  built[x.date] = buildFor(x.date, o.rows, o.sheetName, EX);   // 内部已 setToday(x.date)
}

/* ---------- 3. 期初：各仓「起点日」的真实 rop（用户裁定，不用实测库存） ---------- */
const opening = {}, openingDetail = {};
for (const w of ACTIVE) {
  const sd = startOf[w];
  setToday(sd); st.data = built[sd];
  const r = calc(w, 14, 0);          // rop 与 curStock / coverDays 无关
  opening[w] = r.rop;
  openingDetail[w] = {
    startDate: sd, rop: r2(r.rop), reqCover: r2(r.reqCover), ssFinal: r2(r.ssFinal),
    ss: r2(r.ss), ss1: r2(r.ss1), ss2: r2(r.ss2), ssPick: r.ssPick,
    k: r2(r.k), d: r2(r.d), dUse: r2(r.dUse), reqBasis: r.reqBasis,
    histLastLbl: r.histLastLbl, nUse: r.nUse, W_hist: r2(r.W_hist), sdD: r2(r.sdD)
  };
}
console.log('期初假设水位(各自起点日真实 rop)：',
  ACTIVE.map(w => w + ' ' + Math.round(opening[w]).toLocaleString()).join(' | '));

/* ---------- 4. 逐日 × 逐 coverDays 全量推演 ---------- */
const scenarios = {}, decomposition = {}, ver = {
  invPosGeOnHand: 0, onHandNonNeg: 0, transitNonNeg: 0,
  ssFinalCPositive: 0, coverTargetIdentity: 0, batchBoxesIdentity: 0,
  noLookAhead: true, calls: 0, builds: Object.keys(built).length,
  activeRows: 0, inactiveRows: 0
};
// 被排除的真实出货（只统计前缀灰区，如实披露，不删数据）
const excludedShip = {};
for (const w of ACTIVE) {
  excludedShip[w] = r2(SIM.daily.filter(x => x.date < startOf[w]).reduce((a, x) => a + (Number(x.ship[w]) || 0), 0));
}

for (const c of COVER_DAYS_LIST) {
  const byWh = {};
  for (const w of ACTIVE) {
    const sd = startOf[w];
    let onHand = 0, transit = 0, shortage = 0, started = false;
    const arrivals = {}, rows = [];
    for (const x of SIM.daily) {
      const day = x.date;
      const active = day >= sd;
      if (!active) {
        // 统一 X 轴占位：不消耗库存、不下单；真实出货记在 excludedShip 供报告披露
        rows.push({
          date: day, active: false, onHand: null, invPos: null, transit: null,
          order: null, arrival: null, rop: null, coverTarget: null, coverDemandArr: null,
          ssFinalC: null, ss1c: null, ss2c: null, ssPickC: null, coverNeed: null,
          nCar: null, batchDays: null, reqBasis: null, k: null,
          shortage: null, ship: 0, excludedShip: r2(Number(x.ship[w]) || 0),
          dpSnapshotDate: x.dpSnapshotDate, dpCarryForward: x.dpCarryForward,
          shipIntervalDays: x.shipIntervalDays, decisionAllowed: false
        });
        ver.inactiveRows++;
        continue;
      }
      if (!started) { onHand = opening[w]; started = true; }   // 起点日开门前 0 点库存
      // ① 到货入账（在途 → 在库，实线跳升、虚线不动）
      const arr = arrivals[day] || 0;
      onHand += arr; transit -= arr; delete arrivals[day];
      // ② 消耗当日真实出货（累计差分）
      const demand = Number(x.ship[w]) || 0;
      const served = Math.min(Math.max(0, onHand), demand);
      onHand -= served;
      shortage += demand - served;
      // ③ 库存位置 = 在库 + 在途（前置仓硬口径）
      const invPos = onHand + transit;
      // ④ 真实 samsRopAt（Date=当日、st.data=当日可得 DP 快照）
      setToday(day); st.data = built[day];
      const r = calc(w, c, invPos); ver.calls++;
      // ⑤ 车数直接取真实函数的 batchBoxes（v447 零头进位门槛已含）
      //    v486（用户 2026-11-13 裁定）：默认非工作日不补货，机会顺延到下一个工作日
      //    （工作日按当天 DP 与库存位置重新决策）；周末到货入库、真实出货照常入账。
      const isWd = isWorkday(day);
      const order = (isWd && x.decisionAllowed[w]) ? r.batchBoxes : 0;
      if (order > 0) {
        transit += order;
        const eta = addDays(day, r.lead);
        arrivals[eta] = (arrivals[eta] || 0) + order;
      }
      rows.push({
        date: day, active: true, onHand: r2(onHand), invPos: r2(onHand + transit), transit: r2(transit),
        order: r2(order), arrival: r2(arr), rop: r2(r.rop),
        coverTarget: r2(r.coverTarget), coverDemandArr: r2(r.coverDemandArr),
        ssFinalC: r2(r.ssFinalC), ss1c: r2(r.ss1c), ss2c: r2(r.ss2c), ssPickC: r.ssPickC,
        coverNeed: r2(r.coverNeed), nCar: isWd ? r.nCar : 0,
        batchDays: r.batchDays == null ? null : r2(r.batchDays),
        reqBasis: r.reqBasis, k: r2(r.k), shortage: r2(demand - served), ship: r2(demand),
        excludedShip: 0, dpSnapshotDate: x.dpSnapshotDate, dpCarryForward: x.dpCarryForward,
        shipIntervalDays: x.shipIntervalDays, decisionAllowed: x.decisionAllowed[w]
      });
      ver.activeRows++;
      if (onHand + transit >= onHand - 1e-6) ver.invPosGeOnHand++;
      if (onHand >= -1e-6) ver.onHandNonNeg++;
      if (transit >= -1e-6) ver.transitNonNeg++;
      if (r.ssFinalC > 0) ver.ssFinalCPositive++;
      if (Math.abs(r.coverTarget - (r.coverDemandArr + r.ssFinalC)) < 1e-6) ver.coverTargetIdentity++;
      if (Math.abs(r.batchBoxes - r.nCar * CAR) < 1e-6) ver.batchBoxesIdentity++;
      if (x.dpSnapshotDate > day) ver.noLookAhead = false;
    }
    byWh[w] = rows;
  }
  scenarios[String(c)] = byWh;

  const dec = {};
  for (const w of ACTIVE) {
    const live = byWh[w].filter(r0 => r0.active);
    const a = live[0], b = live[live.length - 1];
    dec[w] = {
      first: { date: a.date, coverDemandArr: a.coverDemandArr, ss1c: a.ss1c, ss2c: a.ss2c,
               ssPickC: a.ssPickC, ssFinalC: a.ssFinalC, coverTarget: a.coverTarget, k: a.k },
      last:  { date: b.date, coverDemandArr: b.coverDemandArr, ss1c: b.ss1c, ss2c: b.ss2c,
               ssPickC: b.ssPickC, ssFinalC: b.ssFinalC, coverTarget: b.coverTarget, k: b.k }
    };
  }
  decomposition[String(c)] = dec;
}

/* ---------- 5. 交叉校验 ---------- */
[
  ['invPosGeOnHand', '虚线(在库+在途) >= 实线(在库)'],
  ['onHandNonNeg', '在库不为负'],
  ['transitNonNeg', '在途不为负'],
  ['ssFinalCPositive', '安全库存 > 0（证明已含 SS）'],
  ['coverTargetIdentity', 'coverTarget = 需求覆盖 + 安全库存'],
  ['batchBoxesIdentity', '补货量 = 车数 × 整车'],
].forEach(([k, label]) => {
  if (ver[k] !== ver.activeRows) throw new Error('不变量失败: ' + label + ' ' + ver[k] + '/' + ver.activeRows);
  console.log('  ✅ ' + label + ' ' + ver[k] + '/' + ver.activeRows);
});
if (!ver.noLookAhead) throw new Error('DP 快照出现前视');
if (ver.activeRows + ver.inactiveRows !== COVER_DAYS_LIST.length * ACTIVE.length * SIM.daily.length) {
  throw new Error('行数不守恒');
}
console.log('  ✅ 统一 X 轴：有效行 %d / 灰区占位行 %d', ver.activeRows, ver.inactiveRows);

// 灰区不参与：所有 inactive 行的库存/下单字段必须为 null
for (const c of COVER_DAYS_LIST) for (const w of ACTIVE) for (const r0 of scenarios[String(c)][w]) {
  if (!r0.active && (r0.onHand !== null || r0.order !== null || r0.coverTarget !== null)) {
    throw new Error('灰区占位行混入了推演值: ' + c + '/' + w + '/' + r0.date);
  }
}
console.log('  ✅ 灰区占位行不含任何推演值');

let mono = 0, monoTotal = 0;
for (const w of ACTIVE) for (let i = 0; i < SIM.daily.length; i++) {
  const c0 = scenarios[String(COVER_DAYS_LIST[0])][w][i];
  if (!c0.active) continue;
  const vals = COVER_DAYS_LIST.map(c => scenarios[String(c)][w][i].coverTarget);
  for (let k = 1; k < vals.length; k++) { monoTotal++; if (vals[k] >= vals[k - 1] - 1e-6) mono++; }
}
if (mono !== monoTotal) throw new Error('coverTarget 未随覆盖天数单调: ' + mono + '/' + monoTotal);
console.log('  ✅ coverTarget 随覆盖天数单调不减 ' + mono + '/' + monoTotal);
restoreDate();

/* ---------- 6. 落盘 ---------- */
const out = {
  generatedAt: new RealDate().toLocaleString('zh-CN'),
  engine: {
    source: 'rdc-dashboard.html 逐字抽取 L' + (iStart + 1) + '~L' + (iRet + 3),
    sha16: SRC_SHA, lineCount: iRet + 3 - iStart,
    functions: ['samsBuild', 'samsFutureDemand', 'samsDemandAxis', 'samsCumAt',
                'samsDaysToQ', 'samsDaysFixed', 'samsRopAt', 'samsProbit', 'samsStat'],
    note: '含统计法/峰值法安全库存、需求倍率 k、异常周剔除、折算周、v447 零头进位门槛；'
        + '把模拟的库存位置代入 st.curStock，让真实函数自己算 coverNeed / nCar。'
  },
  params: {
    coverDaysList: COVER_DAYS_LIST, car: CAR, minCarRatio: st.minCarRatio,
    coverW: st.coverW, win: st.win, basis: st.basis, csl: st.csl,
    useExclude: st.useExclude, freeDays: st.freeDays, lead: LEAD,
    excludeCount: EX.exclude.length
  },
  rules: Object.assign({}, SIM.rules, {
    start: '逐仓起点：各仓从「该仓首次有正数 DP 共识的日期」开始推演（用户 2026-11-12 裁定）',
    grayZone: '起点之前只占位、不消耗库存、不下单；该段真实出货记进 excludedShip 如实披露，不删除数据',
    axis: '统一显示时间轴（各仓起算日不同）；非工作日默认跳开，当天有入库/出货的周末保留',
    weekendReplenish: 'v486 用户 2026-11-13 裁定：默认非工作日不补货，补货机会顺延到下一个工作日；周末到货入库与真实出货照常入账'
  }),
  dateRange: [SIM.startMin, SIM.end],
  perWhStart: startOf,
  excludedShip,
  opening: Object.fromEntries(ACTIVE.map(w => [w, r2(opening[w])])),
  openingDetail, decomposition,
  verification: Object.assign({}, ver, {
    coverTargetMonotonic: mono + '/' + monoTotal,
    dpSnapshotDates: [...new Set(SIM.daily.map(x => x.dpSnapshotDate))].sort()
  }),
  scenarios
};
const outPath = path.join(D, 'fdc_sim_real.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 1), 'utf8');
console.log('已写出', outPath, fs.statSync(outPath).size, '字节');
console.log('灰区排除的真实出货(如实披露, 未删除):', ACTIVE.map(w => w + ' ' + excludedShip[w].toLocaleString()).join(' | '));

for (const c of COVER_DAYS_LIST) {
  const s = scenarios[String(c)];
  console.log('覆盖 ' + c + ' 天 | ' + ACTIVE.map(w => {
    const rows = s[w].filter(r0 => r0.active);
    const cars = rows.reduce((a, x) => a + x.order / CAR, 0);
    const sh = rows.reduce((a, x) => a + x.shortage, 0);
    return w + ' ' + cars.toFixed(0) + '车/缺' + Math.round(sh).toLocaleString();
  }).join(' | '));
}
