# -*- coding: utf-8 -*-
"""v337: 导出 Excel 的 SKU 列强制文本格式 + 还原 0 开头原始编码。"""
from pathlib import Path

p = Path(r'C:\Users\zhangyufei1\WorkBuddy\2026-06-30-09-24-40\rdc-dashboard.html')
s = p.read_text(encoding='utf-8')
orig_len = len(s)
applied = []

# ---------------------------------------------------------------- A. 建立原始编码表
o1 = """      console.log('[分仓计划] v305-fix 解析：' + Object.keys(planBySkuRdc).length + ' SKU，产品名=' + Object.keys(_planSkuNameMap).length + '，计划仓→RDC（如 华南仓→华南RDC）');
    }
"""
n1 = """      console.log('[分仓计划] v305-fix 解析：' + Object.keys(planBySkuRdc).length + ' SKU，产品名=' + Object.keys(_planSkuNameMap).length + '，计划仓→RDC（如 华南仓→华南RDC）');
    }

    // ===== v337: 0 开头 SKU「原始编码表」（norm → 原始字符串）=====
    //   背景：normSkuCode('09539') = '9539'，去零是为了查 shipMap/planBySkuRdc 不 miss（红线 v302），
    //         但**展示/导出**必须还原成原始 5 位编码（用户 2026-09-11 反馈导出文件里美加净 9539 少了前导 0）。
    //   权威源 = 原始 Excel 单元格字符串（本身已是 '09539' 文本），**不靠「补 0 猜测」**。
    //   覆盖 4 个来源：分仓计划原始键 / cov 覆盖表原始 sku / 基础数据「产品编码」列 / 分仓计划 raw 两段。
    //   暴露点必须在数据解析函数末尾（v114 铁律），保证首次进任意页面即可用。
    (function () {
      window._skuCanonMap = window._skuCanonMap || {};
      var m = window._skuCanonMap;
      function reg(raw) {
        var t = String(raw == null ? '' : raw).trim();
        if (!t) return;
        var nn = normSkuCode(t);
        if (nn && nn !== t && !m[nn]) m[nn] = t;
      }
      try { Object.keys(planBySkuRdc).forEach(reg); } catch (e) {}
      try { (cov7 || []).forEach(function (d) { if (d) reg(d.sku); }); } catch (e) {}
      try {
        var _bs = rawSheets && rawSheets['基础数据'];
        if (_bs && _bs.length > 1) {
          var _h = _bs[0] || [], _ci = -1;
          for (var _i = 0; _i < _h.length; _i++) { if (String(_h[_i] == null ? '' : _h[_i]).trim() === '产品编码') { _ci = _i; break; } }
          if (_ci >= 0) { for (var _r = 1; _r < _bs.length; _r++) { if (_bs[_r]) reg(_bs[_r][_ci]); } }
        }
      } catch (e) {}
      try {
        var _pp = rawSheets && rawSheets['分仓计划'];
        if (_pp && _pp.length > 1) {
          for (var _r2 = 1; _r2 < _pp.length; _r2++) { var _row = _pp[_r2]; if (!_row) continue; reg(_row[0]); reg(_row[5]); }
        }
      } catch (e) {}
      console.log('[SKU原始编码] v337 建表：' + Object.keys(m).length + ' 个 0 开头 SKU（norm→原始）');
    })();
"""
assert s.count(o1) == 1, 'A count=%d' % s.count(o1)
s = s.replace(o1, n1)
applied.append('A 原始编码表')

