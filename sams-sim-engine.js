/* ==========================================================================
 * 山姆前置仓「补货量 → 库存演化」沙箱引擎 —— 自动生成，请勿手改
 * 生成脚本 : tools/build_sams_sim_bundle.py
 * 来源     : rdc-dashboard.html 逐字抽取 L2830~L3770（941 行，sha16=4d3441e1597ce943）
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
  var SHA16 = '4d3441e1597ce943';

  // 形参 window / Date 遮蔽全局：SRC 里的 window._samsState 落在沙箱对象上，
  // new Date() 走 FakeDate，绝不污染看板主页面的 Date / _samsState。
  // var i 接住线上 samsDemandAxis 的隐式全局 i，避免把变量挂到真 window 上。
  function makeEngine(window, Date) {
    var i;
window._samsState = {
  win: 8,            // 历史窗口（周）: 4 / 8 / 12 / 0=全部
  coverW: 1,         // 覆盖周数（唯一决策变量）
  basis: 'plan',     // 基准口径: plan=未来计划优先 / hist=按历史销售覆盖(预警线+车数全走历史) / max=取两者高
  selWh: '__all__',  // 图2 仓选择
  onlyFut: false,    // 🔴 v419 图2 选项：只看「有未来 DP 需求」的仓（无未来 DP 的仓需求覆盖走「历史回退」）
  car: 5568,         // 整车倍数（箱/车）
  // v444（用户 2026-10-29 裁定）：最小起补量，单位 = **车**（不是箱）。
  //   缺口 < minCarRatio × 整车 → 本批不补（0 车）；达到或超过 → 照旧 ⌈缺口 ÷ 整车⌉ 进位。
  //   默认 0.5：缺口不足半车不发车（原 ceil 只要缺口 >2 箱就发一整辆车，最多多补 5,566 箱）。
  //   填 0.1 → 「缺口 ≥0.1 车才向上取整补 1 车」；填 0 → 关闭门槛（完全退化为原行为）。
  //   🔴 为什么用「车」不用「箱」：整车是页面可改输入框（st.car）。写死 1,000 箱在 5,568 箱/车下只有 0.18 车，
  //      改成 3,000 箱/车就变 0.33 车，语义会随参数漂移；用车的倍数则恒等。
  minCarRatio: 0.5,
  freeDays: 30,      // 🔴 免租上限：6 仓统一「入库起 30 天内须完成售罄」（2026-10-15 用户补充条件）
  // ===== v428：【补货算法】覆盖天数（目标库存口径）；v434 起为唯一算法 =====
  //   用户 2026-10-18「加入另一套算法，用覆盖周期作为目标库存推算补货量，我可以给你一个覆盖天数，比如14天」
  //   → 裁定：①含安全库存（补完水位落在「D 天预警线」上）②与目标售罄天数并存，二选一生效，预警线不动。
  //   口径：补货量 = max(0, 今天起 coverDays 天累计需求 + 安全库存 − 当前库存)；车数 = ⌈补货量 ÷ 整车⌉。
  //   🔴 历史数学关系（v428 实测，供备查）：不含安全库存时与 targetDays 完全等价（D=7 → 6 车 = 6 车，逐仓相同）；
  //      加上安全库存才是真正不同的口径（D=7 时 6 车 → 9 车）。两套差异点就在 ss 这一项。
  //   🔴 v434（2026-10-18 用户裁定「删掉目标售罄天数的算法」）：target 模式全链路删除，覆盖天数为唯一算法；
  //      「到货后单批售罄 X 天」指标保留（KPI 卡 / 明细表 / 免租校验），见 samsRopAt 内 batchDays。
  coverDays: 14,     // 覆盖天数（目标库存口径）· 单位：天
  csl: 0.95,         // 统计法服务水平（对应公司公式 F⁻¹(csl)；95% → z≈1.6449）
  useExclude: true,  // 是否剔除「异常周」（一次性铺货/促销等非经常性尖峰，清单见 sams-exclude.json）
  // 🔴 v420：【当前库存】各仓「下单那一刻的在库量」（仓短名 → 箱）。用户 2026-10-18 要求做输入口。
  //   未填该仓 = 走原假设（下单瞬间水位正好在预警线）；填了 = 用实测值算期初库存。
  //   ⚠ 存的是**下单时**在库，不是到仓时 —— 到仓时要再扣掉 lead 天的消耗，换算在 samsRopAt 内统一做。
  curStock: {},
  data: null, loading: false, err: '', loadedAt: ''
};
var SAMS_CSL = 0.95;   // 统计法：服务水平（可配，对应公司公式 F⁻¹(csl)；95% → z≈1.6449）
// 标准正态分位数 F⁻¹(p)：Acklam 近似，双精度精度 ~1e-9
function samsProbit(p) {
  if (!(p > 0) || !(p < 1)) return (p <= 0) ? -Infinity : Infinity;
  var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  var plow = 0.02425, phigh = 1 - plow, q, r;
  if (p < plow) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  else if (p <= phigh) { q = p - 0.5; r = q*q; return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1); }
  else { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
}
var SAMS_Z = samsProbit(SAMS_CSL);  // 默认服务水平推导的 z（0.95 → 1.6449），保留作兼容
// v436: 峰值法余量系数 1.2 → 1.0（用户 2026-10-21 裁定：「先去掉20%吧，目前偏保守了。山姆的需求预测准确定不高」）
//   ① 原值 1.2 无任何依据：项目根《安全库存公式对比说明.docx》5.2 节自述「同样是经验取值，没有回测」，
//      6.4 节承认「z=1.65、1.2、8周 这三个数字都是'听起来合理'，没有数据证明最优」。
//   ② 更关键的自相矛盾：2.3 节写「周上沿取实测最高周，不采用'周均+N倍标准差'这类人为放大」，
//      但外层的 ×1.2 本身就是人为放大。
//   ③ 且因 ss = max(ss1, 1.2×ss2) 的写法，1.2 的真实作用不是"整体加20%余量"，而是**只给峰值法补贴20%**，
//      把两条曲线的交点移动了 —— 实测（文档 7.2 口径）天津 ②从3,219抬到3,863刚好超过①3,366 → 采用值由统计法跳成峰值法。
//      「把1.2移到max外面」会让统计法也×1.2、所有仓SS上移（惠州/成都+20%），用户未选该方案。
//   ④ 现取 1.0 = 峰值法不加任何余量，SS 会下降（天津 −12.9%、武汉 −1.1%，惠州/成都本就是统计法不受影响）。
//   ⚠ 常量保留（不删）以便日后有缺货记录做回测标定时一行改回。
var SAMS_SSU = 1.0;   // 峰值法：余量系数（v436 起 1.0 = 不加余量；原 1.2 已按用户裁定移除）
// 🔴 v419: 5 仓配色重做 —— 原来 天津 #10B981 / 嘉兴 #14B8A6 都是青绿系，堆叠柱上几乎分不出来（用户 2026-10-18 截图）；
//   且原 武汉 #F59E0B 与「DP计划」虚线 #F59E0B 同色，虚线会被误读成武汉的线。
//   新配色按色相拉开 ≥50°，并**把橙色让给 DP 虚线 / 红色让给超限告警**，5 仓不再占用语义色。
//   顺序 = chartWhs 顺序（惠州/天津/武汉/成都/嘉兴）。
var SAMS_COLORS = ['#2563EB', '#16A34A', '#DB2777', '#7C3AED', '#0891B2'];  // 蓝 / 绿 / 玫红 / 紫 / 青

// 🚚 运输时效（下单 + 提货运输，单位：天）—— 来源：用户 2026-10-15 提供的《山姆前置仓》运输周期表。
//   表里写「1+4」= 下单 1 天 + 提货运输 4 天 = 5 天，依此类推。
//   🔴 为什么必须要有它（v408 口径修正）：免租是「**入库起** 30 天内须售罄」，
//      所以天数必须**从到仓起算**；而在此之前货还在路上跑，在库旧货一直在被消化（每天 dUse 箱）
//      ⇒ 到仓时的在库 = 预警线 − 日均 × 时效。
//      旧算法按「下单时点」起算（不扣时效），会**系统性高估**单批售罄天数
//      （惠州/天津/武汉 多算 5 天、成都 多算 6 天、嘉兴 多算 3 天）。
//   ⚠ 常州 FDC 不在该表内（表里只有 天津/惠州/嘉兴/武汉/成都）→ 未配置则按 0 天保守估，页面会标注。
var SAMS_LEAD = { '天津': 5, '惠州': 5, '嘉兴': 3, '武汉': 5, '成都': 6 };

// 周桶表头解析: "2026-09 W1P2 (0901~0906)" → {ym, week, part, short, full, s, e, days}
//   s/e = 该段真实起止日; days = 该段覆盖天数（满周 7；跨月被切开时是 1~6）
function samsParseWeekHdr(s) {
  var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  var m = /^(\d{4})-(\d{2}) W(\d+)(P\d+)? \((\d{4})~(\d{4})\)$/.exec(t);
  if (!m) return null;
  var y = +m[1];
  var s1 = new Date(y, +m[5].slice(0, 2) - 1, +m[5].slice(2));
  var e1 = new Date(y, +m[6].slice(0, 2) - 1, +m[6].slice(2));
  return {
    label: t, ym: m[1] + '-' + m[2], week: +m[3], part: m[4] || '',
    d1: m[5], d2: m[6], s: s1, e: e1,
    days: Math.round((e1 - s1) / 86400000) + 1,
    short: (+m[2]) + '/' + (+m[5].slice(2)) + '~' + (+m[6].slice(2)),
    full: m[1] + '-' + m[2] + ' W' + (+m[3]) + (m[4] || '') + ' (' + (+m[5].slice(0, 2)) + '/' + (+m[5].slice(2)) + '~' + (+m[6].slice(0, 2)) + '/' + (+m[6].slice(2)) + ')'
  };
}

// 取某天所属自然周的周一（周一为一周起点）
function samsMonday(d) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function samsMD(a, b) {
  var s = (a.getMonth() + 1) + '/' + a.getDate();
  var e = (b.getMonth() === a.getMonth()) ? String(b.getDate()) : (b.getMonth() + 1) + '/' + b.getDate();
  return s + '~' + e;
}

function samsWhShort(name) { return String(name || '').replace(/^山姆-/, '').replace(/FDC$/, ''); }

// 样本统计（sd 为样本标准差 n-1）
function samsStat(arr) {
  var n = arr.length, sum = 0, i;
  if (!n) return { n: 0, mean: 0, sd: 0, max: 0, min: 0 };
  for (i = 0; i < n; i++) sum += arr[i];
  var mean = sum / n, v = 0;
  for (i = 0; i < n; i++) v += (arr[i] - mean) * (arr[i] - mean);
  return { n: n, mean: mean, sd: n > 1 ? Math.sqrt(v / (n - 1)) : 0,
           max: Math.max.apply(null, arr), min: Math.min.apply(null, arr) };
}

// ---------- 加载（文件 11KB，直接 fetch 解析，绕过所有缓存体系）+ 缓存破坏参数 ----------
function samsLoad(force) {
  var st = window._samsState;
  if (!force && (st.data || st.loading)) return;
  if (force) { st.data = null; }
  st.loading = true; st.err = '';
  renderSamsFc();
  fetch('./sams-demand.xlsx?t=' + Date.now())
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' —— sams-demand.xlsx 未部署或路径不对');
      return r.arrayBuffer();
    })
    .then(function (buf) {
      var wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
      var sName = wb.SheetNames.indexOf('需求计划') >= 0 ? '需求计划' : wb.SheetNames[0];
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[sName], { header: 1, defval: null, raw: true });
      // 异常周剔除清单：独立小文件（**替换 sams-demand.xlsx 不会丢**）。
      // 取不到 / 格式不对 → 当作「无剔除」，不影响主流程。
      return fetch('./sams-exclude.json?t=' + Date.now())
        .then(function (rx) { return rx.ok ? rx.json() : null; })
        .catch(function () { return null; })
        .then(function (ex) {
          st.data = samsBuild(rows, sName, wb.SheetNames, ex);
          try { window._samsLoadedAt = new Date().toLocaleString('zh-CN'); } catch (e2) { window._samsLoadedAt = ''; }
          st.loading = false;
          renderSamsFc();
        });
    })
    .catch(function (e) {
      st.loading = false;
      st.err = String((e && e.message) || e);
      renderSamsFc();
    });
}

// ---------- 解析工作表 → 结构化 ----------
function samsBuild(rows, sheetName, sheetNames, exList) {
  var out = { weeks: [], whs: [], sheetName: sheetName, sheetCount: (sheetNames || []).length, warn: [] };
  if (!rows || rows.length < 2) { out.warn.push('「' + sheetName + '」表为空'); return out; }
  var hdr = rows[0] || [];
  function hAt(i) { return String(hdr[i] == null ? '' : hdr[i]).replace(/\s+/g, ' ').trim(); }
  function findCol(keys) {
    for (var k = 0; k < keys.length; k++) for (var i = 0; i < hdr.length; i++) if (hAt(i) === keys[k]) return i;
    return -1;
  }
  var iWhName = findCol(['计划仓 Name', '计划仓Name']);
  var iWhCode = findCol(['计划仓 Code', '计划仓Code']);
  var iMetric = findCol(['计划指标']);
  var iProdCode = findCol(['产品 Code', '产品Code']);
  var iProdName = findCol(['产品 Name', '产品Name']);
  var iBrand = findCol(['品牌 Name', '品牌Name']);
  var iSeries = findCol(['系列 Name', '系列Name']);
  var iSupply = findCol(['供应链品类']);
  var iAbc = findCol(['ABC分类', 'ABC 分类']);
  var iLife = findCol(['生命周期标签']);
  var iRetail = findCol(['零售价']);

  // 兜底：若表头改名，按「数据里含 FDC/山姆-」反查仓名列
  if (iWhName < 0) {
    var lim = Math.min(24, hdr.length);
    for (var c = 0; c < lim && iWhName < 0; c++) {
      for (var r2 = 1; r2 < Math.min(rows.length, 6); r2++) {
        var cell = String((rows[r2] || [])[c] == null ? '' : (rows[r2] || [])[c]);
        if (cell.indexOf('FDC') >= 0 || cell.indexOf('山姆-') >= 0) { iWhName = c; break; }
      }
    }
    if (iWhName >= 0) out.warn.push('「计划仓 Name」表头未精确命中，已按数据内容定位到第 ' + (iWhName + 1) + ' 列');
  }
  if (iWhName < 0 || iMetric < 0) {
    out.warn.push('关键列缺失（计划仓 Name / 计划指标），请确认源表结构未变');
    return out;
  }
  if (iWhCode < 0) iWhCode = iWhName > 0 ? iWhName - 1 : -1;

  var wkCols = [], weeks = [];
  for (var c2 = 0; c2 < hdr.length; c2++) {
    var w = samsParseWeekHdr(hdr[c2]);
    if (w) { wkCols.push(c2); weeks.push(w); }
  }
  out.weeks = weeks;

  var map = {}, order = [];
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r] || [];
    var whRaw = row[iWhName];
    if (whRaw == null || String(whRaw).trim() === '') continue;
    var whName = String(whRaw).trim();
    var metric = String(row[iMetric] == null ? '' : row[iMetric]).trim();
    var isActual = metric.indexOf('实际') >= 0;
    var isPlan = (metric.indexOf('DP') >= 0) || (metric.indexOf('共识') >= 0) || (metric.indexOf('计划') >= 0);
    if (!isActual && !isPlan) continue;

    if (!map[whName]) {
      map[whName] = { name: whName, code: iWhCode >= 0 ? String(row[iWhCode] == null ? '' : row[iWhCode]).trim() : '',
                      actual: [], plan: [], meta: {} };
      order.push(whName);
    }
    var o = map[whName];
    var tgt = isActual ? 'actual' : 'plan';
    if (o[tgt].length) continue;   // 同仓同指标只取第一行，防重复行
    for (var q = 0; q < wkCols.length; q++) {
      var v = row[wkCols[q]];
      if (v == null) { o[tgt].push(null); continue; }
      if (typeof v === 'string') { v = v.replace(/,/g, '').trim(); if (v === '') { o[tgt].push(null); continue; } }
      var nv = Number(v);
      o[tgt].push(isFinite(nv) ? nv : null);
    }
    if (!o.meta.product) {
      o.meta.product = iProdName >= 0 ? String(row[iProdName] || '') : '';
      o.meta.productCode = iProdCode >= 0 ? String(row[iProdCode] || '') : '';
      o.meta.brand = iBrand >= 0 ? String(row[iBrand] || '') : '';
      o.meta.series = iSeries >= 0 ? String(row[iSeries] || '') : '';
      o.meta.supply = iSupply >= 0 ? String(row[iSupply] || '') : '';
      o.meta.abc = iAbc >= 0 ? String(row[iAbc] || '') : '';
      o.meta.life = iLife >= 0 ? String(row[iLife] || '') : '';
      o.meta.retail = iRetail >= 0 ? String(row[iRetail] || '') : '';
    }
  }
  order.forEach(function (n) {
    var o = map[n];
    while (o.actual.length < weeks.length) o.actual.push(null);
    while (o.plan.length < weeks.length) o.plan.push(null);
  });

  // ================= 关键：把"周桶"合并回「真实自然周」 =================
  // 🔴 源表按【月】切周：跨月的自然周被拆成 P1(落在本月)+P2(落在下月) 两段，
  //    如 `2026-06 W5P1 (0629~0630)` + `2026-07 W1P2 (0701~0705)` 才是一整周；
  //    另有 `2026-08 W6P1 (0831~0831)` 只有 1 天。
  //    33 个桶里只有 22 个是完整 7 天 —— 若把部分桶当"周总量"混在一起算
  //    周均/σ/上沿，量纲不一致 → 周均被拉低、周σ被抬高。故此处按自然周合并。
  //    合并规则：① 同一"周一"的分段求和；② 跨度合计必须 = 7 天；
  //              ③ 任一分段为空 → 整周判空（**不猜、不补**），ECharts 自然断开。
  var gmap = {}, groups = [];
  for (var gi = 0; gi < weeks.length; gi++) {
    var mon = samsMonday(weeks[gi].s);
    var gk = mon.getFullYear() * 10000 + (mon.getMonth() + 1) * 100 + mon.getDate();
    if (!gmap[gk]) { gmap[gk] = { key: gk, mon: mon, cols: [], days: 0 }; groups.push(gmap[gk]); }
    gmap[gk].cols.push(gi);
    gmap[gk].days += weeks[gi].days;
  }
  // v409: 🔴 「周是否已走完」—— 进行中的当前周实际出货只到"今天"，若当成完整 7 天会拉低周均、
  //       让安全库存偏低。故 ok 必须同时满足「跨度=7 天」且「该周已结束（下周一 00:00 ≤ 今天）」。
  var _today0 = (function () { var t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime(); })();
  var mweeks = groups.map(function (g) {
    var a = weeks[g.cols[0]], b = weeks[g.cols[g.cols.length - 1]];
    var ended = (g.mon.getTime() + 7 * 86400000) <= _today0;
    return {
      mon: g.mon, cols: g.cols, days: g.days, ok: g.days === 7 && ended, running: !ended,
      s: a.s, e: b.e, short: samsMD(a.s, b.e),
      label: (g.cols.length > 1 ? '合并周 ' : '') + samsMD(a.s, b.e) + '（' + g.days + ' 天）',
      full: samsMD(a.s, b.e) + ' (' + a.full.split(' (')[0] + (g.cols.length > 1 ? ' + ' + b.full.split(' (')[0] : '') + ')'
    };
  });
  out.mweeks = mweeks;
  out.rawWeekCount = weeks.length;
  // tempWeeks = 真正「月切出来不满 7 天」的段；runningWeeks = 进行中的当前周（不同性质，分开提示）
  out.tempWeeks = mweeks.filter(function (w) { return w.days !== 7 && !w.running; }).map(function (w) { return w.short + '（' + w.days + '天）'; });
  out.runningWeeks = mweeks.filter(function (w) { return w.running; }).map(function (w) { return w.short; });

  // ===== v441: 跨月拆段「单段缺数」按天折算成整周（用户 2026-10-27 裁定）=====
  //   背景：源表按自然月切周，跨月周被拆成 P1(本月末几天) + P2(下月初几天)。
  //   旧规则「任一分段为空 → 整周不可用」会让整周凭空消失，实测两个后果：
  //     ① 9/28~10/4：col51(0928~0930 有值) + col52(1001~1004 **六仓全空**) → 整周作废
  //     ② 10/26~11/1：col56(1026~1031 有值) + col57(1101 全空) → 即使该周走完也永远进不来
  //   ⇒ 成都/武汉/常州/嘉兴（DP 计划恒 0，走 hist 历史回退）的历史窗口卡在 10/19~25 不再更新，
  //     预警线连续多日恒定（成都 3,480 一直不变），用户 2026-10-27 报「成都预警线没变」。
  //   现改为：整周跨度 = 7 天（结构完整）但部分分段无值 → 按「已有分段值 × 7 ÷ 已有分段天数」折算。
  //   ⚠ 折算值只用于「周均」，**不进 σ / 周上沿**（见 samsRopAt 的 useReal）——3 天折成 7 天会放大 2.33 倍，
  //     若让它参与峰值法会造出假峰值、把安全库存顶上去（成都 9/28~10/4 折算 8,526 会假成最高周）。
  //   ⚠ 跨度本身不满 7 天的周（月首 4/1~5 只有 5 天、月末 11/30~30 只有 1 天）不折算，保持 null（保守）。
  //   🔴 2026-10-27 实测修正（教训）：首版对所有跨月边界周都折算，结果历史周 4/27~5/3、6/29~7/5、7/27~8/2
  //     也被填上值，其中「月末 3 天」被放大 2.33 倍成了假高值 ——
  //     惠州 9/28~10/4 三天 11,310 折成整周 26,390（日均 3,770 vs 正常 1,200~2,300，月末冲量），
  //     直接把周均 8,591 顶到 10,759、峰值法被打成统计法，五仓预警线全变
  //     （惠州 -892 / 天津 -2,118 / 武汉 +1,313 / 成都 +826 / 嘉兴 +2,357）—— 远超"让窗口滚动"这一诉求，
  //     属擅自扩大影响面。现**只允许「数据末尾那一周」折算**（它之后没有任何有值周），
  //     历史月边界周一律保持 null。这样既能让最新一周进入窗口（解决预警线冻结），
  //     又不会用月末冲量污染周均/σ/峰值。验证：改动后今天(10-27)六仓预警线与改动前逐位一致，
  //     mock 11-02 时成都等无 DP 仓的窗口能正常前移。
  function _samsMergeWeek(arr, mw, mi, estOut, allowEst, zeroMode) {
    var t = 0, have = 0, missDays = 0, hasMiss = false, q, ci, v, d;
    for (q = 0; q < mw.cols.length; q++) {
      ci = mw.cols[q]; v = arr[ci];
      d = (weeks[ci] && weeks[ci].days) ? weeks[ci].days : 0;
      if (v == null) { hasMiss = true; missDays += d; }
      else { t += v; have += d; }
    }
    if (!hasMiss) return t;                    // 全部分段有值 → 原值，一字不动
    if (have <= 0) return null;                // 全部分段皆空 → 真无数据
    if (mw.days !== 7) return null;            // 跨度不满 7 天（月首/月末截断）→ 不折算
    if (!allowEst) return null;                // 非「数据末尾那一周」→ 保持 null，不用冲量值污染周均
    if (estOut) estOut[mi] = { raw: t, have: have, miss: missDays, mode: zeroMode ? 'zero' : 'extrap' };
    // v448（用户 2026-11-03 裁定）：最新那个「已结束的完整周」的缺失段，直接按「0 出货」计入，
    //   不再用「已有分段 × 7 ÷ 已有天数」外推。
    //   起因：10/26~11/1 = col(1026~1031 六仓有值) + col(1101 **全空**)，外推得 惠州 4176×7÷6=4,872，
    //   而源表 11/1 的实际出货是空（=0 出货）→ 该周真实合计就是 4,176，4,872 是凭空造出来的。
    //   实测批量发货特性：10/26~10/31 六天共 4,176（约 696/天），11/2~11/3 两天已 4,002（约 2,001/天），
    //   日度波动达 3 倍 → 「日均外推」在这种仓上本就不可靠，宁可取真实观测。
    //   ⚠ 只作用于「最后一个已结束的完整周」，历史跨月周（6/29~7/5、7/27~8/2）维持 v446 外推不动 ——
    //     否则 7/27~8/2 六仓周值会齐降 29%（惠州 7,795→5,568），远超本次诉求的影响面。
    if (zeroMode) return t;
    return t * 7 / have;
  }
  // v448: 「最后一个已结束的完整周」索引（日历属性，与仓无关）—— 该周的缺失段按 0 计，不外推
  var _lastOkFull = -1;
  for (var _lo = mweeks.length - 1; _lo >= 0; _lo--) {
    if (mweeks[_lo].ok && mweeks[_lo].days === 7) { _lastOkFull = _lo; break; }
  }
  out.lastOkFullIdx = _lastOkFull;
  out.whs = order.map(function (n) {
    var o = map[n];
    // v441: 只对「最后一个仍有任意分段值的周」允许折算（数据末尾补全）；更早的月边界周保持 null
    var lastHas = -1, mi2, mw2, q4, any;
    for (mi2 = mweeks.length - 1; mi2 >= 0; mi2--) {
      mw2 = mweeks[mi2]; any = false;
      for (q4 = 0; q4 < mw2.cols.length; q4++) { if (o.actual[mw2.cols[q4]] != null) { any = true; break; } }
      if (any) { lastHas = mi2; break; }
    }
    o.estWeeks = {};                           // {合并周索引: {raw, have, miss}} → 展示层标「含 N 个折算周」
    // ===== v446: 折算资格从「只有数据末尾那一周」放宽为「已结束 + 结构完整 + 缺数≤2天」=====
    //   背景（用户 2026-11-03 报「山姆看板显示 已 9 天无新周，但需求/出货已更新到 11 月」）：
    //     10/26~11/1 是跨月合并周（col 1026~1031 有值 + 1101 全空），结构完整（7天）且已结束（ok=true），
    //     但因缺 1 天拿不到折算资格（lastHas 此时指向进行中的 11/2~8）→ actualM=null → 整周被丢弃；
    //     而 11/2~8 是进行中周（ok=false）不进统计 ⇒ 历史窗口只能卡在 10/19~25，陈旧提示 9 天。
    //     实测（线上 BUILD 445，2026-11-03）：六仓 actualM[10/26~11/1] 全为 null，最新有效周 = 10/19~25。
    //   规则：lastHas 保持原样（末尾周必折算），另放行「ok（已结束）+ days===7 + 缺数 1~2 天 + 有余值」的周。
    //   🔴 缺数 >2 天仍拦下 —— 9/28~10/4 缺 4 天，×7/3=2.33 倍会造出月末冲量假峰值（v441 踩过：
    //      惠州三天 11,310 折成 26,390，五仓预警线全变），绝不能放行。
    //   影响面实测（改前→改后预警线）：惠州 6413→6607(+3.0%) 天津 9154→8887(-2.9%) 武汉 5939→5907(-0.5%)
    //      成都 3480→3621(+4.1%) 嘉兴 13032→13410(+2.9%)，均在窗口滚动一周的正常波动范围内。
    var allowEstSet = {};
    for (var _ae = 0; _ae < mweeks.length; _ae++) {
      if (_ae === lastHas) { allowEstSet[_ae] = 1; continue; }
      var _mw = mweeks[_ae];
      if (!_mw || !_mw.ok || _mw.days !== 7) continue;
      var _missD = 0, _haveD = 0;
      for (var _q = 0; _q < _mw.cols.length; _q++) {
        var _ci = _mw.cols[_q];
        var _dd = (weeks[_ci] && weeks[_ci].days) ? weeks[_ci].days : 0;
        if (o.actual[_ci] == null) _missD += _dd; else _haveD += _dd;
      }
      if (_missD > 0 && _missD <= 2 && _haveD > 0) allowEstSet[_ae] = 1;
    }
    // ===== v448: 「最后一个已结束的完整周」缺失段按 0 计（不外推）=====
    //   _lastOkFull 是日历属性（与仓无关），在 map 外算好；此处只决定该仓这一周是否触发。
    var zeroSet = {};
    if (_lastOkFull >= 0 && allowEstSet[_lastOkFull]) zeroSet[_lastOkFull] = 1;
    o.actualM = mweeks.map(function (mw, mi) { return _samsMergeWeek(o.actual, mw, mi, o.estWeeks, !!allowEstSet[mi], !!zeroSet[mi]); });
    o.planM   = mweeks.map(function (mw, mi) { return _samsMergeWeek(o.plan,   mw, mi, null, !!allowEstSet[mi], !!zeroSet[mi]); });
    return o;
  });
  // ---- 解析「异常周剔除清单」：wh + week → 合并周索引 --------------
  // 支持 wh 写短名(惠州)或全名(山姆-惠州FDC)；week 写合并周短标签(9/21~27)或该周周一日期(2026-09-21)
  out.exclude = {};          // 仓全名 -> { idx:[合并周索引], notes:[原因] }
  out.excludeMissed = [];    // 没匹配上的条目（页面诚实提示，避免"改了没生效却不知道"）
  var _norm = function (x) { return samsWhShort(String(x == null ? '' : x).trim()); };
  ((exList && exList.exclude) || []).forEach(function (ex) {
    if (!ex || !ex.wh || !ex.week) return;
    var hitWh = null;
    out.whs.forEach(function (w) { if (_norm(w.name) === _norm(ex.wh)) hitWh = w; });
    if (!hitWh) { out.excludeMissed.push(ex.wh + ' / ' + ex.week + '（仓名未匹配）'); return; }
    var wkk = String(ex.week).trim(), hitIdx = -1;
    for (var mi = 0; mi < mweeks.length && hitIdx < 0; mi++) {
      var mwv = mweeks[mi];
      if (mwv.short === wkk) { hitIdx = mi; continue; }
      var mo = mwv.mon;
      var ds = mo.getFullYear() + '-' + ('0' + (mo.getMonth() + 1)).slice(-2) + '-' + ('0' + mo.getDate()).slice(-2);
      if (ds === wkk) hitIdx = mi;
    }
    if (hitIdx < 0) { out.excludeMissed.push(ex.wh + ' / ' + ex.week + '（周标签未匹配）'); return; }
    if (!out.exclude[hitWh.name]) out.exclude[hitWh.name] = { idx: [], notes: [] };
    if (out.exclude[hitWh.name].idx.indexOf(hitIdx) < 0) {
      out.exclude[hitWh.name].idx.push(hitIdx);
      out.exclude[hitWh.name].notes.push((ex.note ? String(ex.note) : '未填原因') + '　【' + mweeks[hitIdx].short + '】');
    }
  });
  if (!out.whs.length) out.warn.push('未解析出任何前置仓行');
  return out;
}

// ---------- 未来需求（v409 新增）----------
// 🔴 需求覆盖改为「用未来周的计划」计算，不再用历史区间的 DP 均值。
//   口径：从「今天」起连续 D 天（D = 覆盖周数 × 7）落在哪些源表周桶里，就按【天数比例】切分该桶的
//        DP 共识计划值并累加 → 「覆盖期内究竟要出多少箱」。
//   例：今天 10/17、覆盖 1 周(7天) = 10/17~10/23 → 落在 10/12~10/18 的 2 天 + 10/19~10/25 的 5 天。
//   ⚠ 必须用【原始周桶 weeks】而不是合并周 mweeks：月切出来的 P1 段只有 1~6 天，
//     而合并周 ok 要求跨度=7，用它会丢掉月末那几天 → 覆盖期被截短。
//   ⚠ DP≤0 视为「无共识计划」跳过（武汉/成都/常州/嘉兴 长期为 0，不能当"需求为 0"）。
//   ⚠ 未来周不够覆盖 D 天时，用已覆盖部分的日均外推补齐，并标 extrapolated 供页面提示。
function samsFutureDemand(wh, D, st) {
  var ws = (st.data && st.data.weeks) || [];
  var p = wh.plan || [];
  var DAY = 86400000;
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var end = new Date(start.getTime() + D * DAY);
  var sum = 0, rawSum = 0, covDays = 0, parts = [];
  // 🔴 v438 补丁（同 samsDemandAxis）：全轴 DP 恒为 0 的仓（武汉/成都/常州/嘉兴）里，0 是「系统没排计划」，
  //   不能当成「确定无需求」——否则 covDays 会被 0 值段补满、ok 变 true、需求覆盖算成 0 箱、车数 0。
  //   判据：整条轴存在任一 >0 的 DP 才算"有在排计划"。
  var _hasPos = false;
  for (var q0 = 0; q0 < ws.length; q0++) {
    var _pv0 = p[q0];
    if (_pv0 != null && isFinite(_pv0) && _pv0 > 0) { _hasPos = true; break; }
  }
  for (var i = 0; i < ws.length; i++) {
    var w = ws[i];
    if (!w || !w.s || !w.e) continue;
    var wex = new Date(w.e.getFullYear(), w.e.getMonth(), w.e.getDate()).getTime() + DAY;
    var ovS = Math.max(start.getTime(), w.s.getTime());
    var ovE = Math.min(end.getTime(), wex);
    // 🔴 必须保留小数天：0.5 周 = 3.5 天，若 Math.round 会变 4 天 → 覆盖量虚高 ~14%
    var ovD = (ovE - ovS) / DAY;
    if (ovD <= 0) continue;
    var v = p[i];
    if (v == null || !isFinite(v)) continue;
    if (!_hasPos && v <= 0) continue;   // 全0轴：0 仍按「未排计划」跳过 → covDays 不足 → 回退 hist（保持 v438 之前行为）
    var perDay = v / (w.days || 7);
    rawSum += perDay * ovD;
    sum += perDay * ovD;
    covDays += ovD;
    parts.push({ lbl: w.short, v: Math.round(v), days: +ovD.toFixed(2), amount: Math.round(perDay * ovD) });
  }
  var extrapDays = 0;
  if (covDays > 0 && covDays < D) {
    extrapDays = D - covDays;
    sum += (rawSum / covDays) * extrapDays;
  }
  function md(d) { return (d.getMonth() + 1) + '/' + d.getDate(); }
  return {
    ok: covDays > 0,
    sum: sum, covDays: +covDays.toFixed(2), D: D,
    daily: covDays > 0 ? sum / D : 0,          // 覆盖期日均（含外推，分母恒为 D）
    rawDaily: covDays > 0 ? rawSum / covDays : 0,
    parts: parts, extrapDays: +extrapDays.toFixed(2), extrapolated: extrapDays > 0,
    startStr: md(start), endStr: md(new Date(end.getTime() - DAY))
  };
}

// ---------- 逐天需求速率轴（v421 新增）----------
// 🔴 为什么需要它：v420 及以前，`batchDays` / `needBoxes` 的分母是 `dUse` =「今天起 D 天的覆盖期日均」
//   （fut.daily）。但补货决策面向的是**到仓之后**那一段 —— 货在到仓日入库，从那天起才开始消耗它。
//   两段需求并不相同：DP 是按周排的，惠州/天津 10/26 那周（2,659 / 3,172 箱/天）比
//   10/19 那周（2,207 / 2,633）高 13.5%，而「今天起 7 天」窗口正好吃不到这次跳升。
//   用今天起 7 天的均值去量「到仓后能卖几天 / 该补多少」，会系统性偏松
//   （实测售罄天数高估约 1.5 天、需补量少约 1 车）。
//   解法：把 DP 周桶摊成【按天速率】的时间轴，起点可选（今天 / 到仓日），
//        然后「累计 n 天需求」「卖完 Q 箱要几天」都用**分段累加**求，不再用一次除法近似。
//   🔴 v438 语义反转（用户 2026-10-21 裁定：「改吧，需求是0的不用外推，就当是0」）：
//     v421 原先按「周桶 DP≤0 不等于需求为 0 —— 业务语义是'该周没排共识计划'」处理（沿用前一有效速率 + 标 extrap）。
//     实测反例推翻了该前提：惠州/天津 的「11月W1P2」桶（仅 11/01 一天，**2026-11-01 是周日**）DP 明确填 0，
//     而「10月W1P2 / 10月W2」这类未排计划的桶是**空白** —— 源表本身就区分「填 0」与「留空」。
//     旧判据把 0 也当空 → 11/01 被套用 10 月 W5P1 速率（惠州 2,659 箱/天）→ 既误标「外推 1.0」，
//     又让售罄天数少算约 1 天（那天实际不发货、不消耗）。
//     现改为：**0 = 已排计划且速率为 0**（不消耗库存、不算外推、计入已覆盖天数）；
//             null/空白 = 未排计划（仍沿用前一有效速率 + 标 extrap）。
//   ⚠ 前提依赖：源表用「空白」表示未排计划、用「0」表示确定无需求。若上游今后改用 0 表示"还没排"，
//     本判据必须回退，否则会把真正的计划缺口当 0 需求、低估补货量。
//   ⚠ 整条轴都没有有效速率（武汉/成都/嘉兴 计划长期为 0）→ 用历史日均兜底，
//     与 reqBasis='hist' 的历史回退口径一致；此时速率恒定，分段累加 ≡ 日均 × 天数，
//     数值与 v420 完全相同（这是保证老仓不受影响的关键）。
// v440: 新增第 5 参 histOnly —— 「按历史销售覆盖」口径下整条轴退化为恒定历史日均（见 samsRopAt 的 _histOnly）
function samsDemandAxis(wh, fromMs, st, fallbackDaily, histOnly) {
  var ws = (st.data && st.data.weeks) || [];
  var p = wh.plan || [];
  var DAY = 86400000;
  // 🔴 v438 补丁：区分「整条轴从没排过计划」与「排过计划但这几天为 0」
  //   武汉/成都/常州/嘉兴 整条轴 DP 恒为 0/空（上游没给共识计划）→ 这里的 0 必须理解为「系统无计划」，
  //   仍走 hist 历史回退；若跟着 v438 一起把 0 当"有计划的 0 需求"，会算出需求覆盖 0 箱、车数 0 —— 明显错。
  //   判据：整条轴存在任一 >0 的 DP ⇒ 该仓"有在排计划" ⇒ 0 值 = 确定无需求（保留 0）；
  //         否则 ⇒ 0 值 = 未排计划（置 null，沿用前速率/历史兜底）。
  var _hasPos = false;
  for (i = 0; i < ws.length; i++) {
    var _pv = p[i];
    if (_pv != null && isFinite(_pv) && _pv > 0) { _hasPos = true; break; }
  }
  var items = [], w;
  for (i = 0; i < ws.length; i++) {
    w = ws[i];
    if (!w || !w.s || !w.e) continue;
    items.push({
      s: new Date(w.s.getFullYear(), w.s.getMonth(), w.s.getDate()).getTime(),
      e: new Date(w.e.getFullYear(), w.e.getMonth(), w.e.getDate()).getTime() + DAY,
      v: (p[i] != null && isFinite(p[i]) && (_hasPos || p[i] > 0)) ? (p[i] / (w.days || 7)) : null,   // v438: 有在排计划时 0 值保留为「速率0」；全0轴仍置 null
      lbl: w.short
    });
  }
  items.sort(function (a, b) { return a.s - b.s; });
  // 🔴 v440：基准口径＝「按历史销售覆盖」时，把每个周桶的 DP 速率抹掉（置 null），
  //   于是下方 last 只会取 fallbackDaily(= 历史窗口日均 d) ⇒ 整条轴是恒定速率 d，src 全为 'hist'、不算外推。
  //   目的：让「覆盖天数目标水位 / 补货车数 / 售罄天数 / 免租上限线」与「预警线」用同一口径（历史销售），
  //   而不是预警线看历史、车数偷偷看未来 DP（v439 及以前的错配，用户 2026-10-26 指出）。
  if (histOnly) { for (i = 0; i < items.length; i++) items[i].v = null; }
  // 🔴 三种速率来源必须分开，否则「外推天数」会虚报：
  //   dp    = 该周桶有真实 DP 计划 → 直接用
  //   carry = 该周桶没排计划，沿用**之前某个真实 DP** 的速率 → 这才是真正的"外推"
  //   hist  = 整条轴都没有 DP，靠历史日均兜底 → 属「历史回退」，页面已有 reqBasis 标注，不能再算外推
  //   （v421 首版没区分 hist，导致 武汉/成都/嘉兴 的"外推天数"等于整个售罄天数，读起来像全在瞎猜）
  var fbv = (fallbackDaily != null && isFinite(fallbackDaily) && fallbackDaily > 0) ? fallbackDaily : null;
  var last = fbv, lastIsFb = (fbv != null);
  var segs = [];
  for (i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.v != null) { last = it.v; lastIsFb = false; }
    if (it.e <= fromMs) continue;      // 整桶在起点之前 → 只用来确定「前一个有效速率」
    if (last == null) continue;        // 起点之前既无 DP 也无兜底 → 该段无法定价，跳过
    segs.push({
      s: Math.max(it.s, fromMs), e: it.e, r: last, lbl: it.lbl,
      src: (it.v != null) ? 'dp' : (lastIsFb ? 'hist' : 'carry'),
      extrap: (it.v == null && !lastIsFb)
    });
  }
  var tailExtrap = !lastIsFb;
  // ===== v458（用户 2026-11-05 裁定·规则②）：越界外推改用「DP 覆盖期加权均值」=====
  //   旧：tail 沿用**最后一段** DP 速率无限延伸。最后一桶往往是促销周（实测天津 11/16~22 为
  //       1,304 箱/天，比前一周 931 高 40%），拿它外推 10~17 天会把售罄天数系统性算短。
  //   新：tail 速率 = 自轴起点起、DP 已覆盖区间内按天数加权的平均速率（仍属「未来口径」，不掺历史）。
  //   若整条轴没有任何 DP 段（武汉/成都/嘉兴 走历史兜底）→ dpAvg 为 null，tail 仍用 last（= 历史日均），行为不变。
  //   同时把「DP 覆盖终点 / 覆盖天数 / 加权均值」一并暴露给展示层，用于「确定 X 天 · 计划外 Y 天」的拆解。
  var dpSum = 0, dpDays = 0, dpEnd = null;
  for (i = 0; i < segs.length; i++) {
    var _ds = segs[i];
    if (_ds.src !== 'dp' || !(_ds.r > 0)) continue;
    var _dd = (_ds.e - _ds.s) / DAY;
    dpSum += _ds.r * _dd; dpDays += _dd;
    if (dpEnd == null || _ds.e > dpEnd) dpEnd = _ds.e;
  }
  var dpAvg = (dpDays > 0) ? (dpSum / dpDays) : null;
  var tailRate = (tailExtrap && dpAvg != null) ? dpAvg : last;
  return {
    from: fromMs, segs: segs, ok: (last != null), fallback: (fallbackDaily != null ? fallbackDaily : null),
    dpAvgRate: dpAvg,      // DP 覆盖期加权均值（箱/天）；无 DP 段时为 null
    dpDays: dpDays,        // DP 实际覆盖天数（自轴起点起，仅 src='dp' 段）
    dpEndMs: dpEnd,        // DP 覆盖终点（毫秒）；无 DP 时为 null
    // 尾部：最后一个速率无限延伸（售罄天数超出 DP 覆盖时靠它；hist 兜底时不算外推）
    tail: (last != null)
      ? { s: (segs.length ? segs[segs.length - 1].e : fromMs), e: Infinity, r: tailRate, extrap: tailExtrap,
          src: (lastIsFb ? 'hist' : 'extrap'), lbl: '外推', usedAvg: !!(tailExtrap && dpAvg != null) }
      : null
  };
}
// 从轴起点起 n 天的累计需求
function samsCumAt(ax, n) {
  if (!ax || !ax.ok || !(n > 0)) return 0;
  var DAY = 86400000;
  var all = ax.segs.slice();
  if (ax.tail) all.push(ax.tail);
  var end = ax.from + n * DAY, q = 0, i, sg, s, e;
  for (i = 0; i < all.length; i++) {
    sg = all[i];
    if (!(sg.r > 0)) continue;
    s = Math.max(sg.s, ax.from);
    e = Math.min(sg.e, end);
    if (e > s) q += sg.r * (e - s) / DAY;
  }
  return q;
}
// 从轴起点起，卖完 Q 箱要几天 → { days, extrapDays }
//   extrapDays = 其中有多少天落在「DP 未覆盖、靠最后一档速率外推」的区间里（诚实标注用）
function samsDaysToQ(ax, Q) {
  if (!ax || !ax.ok || !(Q > 0)) return { days: null, extrapDays: 0 };
  var DAY = 86400000;
  var all = ax.segs.slice();
  if (ax.tail) all.push(ax.tail);
  var cum = 0, ext = 0, cursor = ax.from, i, sg, s, e, cap;
  for (i = 0; i < all.length; i++) {
    sg = all[i];
    s = Math.max(sg.s, cursor);
    e = sg.e;
    if (e <= s) continue;
    if (!(sg.r > 0)) { cursor = e; continue; }     // 无需求段：只推进时间
    cap = sg.r * (e - s) / DAY;
    if (cum + cap >= Q) {
      var d = (Q - cum) / sg.r;
      if (sg.extrap) ext += d;
      return { days: (s - ax.from) / DAY + d, extrapDays: ext };
    }
    cum += cap;
    if (sg.extrap) ext += (e - s) / DAY;
    cursor = e;
  }
  return { days: null, extrapDays: 0 };
}
// 从轴起点起，卖完 Q 箱要几天 —— **只算 DP 已排计划的区间**（不含任何外推）
//   v458（用户 2026-11-05）：用于卡片展示「其中 确定 X 天 · 计划外 Y 天」。
//   语义：到 DP 覆盖终点为止，若货已卖完 → exact=true，days 就是精确值（此时不存在计划外部分）；
//        若没卖完 → exact=false，days 只代表「已确定能撑的天数」= DP 覆盖天数，剩余天数全靠外推。
//   ⚠ 遇到第一个非 dp 段（空白周 carry / 历史兜底）即停 —— 那之后已经不属于「确定」区间。
function samsDaysFixed(ax, Q) {
  if (!ax || !ax.ok || !(Q > 0)) return { days: null, exact: false, coveredDays: 0 };
  var DAY = 86400000, cum = 0, covered = 0, cursor = ax.from, i, sg, s, e, cap;
  for (i = 0; i < ax.segs.length; i++) {
    sg = ax.segs[i];
    if (sg.src !== 'dp') break;
    s = Math.max(sg.s, cursor);
    e = sg.e;
    if (e <= s) continue;
    covered += (e - s) / DAY;
    if (!(sg.r > 0)) { cursor = e; continue; }
    cap = sg.r * (e - s) / DAY;
    if (cum + cap >= Q) {
      return { days: (s - ax.from) / DAY + (Q - cum) / sg.r, exact: true, coveredDays: covered };
    }
    cum += cap;
    cursor = e;
  }
  return { days: covered, exact: false, coveredDays: covered };
}

// ---------- 逐仓预警线测算 ----------
// 依赖：st.win(历史窗口) / st.coverW(覆盖周数) / st.basis(基准口径) / st.car / st.freeDays
// 🔴 只吃「合并后的真实自然周」且跨度必须 = 7 天（部分周不参与统计，避免量纲混杂）
function samsRopAt(wh, coverW, st) {
  var mw = (st.data && st.data.mweeks) || [];
  // 🔴 异常周剔除：只影响「参与统计的周」（周均/σ/上沿/DP 均值），
  //    图1 仍照常显示该周（半透明+红框标出），数据绝不隐藏 —— 剔除是可解释、可退的。
  var exRec = (st.useExclude && st.data && st.data.exclude && st.data.exclude[wh.name]) ? st.data.exclude[wh.name] : null;
  var exSet = {};
  if (exRec) exRec.idx.forEach(function (k) { exSet[k] = 1; });
  var a = wh.actualM || [], p = wh.planM || [], i, vals = [], vIdx = [];
  for (i = 0; i < a.length; i++) if (a[i] != null && mw[i] && mw[i].ok && !exSet[i]) { vals.push(a[i]); vIdx.push(i); }
  var use = st.win > 0 ? vals.slice(-st.win) : vals;
  var useIdx = st.win > 0 ? vIdx.slice(-st.win) : vIdx;
  // v441: 折算周（跨月拆段单段缺数按天折算，见 samsLoad 的 _samsMergeWeek）只进「周均」，
  //   **不进 σ / 周上沿** —— 3 天折成 7 天放大 2.33 倍，若让它进峰值法会造出假峰值、把安全库存顶高
  //   （实测成都 9/28~10/4 折算后 8,526，远超其真实周 2,000~4,700，会成为假"最高周"）。
  var estMap = wh.estWeeks || {}, useReal = [];
  for (i = 0; i < use.length; i++) {
    if (!estMap[useIdx[i]]) useReal.push(use[i]);
  }
  var sH = samsStat(use);
  var W_hist = sH.mean;
  var d = W_hist / 7;
  var sHReal = samsStat(useReal);               // σ 只用真实周（无折算）
  var sdD = sHReal.sd / Math.sqrt(7);
  var D = coverW * 7;
  var hiW = useReal.length ? Math.max.apply(null, useReal) : (use.length ? Math.max.apply(null, use) : 0);
  var upGapDay = Math.max(0, hiW / 7 - d);      // 上行缺口（箱/天）
  // v449: 「已 N 天无新周」提示已按用户要求删除，histStaleDays 计算随之移除（只保留最新有效周标签本身）
  var lastOkIdx = useIdx.length ? useIdx[useIdx.length - 1] : -1;
  var ss1 = samsProbit(st.csl) * sdD * Math.sqrt(D);   // ① 统计法：F⁻¹(csl) × σ日 × √覆盖天数（z 随服务水平走，默认 95%→1.6449）
  var ss2 = SAMS_SSU * upGapDay * D;   // ② 峰值法：SAMS_SSU × 上行缺口(箱/天) × 覆盖天数（情景口径，不随服务水平 z 变；v436 起 SAMS_SSU=1.0）
  var ss = Math.max(ss1, ss2);
  var ssPick = ss2 > ss1 ? '峰值法' : '统计法';  // 取大者（用于展示"安全库存是怎么来的"）
  var ropHist = d * D + ss;

  var pv = [];
  for (i = 0; i < p.length; i++) if (p[i] != null && p[i] > 0 && mw[i] && mw[i].ok && !exSet[i]) pv.push(p[i]);
  var sP = samsStat(pv);
  var W_plan = sP.mean;                          // 历史区间的 DP 均值（v409 起仅作对照展示）

  // ===== v409: 【第一段】需求覆盖改用「未来周」 =====
  //   old: 基准日均（计划优先/历史回退的周均÷7）× 覆盖天数
  //   new: 未来 D 天内各周桶的 DP 计划按天数比例累加（samsFutureDemand）
  //   ⚠ 无未来 DP（武汉/成都/常州/嘉兴 长期为 0）→ 回退历史日均 × D（= 原口径），页面标注「历史回退」
  var fut = samsFutureDemand(wh, D, st);
  var reqBasis, dUse, reqCover;
  if (!fut.ok || st.basis === 'hist') {
    dUse = d; reqCover = d * D; reqBasis = 'hist';
  } else if (st.basis === 'max' && d >= fut.daily) {
    dUse = d; reqCover = d * D; reqBasis = 'hist';
  } else {
    dUse = fut.daily; reqCover = fut.sum; reqBasis = 'future';
  }
  var k = d > 0 ? dUse / d : 1;                   // 未来日均 ÷ 历史日均 → 安全库存同比例缩放
  var W_use = dUse * 7;                           // 基准周均（兼容旧字段 / 明细表 / CSV）
  // ===== 预警线的完整组成 =====
  var ssFinal = ss * k;                           // 【第二段】安全库存（按需求倍率等比缩放）
  var rop = reqCover + ssFinal;                   // = 两段之和

  // v409: 「最新周实际」= 最新一个有实际数据的自然周（**含进行中的本周**，页面会标"进行中"）。
  //       不能再用 ok 判据 —— running 周 ok=false，会把最新周退回两周前，用户看不懂。
  var lastIdx = -1;
  for (i = a.length - 1; i >= 0; i--) if (a[i] != null && mw[i]) { lastIdx = i; break; }
  var firstIdx = -1;
  for (i = 0; i < a.length; i++) if (a[i] != null && mw[i] && mw[i].ok) { firstIdx = i; break; }

  // 🔴 免租合规：6 仓统一「入库起 freeDays 天内须完成售罄」，所以天数**从到仓起算**（v408 修正）。
  //   假设下单时库存正好在预警线水位，经 lead 天到仓 → 到仓时的在库 = 预警线 − 日均 × lead。
  //   实际单批售罄 = (到仓时在库 + 建议批量 N 车) ÷ 日均（v411 起 N 由目标天数倒推，不再固定 1 车）。
  //   另保留「静态值（从下单起算、不扣时效）」作为**保守上界**对照展示。
  var _leadKey = samsWhShort(wh.name);
  var leadKnown = !!(SAMS_LEAD && SAMS_LEAD[_leadKey] != null);
  var lead = leadKnown ? SAMS_LEAD[_leadKey] : 0;
  // ===== v421: 【两个时点分开】预警线用「今天起」，补货决策用「到仓后」 =====
  //   - 预警线 rop 回答「今天该有多少库存」→ 用今天起 D 天的需求（上面的 reqCover + ss×k，口径未变）
  //   - 补货决策（需补量 / 车数 / 售罄天数 / 再下单间隔 / 免租上限线）回答「到仓后这批货撑多久、补多少」
  //     → 货在到仓日入库，从那天起才消耗它 ⇒ 必须用【到仓日起】的逐段实际需求
  //   这两条轴只在「需求恒定」时重合；DP 按周排、且到仓后可能跨进更高的一周时就会分叉。
  var _now0 = new Date();
  var _todayMs = new Date(_now0.getFullYear(), _now0.getMonth(), _now0.getDate()).getTime();
  var _arrMs = _todayMs + lead * 86400000;                    // 到仓日
  // 🔴 兜底：无未来 DP（fut.ok=false，如武汉/成都/嘉兴）→ 传历史日均 d，与 reqBasis='hist' 同源
  // ===== v440: 【口径贯穿】基准口径＝按历史销售覆盖时，逐天需求轴也走历史 =====
  //   背景（用户 2026-10-26）：「增加一个按历史销售覆盖未来天数的计算方式…要求历史销售区间和
  //   预警线水位的计算对齐」。实测 v439 及以前的错配（惠州·近8周）：
  //     预警线 10,956（历史口径）｜目标水位 26,970（仍走未来 DP）→ 需补 16,014 → 3 车
  //   ⇒ 预警线看历史、车数却看未来 DP，等于"选了只看历史也没用"。根因：basis 只进了 reqCover，
  //     没进 samsDemandAxis。现按 reqBasis 反向贯穿（reqBasis 已含 plan/max 的判定结果，
  //     故 plan 模式在无未来 DP 时也自动落到历史恒定轴，与原来的 _fb 兜底等价）。
  var _histOnly = (reqBasis === 'hist');
  var _fb = _histOnly ? d : (fut.ok ? null : d);
  var axToday = samsDemandAxis(wh, _todayMs, st, _fb, _histOnly);
  var axArr   = samsDemandAxis(wh, _arrMs,   st, _fb, _histOnly);
  var leadDemand = samsCumAt(axToday, lead);                 // 今天→到仓 这几天的实际消耗
  var dArrDaily = D > 0 ? samsCumAt(axArr, D) / D : dUse;    // 到仓日起 D 天的日均（展示/对照用）
  var arrDateStr = (function () { var q = new Date(_arrMs); return (q.getMonth() + 1) + '/' + q.getDate(); })();
  // ===== v420: 【期初库存】当前库存输入口（口径不变，只是消耗量改成分段实际值）=====
  //   到仓时在库 = 当前库存 − 「今天→到仓」这段的实际消耗（原来是 dUse × lead）。
  var _csRaw = (st.curStock && st.curStock[_leadKey] != null) ? Number(st.curStock[_leadKey]) : null;
  var curKnown = (_csRaw != null && isFinite(_csRaw) && _csRaw >= 0 && st.curStock[_leadKey] !== '');
  var curStock = curKnown ? _csRaw : rop;                    // 下单时在库（实填 / 假设=预警线）
  var stockSrc = curKnown ? 'actual' : 'assumed';
  var stockAtArrival = Math.max(0, curStock - leadDemand);   // 到仓时的在库旧货水位
  var stockoutRisk = leadDemand > curStock;                  // 到货前就断货 ⇒ 覆盖天数不足以覆盖时效
  var gapVsRop = curStock - rop;                             // 当前库存相对预警线的缺口（<0 = 已低于预警线）
  var curStockDays = dUse > 0 ? curStock / dUse : 0;         // 当前库存还能撑几天（不含在途/在产）
  var dropDays = dUse > 0 ? rop / dUse : 0;                  // 预警线折合天数（今天起口径：= 覆盖天数 + 安全库存天数）

  // ===== v434：目标售罄天数算法已删除（用户 2026-10-18 裁定），以下为历史记录 =====
  //   v411~v433 曾有第二入口：needBoxes = 到仓后 targetDays 天需求 − 到仓时在库；byTarget = ⌈needBoxes ÷ 整车⌉。
  //   与覆盖天数的关系（v428 实测）：不含 ss 时 D=7 逐仓等价（6 车 = 6 车）；含 ss 后 cover 给 9 车，
  //   未填库存时给 0 车（当前库存 = 预警线 = 覆盖 7 天目标水位，已够）。
  //   结构性下限 minCarHold 与 byTarget 仅对 target 口径有意义，一并移除；ropGap 仍保留（信息字段）。
  var ropGap = rop - stockAtArrival;                         // 到仓时水位距预警线的缺口（<0 = 已高于预警线）
  // ===== v426（历史记录，机制已随 v434 删除）=====
  //   当时「目标天数优先」拆掉了预警线地板（minCarHold/byTarget 链），并要求把「补完仍欠预警线」的后果
  //   用 underRop / underRopDays / floorUnused 量化展示。v434 起 target 口径整体移除，这三个量恒为 0/false，
  //   仅保留返回字段供兼容，不再参与任何展示。
  // ===== v428: 【覆盖天数】目标库存口径，v434 起为唯一算法（预警线不动）=====
  //   用户 2026-10-18「加入另一套算法，用覆盖周期作为目标库存推算补货量，我可以给你一个覆盖天数，比如14天」
  //   → ①含安全库存 ②与 targetDays 并存、切换，预警线定义不动。
  //   v429 起算点改为【今天起】：用户 2026-10-18 追问「覆盖天数 7 = 覆盖周数 1 周，那目标库存应该等于预警线，应该 1 箱也不补？」
  //   → 核实：需求平稳的仓确实等于预警线（武汉/成都/嘉兴 差 0），但惠州/天津差 +2,055/+2,448，
  //     原因是「今天起 7 天」与「到仓起 7 天」是两个窗口（到仓日已跨进更高一周，日均 2,172→2,466，+13.5%）。
  //   用户裁定「改成今天起算」→ 覆盖 D 天的目标水位 = samsCumAt(axToday, D) + ssFinal
  //     ⇒ D = 覆盖周数×7 时**精确退化成预警线本身**（两个旋钮合成一个），语义最干净。
  //   代价（已知并接受）：补货车 5 天后才到仓，那 7 天窗口已后移，到仓后实际需求 17,259 > 今天起 15,204，
  //     所以"补到今天的预警线"在到仓那天缓冲会薄 2,055 箱（≈0.8 天）——补完仍 ≥ 到仓日的预警线是运气，不是保证。
  var coverDays = (st.coverDays > 0) ? st.coverDays : 14;
  var coverDemandArr = samsCumAt(axToday, coverDays);        // v429：今天起 coverDays 天的累计需求（原 axArr）
  // v431：安全库存口径改为「跟随覆盖天数」（原跟随 覆盖周数×7）。
  //   ss 在两处复用：①预警线(rop) 仍用 D = 覆盖周数×7（口径不动，见 L2960）；②覆盖目标用 D = 覆盖天数。
  //   两者仅在「覆盖天数 ≠ 覆盖周数×7」时不同；对齐时（覆盖天数 = 覆盖周数×7）两式逐字相等。
  //   sdD = σ日、upGapDay = 上行缺口(箱/天)、k = 未来日均÷历史日均（同比例缩放），均来自上方 samsRopAt 作用域。
  var ss1c = samsProbit(st.csl) * sdD * Math.sqrt(coverDays);     // ① 统计法：F⁻¹(csl) × σ日 × √覆盖天数
  var ss2c = SAMS_SSU * upGapDay * coverDays;     // ② 峰值法：SAMS_SSU × 上行缺口 × 覆盖天数（情景口径；v436 起 SAMS_SSU=1.0）
  var ssc = Math.max(ss1c, ss2c);
  var ssPickC = ss2c > ss1c ? '峰值法' : '统计法';
  var ssFinalC = ssc * k;                                     // 按需求倍率 k 同比例放大
  var coverTarget = coverDemandArr + ssFinalC;                // 目标库存水位（含安全库存，安全库存按覆盖天数定）
  var coverNeed = Math.max(0, coverTarget - curStock);        // v430：减【当前库存】（今天时点），原为 stockAtArrival
  // ⚠ 浮点/路径容差：coverTarget 走 samsCumAt（按天分段累加），rop 走 samsFutureDemand（按周桶比例摊），
  //   两条路径在周界上可能差 ±1 箱（实测嘉兴 7,699 vs 7,700）。若不吸收，就会出现「需补 0 箱却给 1 车」
  //   —— 因为 ⌈1 ÷ 5,568⌉ = 1。缺口 ≤2 箱（相对整车 5,568 可忽略）一律视为已覆盖。
  if (coverNeed <= 2) coverNeed = 0;
  // 🔴 v430 修正（用户 2026-10-18「减库存当然是目前的在库库存，怎么可能用到仓时在库？」）：
  //   v429 把目标水位改成「今天起 D 天需求 + ss」后，减数却仍是「到仓时在库」→ **两个时点错配**：
  //     目标水位回答「今天该有多少库存」，减数却是 5 天后的库存 ⇒ 把「路上这几天卖掉的那批货」又补了一遍。
  //   惠州实测：目标 36,558 − 到仓 7,604 = 28,953（6 车），但今天库存 18,394 已经承担了路上 10,790 的消耗，
  //     正确缺口是 36,558 − 18,394 = 18,164（4 车）；前者多补 10,790 箱，正好等于路上消耗。
  //   守恒式：当前库存 + 补货 ≥ 今天起 D 天需求 + ss（当前库存前 5 天被消耗，剩余部分与补货合并支撑后续）⇒ Q ≥ target − curStock。
  //   ⚠ target 模式仍减 stockAtArrival —— 因为它的目标水位是「到仓后 D 天需求」，时点在到仓日，两者匹配。
  // v444（用户 2026-10-29）：最小起补量门槛 —— 缺口 < minCarRatio × 整车 → 本批不补（0 车）。
  //   原实现只有 ⌈缺口 ÷ 整车⌉，浮点容差 2 箱 ⇒「需补 200 箱也发一整辆车 5,568 箱」（多补 27 倍）。
  //   实测（2026-10-29，覆盖 14 天口径，tools/probe-sams-round-ab.cjs + probe-sams-floor1000-ab.cjs）：
  //     · 库存未填（按预警线）时 5 仓缺口 3,480~10,632 箱全在门槛之上 → 车数不变（8 车）；
  //     · 库存已填、缺口 200 / 700 箱时，原来各给 1 车 → 现在 0 车，每仓省 5,568 箱。
  //   ↩️ 为什么不是「1,000 箱」硬门槛：1,000 箱在 5,568 箱/车下仅 0.18 车，缺口 1,000~2,700 箱
  //      仍然发 1 车（多补 4,568~2,784 箱），基本不解决问题；按车的倍数才可随整车参数自动适配。
  var _minCarRatio = (isFinite(st.minCarRatio) && st.minCarRatio >= 0) ? st.minCarRatio : 0.5;
  var minCarBoxes = st.car > 0 ? st.car * _minCarRatio : 0;
  // ===== v447（用户 2026-11-03 裁定）：最小起补量改为「零头进位门槛」，对所有不满整车的零头统一生效 =====
  //   旧（v444）：只判第一车 —— 缺口 < ratio×整车 → 0 车；一旦过线，后续一律 ⌈⌉ 进位。
  //     后果（用户 2026-11-03 截图）：武汉需补 5,742 箱（=1.031 车），只超整车 174 箱(3.1%)，却因 ⌈1.031⌉=2 车，
  //     多补 5,394 箱、装载率只有 51.6%；5 仓合计 35,362 箱（6.35 车）却要 10 车，闲置 36.5%。
  //   新：取整前先看「小数部分」—— whole = ⌊缺口 ÷ 整车⌋，frac = 小数部分；
  //     frac ≥ ratio → 进位（多开一车）；frac < ratio → 舍去（用 whole 车）。
  //   当 whole = 0 时 frac 就是全部缺口 ⇒ 自然退化为原「起补门槛」语义（缺口不足门槛 → 0 车），
  //     即一条规则同时管住第一车与后续每一车的零头，不需要两套逻辑。
  //   实测（2026-11-03，覆盖 14 天 / 库存未填 / 整车 5,568 / ratio 0.5）：
  //     惠州 6,205 → 2→1 车（零头 637=11.4%）、天津 8,664 → 2 车（零头 3,096=55.6%）、
  //     武汉 5,742 → 2→1 车（零头 174=3.1%）、成都 3,480 → 1 车（零头 3,480=62.5%）、
  //     嘉兴 11,271 → 3→2 车（零头 135=2.4%）；合计 10 → 7 车。
  //   ⚠ 代价：被舍去零头的仓本批会欠补（武汉少 174 箱），到仓后售罄天数略短 —— 用户明确选择的取舍。
  var coverByTarget;
  if (st.car > 0) {
    if (!(coverNeed > 0)) {
      coverByTarget = 0;
    } else {
      var _carQ = coverNeed / st.car;
      var _carWhole = Math.floor(_carQ + 1e-9);       // 1e-9 容差：防 2.0 被浮点切成 1.9999999 → 少发一车
      var _carFrac = _carQ - _carWhole;
      coverByTarget = (_carFrac >= _minCarRatio - 1e-9) ? (_carWhole + 1) : _carWhole;
      if (coverByTarget < 0) coverByTarget = 0;
    }
  } else {
    coverByTarget = 1;
  }
  // v434：覆盖天数为唯一算法，生效口径即 cover 口径（原 target 分支已删）
  var byTargetEff = coverByTarget;
  var needEff = coverNeed;
  var targetDaysEff = coverDays;
  var targetDemandEff = coverTarget;
  var nCar = byTargetEff;
  var noCar = (nCar === 0);                                  // 本批不补：到仓在库已覆盖目标口径的需求
  // v444：0 车有两种成因，展示层必须区分，否则会出现「需补 5,000 箱却写『本批无需补货』」的错文案：
  //   ① coverNeed = 0        → 当前库存已覆盖目标水位（原语义）
  //   ② coverNeed < 起补线    → 缺口太小、凑不成有意义的一车（v444 新增）
  var noCarByFloor = noCar && coverNeed > 0;
  var batchBoxes = nCar * st.car;                            // 建议单批补货量（箱）
  // ===== v421: 天数全部改「分段累加求解」，不再做除法近似 =====
  var _qArr = stockAtArrival + batchBoxes;                   // 到仓后的总可售量
  var _bd = samsDaysToQ(axArr, _qArr);                       // 实际（入库起算）
  var batchDays = _bd.days;
  var batchDaysExtrap = _bd.extrapDays;                      // 其中靠外推的天数（DP 未覆盖）
  var batchDaysCons = samsDaysToQ(axToday, rop + batchBoxes).days;   // 保守（下单起算，假设下单时=预警线）
  // ===== v458：「确定 X 天 · 计划外 Y 天」拆解（仅未来计划口径下有边界概念）=====
  //   历史口径下整条轴是恒定历史日均、可无限延伸，不存在"计划覆盖到哪天" → batchDaysFixed 置 null，卡片不拆。
  var _bdFix = samsDaysFixed(axArr, _qArr);
  var batchDaysFixed = (reqBasis === 'future' && _bdFix.days != null) ? _bdFix.days : null;
  var batchDaysFixedExact = !!_bdFix.exact;                  // true = 在 DP 覆盖区内就卖完了（无计划外部分）
  var extrapRate = axArr.dpAvgRate;                          // 越界外推用的加权均值（箱/天）
  var dpEndStr = axArr.dpEndMs ? ((new Date(axArr.dpEndMs - 86400000).getMonth() + 1) + '/' + new Date(axArr.dpEndMs - 86400000).getDate()) : '';
  // 再下单间隔（v434 起唯一口径）：到仓日已过去 lead 天，覆盖期还剩 coverDays − lead 天要覆盖；
  //   本批水位能撑 batchDays 天，差额就是可以推迟下单的天数。
  //   （v430 起 cover 口径的定义；target 口径的「到货后降回预警线」定义随算法删除一并移除。）
  var _covRest = Math.max(0, coverDays - lead);
  var cycleDays = (batchDays == null) ? null : Math.max(0, batchDays - _covRest);
  var cycleShort = false;
  // ===== v426 的「补完仍欠预警线 / 地板未采用」量化：v434 起 target 模式删除，恒为 0/false（字段保留避免展示层报错）=====
  //   cover 的目标是「今天起 D 天覆盖」，不是「到仓日补到预警线」——补完后到仓水位低于预警线是必然的，
  //   「补完仍欠 X 箱」这类提示在 cover 口径下不成立（v430 已论证）。cover 真正的风险只有两个：
  //   ①到货前断货（stockoutRisk）②批量超免租（batchOk），两者都已存在。
  var arrAfter = _qArr;                                      // 补完（到仓后）水位 = 到仓在库 + 建议批量
  var underRop = 0;
  var underRopDays = 0;
  var floorUnused = false;
  // v428：覆盖天数 < 运输时效 ⇒ 这批货卖完时下一批还没到仓，物理上无法不间断供应
  var leadShort = !!(leadKnown && coverDays < lead);
  var carAloneDays = samsDaysToQ(axArr, batchBoxes).days;    // 这批货自身能卖几天（不含旧货）
  // 🔴 兜底：轴不可用（该仓连历史日均都为 0）时退回旧的除法口径，避免展示层拿到 null 直接崩
  //   v425：batchBoxes = 0（本批不补）时 samsDaysToQ 因 Q>0 判定返回 null → 不能再回落成 0 天
  //         （"这批货能卖 0 天"是错信息），保持 null 让展示层统一显示「—」。
  if (carAloneDays == null) carAloneDays = (batchBoxes > 0 && dUse > 0) ? batchBoxes / dUse : null;
  var arrivalStockDays = stockAtArrival > 0 ? samsDaysToQ(axArr, stockAtArrival).days : 0;
  if (arrivalStockDays == null) arrivalStockDays = dUse > 0 ? stockAtArrival / dUse : 0;
  // 免租上限线 = 「今天起 freeDays + lead 天」能卖掉的量 − 批量 = 预警线的合规天花板
  var ropCapFree = (st.freeDays + lead) > 0 ? samsCumAt(axToday, st.freeDays + lead) - batchBoxes : null;

  return {
    name: wh.name, short: samsWhShort(wh.name), code: wh.code, meta: wh.meta,
    nUse: use.length,
    // v441: 历史窗口有效周元信息 → 卡片显示「统计口径最新有效周 X」
    //   v449: 原来的「已 N 天无新周」「含 N 个折算周」两条提示按用户 2026-11-03 要求删除，
    //   对应字段（histStaleDays / nEst / estLbls / nEstZero / nEstExtrap）一并清掉，不留死代码。
    histLastLbl: (lastOkIdx >= 0 && mw[lastOkIdx]) ? mw[lastOkIdx].short : '',
    W_hist: W_hist, sdW: sH.sd, d: d, sdD: sdD, hiW: hiW, upGapDay: upGapDay,
    D: D, ss1: ss1, ss2: ss2, ss: ss, ssPick: ssPick, ropHist: ropHist,
    W_plan: W_plan, nPlan: pv.length,
    W_use: W_use, k: k, rop: rop, dUse: dUse,
    reqCover: reqCover, ssFinal: ssFinal,
    reqBasis: reqBasis, fut: fut, W_future: fut.ok ? fut.daily : 0,
    // v440: 口径来源标注 —— future=用未来DP / chosen=用户选了「按历史销售覆盖」/ fallback=无未来DP被迫历史回退
    //   展示层必须区分 chosen 与 fallback，否则用户选了历史口径却被标成「历史回退」，会以为系统又偷偷用了 DP。
    basisWhy: (reqBasis === 'future') ? 'future' : (st.basis === 'hist' ? 'chosen' : 'fallback'),
    // 🔴 折合天数必须除以「基准日均」(W_use/7) 而非历史日均：rop 已按 k 缩放，
    //    若再除以历史 d 会把调整系数重复计入（惠州 会算成 16.3 天而不是 14.9 天）
    dropDays: dropDays,
    reqCoverDays: D,
    ssDays: dUse > 0 ? ssFinal / dUse : 0,          // 安全库存折合天数
    batchDays: batchDays,                 // 实际（入库起算，已扣时效）· 分段累加求解
    batchDaysExtrap: batchDaysExtrap,     // 其中靠「DP 未覆盖外推」的天数（诚实标注）
    // v458：把「确定 / 计划外」拆开 —— 确定 = DP 已排计划区间内算得死的天数；计划外 = batchDaysExtrap
    batchDaysFixed: batchDaysFixed,               // DP 覆盖区间内能撑的天数（历史口径下为 null）
    batchDaysFixedExact: batchDaysFixedExact,     // true = DP 覆盖区内就售罄，无计划外部分
    extrapRate: extrapRate,                       // 越界外推所用的 DP 覆盖期加权均值（箱/天）
    dpEndStr: dpEndStr,                           // DP 覆盖截止日（M/D），无 DP 时为空
    batchDaysCons: batchDaysCons,         // 保守上界（下单起算，不扣时效）
    batchOk: batchDays != null && batchDays <= st.freeDays,
    // v434: 补货车数（唯一算法 = 覆盖天数；原 target 字段已删）
    nCar: nCar, batchBoxes: batchBoxes,
    coverDays: coverDays, coverDemandArr: coverDemandArr, coverTarget: coverTarget,
    ss1c: ss1c, ss2c: ss2c, ssc: ssc, ssPickC: ssPickC, ssFinalC: ssFinalC,   // 覆盖目标用的安全库存（按覆盖天数定）
    coverNeed: coverNeed, coverByTarget: coverByTarget,
    byTargetEff: byTargetEff, needEff: needEff, targetDaysEff: targetDaysEff,
    targetDemandEff: targetDemandEff,   // 目标水位 = 覆盖 coverDays 天需求 + 安全库存（今天起算）
    // v425: 0 车（本批无需补货）相关
    noCar: noCar,                         // true = 本批不补（两种成因，用 noCarByFloor 区分）
    // v444：最小起补量门槛。noCarByFloor=true 表示 0 车来自「缺口未达起补量」而非「已覆盖目标」
    minCarRatio: _minCarRatio, minCarBoxes: minCarBoxes, noCarByFloor: noCarByFloor,
    ropGap: ropGap,                       // 到仓时水位距预警线的缺口
    // v426: 目标天数优先 → 地板拆掉后的风险量化
    underRop: underRop,                   // 补完仍低于预警线多少箱（>0 = 到货当天就该再下单）
    underRopDays: underRopDays,           // 上述缺口折合天数（到仓后日均口径）
    floorUnused: floorUnused,             // 预警线地板本可给更多车，按"目标天数优先"未采用
    leadShort: leadShort,                 // 目标天数 < 运输时效 ⇒ 物理上无法不间断供应
    arrAfter: arrAfter,                   // 补完（到仓后）水位 = 到仓在库 + 建议批量
    // v421: 需求时点解耦 —— 今天起(预警线体系) vs 到仓后(补货决策体系)
    dArrDaily: dArrDaily,                 // 到仓日起 D 天的日均
    leadDemand: leadDemand,               // 今天→到仓 的实际消耗（原 dUse×lead）
    arrDateStr: arrDateStr, axOk: axToday.ok && axArr.ok,
    cycleShort: cycleShort,               // 补完仍低于预警线（欠账）
    // v426：字段名保留（CSV/明细表都引用它），语义改为「按目标天数补完之后是否仍低于预警线」——
    //   v425 及之前是「1 车补不满拉回预警线所需的量」，那个判据在拆掉地板后已无意义。
    leadBoxes: leadDemand, oneCarShort: (underRop > 0),  // 补完是否仍欠预警线
    cycleDays: cycleDays,
    lead: lead, leadKnown: leadKnown, stockAtArrival: stockAtArrival, stockoutRisk: stockoutRisk,
    // v420: 当前库存输入口
    curKnown: curKnown, curStock: curStock, stockSrc: stockSrc,
    gapVsRop: gapVsRop, curStockDays: curStockDays,
    arrivalStockDays: arrivalStockDays,   // 到仓时在库折合天数（到仓后口径）
    carAloneDays: carAloneDays,
    ropCapFree: ropCapFree,
    freeOver: ropCapFree != null ? Math.max(0, rop - ropCapFree) : 0,
    lastIdx: lastIdx, lastVal: lastIdx >= 0 ? a[lastIdx] : null,
    lastWeekLbl: lastIdx >= 0 && mw[lastIdx] ? mw[lastIdx].short : '',
    lastIsExcluded: !!(lastIdx >= 0 && exSet[lastIdx]),
    nExcluded: exRec ? exRec.idx.length : 0,
    excNotes: exRec ? exRec.notes.slice() : [],
    exclIdx: exRec ? exRec.idx.slice() : [],
    firstIdx: firstIdx, nActual: vals.length,
    planPerWeek: W_plan, ropVsLast: (lastIdx >= 0 && rop > 0) ? (rop / a[lastIdx] - 1) : null
  };
}
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
