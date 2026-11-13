/* -*- coding: utf-8 -*-
 * 上线沙箱引擎数值对拍：页面用 new Function('window', code) 编译 sams-sim-engine.js，
 * 再用 sams-sim-data.json 跑 5 档推演，与离线原型 .cache/_fdc_sim/fdc_sim_real.json 逐行比较。
 * 目的：证明「浏览器沙箱里的公式」==「线上 rdc-dashboard.html 的公式」==「离线原型结果」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.dirname(__dirname);

const code = fs.readFileSync(path.join(ROOT, 'sams-sim-engine.js'), 'utf8');
const sandboxGlobal = { Date: Date };
const SamsSimEngine = (new Function('window', code + '\nreturn window.SamsSimEngine;'))(sandboxGlobal);
if (!SamsSimEngine || SamsSimEngine.sha16 !== '4d3441e1597ce943') {
  throw new Error('引擎编译失败或 sha16 漂移: ' + (SamsSimEngine && SamsSimEngine.sha16));
}
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'sams-sim-data.json'), 'utf8'));
const BASE = JSON.parse(fs.readFileSync(path.join(ROOT, '.cache/_fdc_sim/fdc_sim_real.json'), 'utf8'));
if (DATA.engineSha16 !== SamsSimEngine.sha16) throw new Error('数据文件与引擎 sha16 不一致');

const ACTIVE = DATA.activeWarehouses;
const CDS = [7, 10, 14, 21, 30];
const CAR = 5568;
const r2 = n => Math.round(n * 100) / 100;
const RealDate = Date;
function addDays(iso, n) {
  const p = iso.split('-').map(Number);
  const d = new RealDate(p[0], p[1] - 1, p[2] + n);
  return [d.getFullYear(), ('0' + (d.getMonth() + 1)).slice(-2), ('0' + d.getDate()).slice(-2)].join('-');
}

const eng = SamsSimEngine.create();
const st = eng.state;

// 参数 = 线上 _samsState 默认（与离线原型一致）
st.car = 5568; st.minCarRatio = 0.5; st.win = 8; st.coverW = 1;
st.basis = 'plan'; st.csl = 0.95; st.useExclude = true; st.freeDays = 30;

const startOf = {};
for (const w of ACTIVE) {
  const hit = DATA.daily.find(x => x.dpUsable && x.dpUsable[w]);
  if (!hit) throw new Error('仓 ' + w + ' 全窗口无 DP 共识');
  startOf[w] = hit.date;
}

// 每个决策日构建一次（零前视）
const built = {};
for (const x of DATA.daily) {
  const o = DATA.slices[x.dpSnapshotDate];
  if (!o) throw new Error('决策日 ' + x.date + ' 缺 DP 快照');
  eng.setToday(x.date);
  built[x.date] = eng.build(o.rows, o.sheetName, DATA.exclude);
  if (built[x.date].whs.length !== 6) throw new Error('samsBuild 仓数异常 @' + x.date);
}
const opening = {};
for (const w of ACTIVE) {
  eng.setToday(startOf[w]); st.data = built[startOf[w]];
  opening[w] = eng.calc(w, 14, 0).rop;
}

const FIELDS = ['onHand', 'invPos', 'transit', 'order', 'arrival', 'rop', 'coverTarget',
                'coverDemandArr', 'ssFinalC', 'coverNeed', 'nCar', 'shortage', 'ship'];
let checked = 0, bad = 0;
const badSamples = [];

for (const c of CDS) {
  for (const w of ACTIVE) {
    const sd = startOf[w];
    let onHand = 0, transit = 0, shortage = 0, started = false;
    const arrivals = {}, rows = [];
    for (const x of DATA.daily) {
      const day = x.date;
      if (day < sd) {
        rows.push({ date: day, active: false, onHand: null, invPos: null, transit: null,
                    order: null, arrival: null, rop: null, coverTarget: null, coverDemandArr: null,
                    ssFinalC: null, coverNeed: null, nCar: null, shortage: null, ship: 0,
                    excludedShip: r2(Number(x.ship[w]) || 0) });
        continue;
      }
      if (!started) { onHand = opening[w]; started = true; }
      const arr = arrivals[day] || 0;
      onHand += arr; transit -= arr; delete arrivals[day];
      const demand = Number(x.ship[w]) || 0;
      const served = Math.min(Math.max(0, onHand), demand);
      onHand -= served; shortage += demand - served;
      const invPos = onHand + transit;
      eng.setToday(day); st.data = built[day];
      const r = eng.calc(w, c, invPos);
      const order = x.decisionAllowed[w] ? r.batchBoxes : 0;
      if (order > 0) {
        transit += order;
        const eta = addDays(day, r.lead);
        arrivals[eta] = (arrivals[eta] || 0) + order;
      }
      rows.push({
        date: day, active: true, onHand: r2(onHand), invPos: r2(onHand + transit), transit: r2(transit),
        order: r2(order), arrival: r2(arr), rop: r2(r.rop), coverTarget: r2(r.coverTarget),
        coverDemandArr: r2(r.coverDemandArr), ssFinalC: r2(r.ssFinalC), coverNeed: r2(r.coverNeed),
        nCar: r.nCar, shortage: r2(demand - served), ship: r2(demand)
      });
    }
    const b = BASE.scenarios[String(c)][w];
    if (!b || b.length !== rows.length) throw new Error('基线行数不符 ' + c + '/' + w);
    for (let i = 0; i < rows.length; i++) {
      for (const f of FIELDS) {
        checked++;
        const a = rows[i][f], e = b[i][f];
        const ok = (a == null && e == null) ? true
                 : (a == null || e == null) ? false
                 : Math.abs(Number(a) - Number(e)) <= 0.011;
        if (!ok) {
          bad++;
          if (badSamples.length < 8) badSamples.push({ c, w, date: rows[i].date, f, got: a, exp: e });
        }
      }
      if (Boolean(rows[i].active) !== Boolean(b[i].active)) {
        bad++; if (badSamples.length < 8) badSamples.push({ c, w, date: rows[i].date, f: 'active', got: rows[i].active, exp: b[i].active });
      }
    }
  }
}

console.log('引擎 sha16 =', SamsSimEngine.sha16, '| 决策日', DATA.daily.length, '| DP 快照', Object.keys(DATA.slices).length);
console.log('逐仓起点 =', JSON.stringify(startOf));
console.log('期初预警线 =', JSON.stringify(Object.fromEntries(ACTIVE.map(w => [w, r2(opening[w])]))));
console.log('\n===== 数值对拍 %d/%d 逐位一致 =====', checked - bad, checked);
if (bad) {
  console.log('不一致样本:', JSON.stringify(badSamples, null, 1));
  process.exit(1);
}
for (const c of CDS) {
  const s = BASE.scenarios[String(c)];
  console.log('覆盖 %s 天 | %s', c, ACTIVE.map(w => {
    const live = s[w].filter(x => x.active);
    return w + ' ' + (live.reduce((a, x) => a + x.order / CAR, 0)).toFixed(0) + '车/缺' +
      Math.round(live.reduce((a, x) => a + x.shortage, 0)).toLocaleString();
  }).join(' | '));
}
