/* 山姆真实函数引擎库：逐字抽取 rdc-dashboard.html 的纯函数块，供模拟器与线上对拍共用。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.dirname(__dirname);
const D = path.join(ROOT, '.cache', '_fdc_sim');
const HTML = path.join(ROOT, 'rdc-dashboard.html');

const lines = fs.readFileSync(HTML, 'utf8').split(/\r?\n/);
const iStart = lines.findIndex(l => l.trim() === 'window._samsState = {');
const iRet = lines.findIndex(l => l.indexOf('planPerWeek: W_plan, ropVsLast:') >= 0);
if (iStart < 0 || iRet < 0) throw new Error('未找到山姆函数块边界，rdc-dashboard.html 结构已变');
const src = lines.slice(iStart, iRet + 3).join('\n');
[
  'function samsBuild(', 'function samsFutureDemand(', 'function samsDemandAxis(',
  'function samsRopAt(', 'var rop = reqCover + ssFinal;',
  'var coverTarget = coverDemandArr + ssFinalC;',
  // v494 起默认值 14→10；与 build_sams_sim_bundle.py 同款前缀校验，避免默认值再调误判结构漂移。
  'var coverDays = (st.coverDays > 0) ? st.coverDays : ',
  'var _carFrac = _carQ - _carWhole;'
].forEach(k => { if (!src.includes(k)) throw new Error('抽取块缺少关键行: ' + k); });
if (!src.trimEnd().endsWith('}')) throw new Error('抽取块尾部不是函数结束');
const SRC_SHA = crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);

// ⚠ 不用 "use strict"：线上 samsDemandAxis 有隐式全局 i，严格模式会 ReferenceError。
const engine = (new Function(
  'var window = {};\n' + src + '\n' +
  'return { samsBuild: samsBuild, samsRopAt: samsRopAt, samsParseWeekHdr: samsParseWeekHdr,' +
  ' samsProbit: samsProbit, SAMS_LEAD: SAMS_LEAD, SAMS_SSU: SAMS_SSU,' +
  ' state: window._samsState };'
))();

const RealDate = Date;
function setToday(iso) {
  const p = iso.split('-').map(Number);
  const fixed = new RealDate(p[0], p[1] - 1, p[2], 0, 0, 0, 0).getTime();
  class FakeDate extends RealDate {
    constructor() {
      if (arguments.length === 0) super(fixed);
      else super(...Array.prototype.slice.call(arguments));
    }
    static now() { return fixed; }
  }
  global.Date = FakeDate;
}
function restoreDate() { global.Date = RealDate; }

const st = Object.assign({}, engine.state, { curStock: {}, data: null });
const WH_NAME = n => '山姆-' + n + 'FDC';

function buildFor(day, rows, sheetName, exList) {
  setToday(day);
  st.data = engine.samsBuild(rows, sheetName, [sheetName], exList);
  if (!st.data.weeks.length || st.data.whs.length !== 6) {
    throw new Error('samsBuild 解析异常: weeks=' + st.data.weeks.length +
      ' whs=' + st.data.whs.length + ' warn=' + st.data.warn.join('/'));
  }
  return st.data;
}

function calc(whShort, coverDays, invPos) {
  const wh = st.data.whs.find(w => w.name === WH_NAME(whShort));
  if (!wh) throw new Error('找不到仓 ' + whShort);
  st.coverDays = coverDays;
  st.curStock = {}; st.curStock[whShort] = invPos;
  return engine.samsRopAt(wh, 1, st);
}

module.exports = {
  ROOT, D, HTML, lines, iStart, iRet, src, SRC_SHA,
  engine, st, setToday, restoreDate, RealDate, WH_NAME, buildFor, calc
};