# ---------------------------------------------------------------- B. 导出：工具函数
o2 = """  var _LT_LABEL = { stub: '顽固型', repeat: '反复型', fresh: '新发型', eased: '已缓解', sporadic: '偶发' };
"""
n2 = """  var _LT_LABEL = { stub: '顽固型', repeat: '反复型', fresh: '新发型', eased: '已缓解', sporadic: '偶发' };

  // v337: SKU 编码列统一「还原原始编码 + 强制文本格式」
  //   根因（2026-09-11 实测）：buildPlanOptimAdvice 的 cov7 回退分支把 sku 走了 normSkuCode（'09539'→'9539'），
  //   导出时 4 位码丢前导零；且纯数字字符串在部分 Excel/WPS 里会被当数值处理。
  //   权威源 = window._skuCanonMap（parseInventoryExcel 末尾由原始 Excel 字符串构建，非补零猜测）。
  var _skuCanon = window._skuCanonMap || {};
  function _skuText(v) {
    var t = String(v == null ? '' : v).trim();
    if (!t) return '';
    return _skuCanon[t] || t;
  }
  // 按表头定位 SKU 列，逐格写成文本（t='s' + z='@'），确保 Excel 显示为「文本」且不吃前导零
  function _forceTextSkuColumn(ws, headerName) {
    try {
      if (!ws || !ws['!ref']) return;
      var R = XLSX.utils.decode_range(ws['!ref']);
      var col = -1;
      for (var c = R.s.c; c <= R.e.c; c++) {
        var hc = ws[XLSX.utils.encode_cell({ r: R.s.r, c: c })];
        if (hc && String(hc.v) === headerName) { col = c; break; }
      }
      if (col < 0) return;
      for (var r = R.s.r + 1; r <= R.e.r; r++) {
        var addr = XLSX.utils.encode_cell({ r: r, c: col });
        var cell = ws[addr];
        if (!cell) continue;
        cell.v = _skuText(cell.v);
        cell.t = 's';
        cell.z = '@';
        delete cell.w;
      }
    } catch (e) { console.warn('[导出] SKU 列文本化失败', e); }
  }
"""
assert s.count(o2) == 1, 'B count=%d' % s.count(o2)
s = s.replace(o2, n2)
applied.append('B 导出工具函数')

# ---------------------------------------------------------------- C. 上调 sheet SKU 还原
o3 = """      '评分': d.score,
      'SKU编码': d.materialCode,"""
n3 = """      '评分': d.score,
      'SKU编码': _skuText(d.materialCode),"""
assert s.count(o3) == 1, 'C count=%d' % s.count(o3)
s = s.replace(o3, n3)
applied.append('C 上调 SKU')

# ---------------------------------------------------------------- D. 下调 sheet SKU 还原
o4 = "      'SKU编码': d.sku,"
n4 = "      'SKU编码': _skuText(d.sku),"
assert s.count(o4) == 1, 'D count=%d' % s.count(o4)
s = s.replace(o4, n4)
applied.append('D 下调 SKU')

# ---------------------------------------------------------------- E. 写盘前强制文本列
o5 = """  var wb = XLSX.utils.book_new();
  var wsUp = XLSX.utils.json_to_sheet(upRows);
  XLSX.utils.book_append_sheet(wb, wsUp, '上调建议');
  var wsDown = XLSX.utils.json_to_sheet(downRows);
  XLSX.utils.book_append_sheet(wb, wsDown, '下调预警');"""
n5 = """  var wb = XLSX.utils.book_new();
  var wsUp = XLSX.utils.json_to_sheet(upRows);
  _forceTextSkuColumn(wsUp, 'SKU编码');
  XLSX.utils.book_append_sheet(wb, wsUp, '上调建议');
  var wsDown = XLSX.utils.json_to_sheet(downRows);
  _forceTextSkuColumn(wsDown, 'SKU编码');
  XLSX.utils.book_append_sheet(wb, wsDown, '下调预警');"""
assert s.count(o5) == 1, 'E count=%d' % s.count(o5)
s = s.replace(o5, n5)
applied.append('E 强制文本列')

# ---------------------------------------------------------------- F. BUILD_VERSION
o6 = 'const BUILD_VERSION = 336; // v336:'
n6 = ('const BUILD_VERSION = 337; // v337: 补货建议导出 Excel 的「SKU编码」列改为文本格式并还原 0 开头原始编码'
      '（美加净 5 位码 9539→09539）——新建 window._skuCanonMap（norm→原始，源自原始 Excel 字符串，非补零猜测），'
      '导出两个 sheet 的 SKU 列都按表头定位后逐格写成文本(t=s, z=@)。 // v336:')
assert s.count(o6) == 1, 'F count=%d' % s.count(o6)
s = s.replace(o6, n6)
applied.append('F BUILD_VERSION→337')

assert len(s) > orig_len, '文件反而变短，异常'
p.write_text(s, encoding='utf-8')
print('OK 已应用:', ' / '.join(applied))
print('文件长度 %d → %d (+%d)' % (orig_len, len(s), len(s) - orig_len))
