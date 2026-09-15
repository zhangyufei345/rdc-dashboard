// 探针：复算「按调整类型归因」各类型明细（不做硬断言，仅打印真实数字）
// 用途：回答「缺货率(条) 是什么口径」时给出可复核的真实分母/分子
const fs = require('fs');
const BASE = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
const html = fs.readFileSync(BASE + '/rdc-dashboard.html', 'utf8');

function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('fn not found: ' + name);
  let d = 0;
  const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
function grabLine(src, needle) {
  const i = src.indexOf(needle);
  if (i < 0) throw new Error('line not found: ' + needle);
  return src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i));
}

const parts = [];
['const ADJ_TRANSPORT', 'const ADJ_WINDOW_DAYS', 'const ADJ_RDC_FULL',
 'const ADJ_TYPE_ORDER', 'const ADJ_TYPE_COLORS'].forEach(function(k) { parts.push(grabLine(html, k)); });
parts.push(/const CN_PUBLIC_HOLIDAYS = new Set\(\[[\s\S]*?\]\);/.exec(html)[0]);
['isWorkday', '_adjDateAdd', '_adjFmtNum', '_adjBoxSpec', '_adjIsH',
 '_adjTypeColor', '_adjTypeList', '_adjTypeKind', 'buildAdjComputed'].forEach(function(n) { parts.push(grabFn(html, n)); });

const data = JSON.parse(fs.readFileSync(BASE + '/data.json', 'utf8'));
const adj = JSON.parse(fs.readFileSync(BASE + '/adjustments.json', 'utf8')).adjust;
const boxspec = data.boxSpecMap || {};
const od = data.sheets['订单明细'], H = od[0];
const i_d = H.indexOf('SAP放行日期'), i_s = H.indexOf('SKU编码'), i_w = H.indexOf('仓库名称'),
      i_q = H.indexOf('订单支数'), i_sh = H.indexOf('首日缺货量');
const EPOCH = Date.UTC(1899, 11, 30);

function build(mode) {
  const list = [];
  for (let i = 1; i < od.length; i++) {
    const r = od[i];
    if (!r || r[i_d] == null) continue;
    const ds = new Date(EPOCH + r[i_d] * 86400000).toISOString().slice(0, 10);
    let sk = String(r[i_s] == null ? '' : r[i_s]).trim();
    if (mode === 'norm') sk = sk.replace(/\.0$/, '').replace(/^0+/, '') || '0';
    list.push({ dateStr: ds, skuCode: sk, warehouse: r[i_w], orderQty: r[i_q] || 0, firstDayShort: r[i_sh] || 0 });
  }
  return list;
}
function spec(mode) {
  const o = {};
  Object.keys(boxspec).forEach(function(k) {
    let kk = String(k).trim();
    if (mode === 'norm') kk = kk.replace(/\.0$/, '').replace(/^0+/, '') || '0';
    o[kk] = boxspec[k];
  });
  return o;
}
function run(mode) {
  global.window = { _boxSpec: spec(mode), _skuIsHainan: {} };
  global.dataStore = { adjustRecords: adj, orderDetail: build(mode) };
  return new Function(parts.join('\n') + '\nreturn buildAdjComputed();')();
}

// 🔴 口径必须用 raw：页面 orderDetail.skuCode = getSafeStr(r,4)（原样，不做前导零标准化），
//    用 norm 会漏掉部分 SKU 的缺货 → 缺货条数/缺货率偏低（2026-09-15 实测：norm 48 条 vs raw 54 条）。
const computed = run('raw');
console.log('数据覆盖 maxOrd =', computed.maxOrd, '| 调整记录', computed.list.length, '条');

const fns = new Function(parts.join('\n') + '\nreturn { _adjTypeList: _adjTypeList, _adjTypeKind: _adjTypeKind };')();
const list = fns._adjTypeList(computed.list);

const typeAgg = list.map(function(tp) {
  const g = computed.list.filter(function(r) { return (r.adjType || '未填写') === tp; });
  const gCuts = g.filter(function(r) { return r.cut > 0; });
  const gDone = gCuts.filter(function(r) { return r.status === '已完成'; });
  const gShort = gDone.filter(function(r) { return r.shortBoxes > 0; });
  return { type: tp, recs: g.length, cuts: gCuts.length,
    cutBoxes: gCuts.reduce(function(s, r) { return s + r.cut; }, 0), done: gDone.length,
    shortCnt: gShort.length, shortBoxes: gShort.reduce(function(s, r) { return s + r.shortBoxes; }, 0) };
}).sort(function(a, b) { return b.cutBoxes - a.cutBoxes; });

console.log('\n调整类型'.padEnd(18) + '记录  扣减条   扣减箱   走完   缺货条   缺货率   缺货箱');
typeAgg.forEach(function(o) {
  const rate = o.done > 0 ? Math.round(o.shortCnt / o.done * 100) + '%' : '—';
  console.log(o.type.padEnd(18) + String(o.recs).padStart(4) + String(o.cuts).padStart(8) +
    String(Math.round(o.cutBoxes)).padStart(9) + String(o.done).padStart(7) +
    String(o.shortCnt).padStart(8) + rate.padStart(9) + String(Math.round(o.shortBoxes)).padStart(9));
});
const tCuts = typeAgg.reduce(function(s, o) { return s + o.cuts; }, 0);
const tDone = typeAgg.reduce(function(s, o) { return s + o.done; }, 0);
const tShort = typeAgg.reduce(function(s, o) { return s + o.shortCnt; }, 0);
console.log('合计'.padEnd(18) + ''.padStart(4) + String(tCuts).padStart(8) + ''.padStart(9) +
  String(tDone).padStart(7) + String(tShort).padStart(8) + (Math.round(tShort / tDone * 100) + '%').padStart(9));
