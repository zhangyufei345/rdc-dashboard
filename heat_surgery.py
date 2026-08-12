import io

path = r'C:\Users\zhangyufei1\WorkBuddy\2026-06-30-09-24-40\rdc-dashboard.html'
with io.open(path, 'r', encoding='utf-8') as f:
    lines = f.read().split('\n')

# 1) locate block start: the monthly heatmap comment
start = next(i for i, l in enumerate(lines) if '// 5. 品牌 × RDC 月度满足率矩阵' in l)
# 2) locate the history marker comment (renderOverview closes on the line just before it)
hist = next(i for i, l in enumerate(lines) if '// 日度订单满足率历史趋势卡片' in l)
# lines[hist-1] is the '}' that closes renderOverview -> keep it

# Replace block (start .. hist-1 exclusive of the closing '}') with a single call
new_top = lines[:start] + ['  renderHeatMatrix();', ''] + lines[hist-1:]

# Re-locate history marker in the new list
hist2 = next(i for i, l in enumerate(new_top) if '// 日度订单满足率历史趋势卡片' in l)

new_func = '''function renderHeatMatrix() {
  const container = document.getElementById('chart-heat');
  if (!container) return;
  const gran = window._heatGran || 'month';

  // 切换按钮高亮
  const mBtn = document.getElementById('heat-gran-month');
  const dBtn = document.getElementById('heat-gran-day');
  const dateWrap = document.getElementById('heat-date-wrap');
  if (mBtn) { mBtn.style.background = gran === 'month' ? 'var(--color-blue)' : 'transparent'; mBtn.style.color = gran === 'month' ? '#fff' : ''; }
  if (dBtn) { dBtn.style.background = gran === 'day' ? 'var(--color-blue)' : 'transparent'; dBtn.style.color = gran === 'day' ? '#fff' : ''; }
  if (dateWrap) dateWrap.style.display = gran === 'day' ? 'flex' : 'none';

  const brands = MATRIX_BRANDS;
  const rdcs = RDC_LIST;
  const heatData = [];
  const cellMap = {};
  const brandRdcTop5Map = {};
  let rateLabel = '';

  if (gran === 'month') {
    const mo = (filters.dataMonth && filters.dataMonth !== 'all')
      ? dataStore.orderDetail.filter(d => d.dateStr && d.dateStr.startsWith(filters.dataMonth))
      : dataStore.orderDetail;
    const brandRdcMap = {};
    mo.forEach(d => {
      if (!d.brand || !d.warehouse) return;
      const key = d.brand + '|' + d.warehouse;
      if (!brandRdcMap[key]) brandRdcMap[key] = { orderQty: 0, fulfillQty: 0 };
      brandRdcMap[key].orderQty += d.orderQty || 0;
      brandRdcMap[key].fulfillQty += d.totalFulfillQty || 0;
    });
    const heatMonth = (filters.dataMonth && filters.dataMonth !== 'all')
      ? filters.dataMonth
      : ((window._availableMonths && window._availableMonths.length > 0)
        ? window._availableMonths.filter(m => m.indexOf('2026-') === 0).pop() || '2026-08'
        : '2026-08');
    brands.forEach(b => rdcs.forEach(r => {
      const d = brandRdcMap[b + '|' + r];
      const hasOrder = !!(d && d.orderQty > 0);
      const rate = hasOrder ? d.fulfillQty / d.orderQty : 0;
      cellMap[b + '|' + r] = hasOrder;
      heatData.push([rdcs.indexOf(r), brands.indexOf(b), rate]);
    }));
    brands.forEach(b => rdcs.forEach(r => {
      brandRdcTop5Map[b + '|' + r] = getTopShortageSKUsByMonth(b, r, heatMonth, 5);
    }));
    rateLabel = '月满足率';
  } else {
    const allOrders = dataStore.orderDetail || [];
    const allDates = [...new Set(allOrders.map(d => d.dateStr).filter(Boolean))].sort();
    const sel = document.getElementById('heat-date');
    if (sel) {
      if (sel.options.length === 0) {
        allDates.forEach(d => { const o = document.createElement('option'); o.value = d; o.textContent = d; sel.appendChild(o); });
      }
      if (!window._heatDate || !allDates.includes(window._heatDate)) {
        window._heatDate = allDates[allDates.length - 1] || '';
      }
      sel.value = window._heatDate;
    }
    const dateStr = window._heatDate;
    const matrix = {};
    brands.forEach(b => { matrix[b] = {}; rdcs.forEach(r => { matrix[b][r] = { qty: 0, firstShort: 0 }; }); });
    allOrders.forEach(d => {
      if (!d.brand || !d.warehouse) return;
      if (!matrix[d.brand] || matrix[d.brand][d.warehouse] === undefined) return;
      if (d.dateStr !== dateStr) return;
      matrix[d.brand][d.warehouse].qty += d.orderQty;
      matrix[d.brand][d.warehouse].firstShort += d.firstDayShort;
    });
    brands.forEach(b => rdcs.forEach(r => {
      const m = matrix[b][r];
      const hasOrder = m.qty > 0;
      const rate = hasOrder ? (1 - m.firstShort / m.qty) : 0;
      cellMap[b + '|' + r] = hasOrder;
      heatData.push([rdcs.indexOf(r), brands.indexOf(b), rate]);
    }));
    brands.forEach(b => rdcs.forEach(r => {
      brandRdcTop5Map[b + '|' + r] = getTopFirstDayShortSKUsByBrand(b, r, { type: 'day', dateStr: dateStr }, 5);
    }));
    rateLabel = '日满足率（' + (dateStr || '') + '）';
  }

  const chartHeat = initChart('chart-heat');
  if (!chartHeat) return;
  chartHeat.setOption({
    tooltip: { position: 'top', backgroundColor: 'rgba(15,23,42,0.95)', borderColor: 'rgba(99,179,237,0.3)', textStyle: { color: '#e2e8f0' },
      formatter: function(p) {
        const rdc = rdcs[p.value[0]];
        const brand = brands[p.value[1]];
        const rawTop5 = brandRdcTop5Map[brand + '|' + rdc] || [];
        const top5 = rawTop5.map(d => {
          if (gran === 'month') {
            return { code: d.materialCode, name: d.materialName, boxes: d.boxes, transit: d.transit, supply: d.dcSupply };
          } else {
            const bs = window._boxSpec && window._boxSpec[String(d.code)];
            const boxes = (bs && bs > 0) ? Math.round(d.gap / bs) : d.gap;
            return { code: d.code, name: d.name, boxes: boxes, transit: '', supply: '' };
          }
        });
        let html = rdc + ' · ' + brand + '<br/>' + rateLabel + '：<b>' + (p.value[2]*100).toFixed(1) + '%</b>';
        if (top5.length > 0) {
          html += '<br/><div style="margin:6px 0 4px;border-top:1px solid rgba(148,163,184,0.3);"></div><div style="font-size:11px;color:#93c5fd;margin-bottom:4px">TOP ' + top5.length + ' 缺货 SKU</div>' +
            '<div style="display:flex;font-size:10px;color:#94a3b8;margin-bottom:2px;padding:0 2px">' +
              '<span style="width:18px">#</span>' +
              '<span style="flex:1;min-width:90px">物料 / 品名</span>' +
              '<span style="width:48px;text-align:right">缺货箱</span>' +
              '<span style="width:48px;text-align:right">在途箱</span>' +
              '<span style="width:40px;text-align:center">供应</span>' +
            '</div>';
          top5.forEach((d, i) => {
            const supplyTxt = String(d.supply || '');
            const supplyColor = supplyTxt.indexOf('紧张') >= 0 ? '#fca5a5' : (supplyTxt.indexOf('缺货') >= 0 ? '#fdba74' : '#86efac');
            const supplyLabel = supplyTxt.indexOf('紧张') >= 0 ? '紧张' : (supplyTxt.indexOf('缺货') >= 0 ? '缺货' : '正常');
            html += '<div style="display:flex;font-size:11px;line-height:1.5;padding:1px 2px">' +
              '<span style="width:18px;color:#94a3b8">' + (i+1) + '</span>' +
              '<span style="flex:1;min-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span style="color:#e2e8f0">' + d.code + '</span> <span style="color:#64748b">' + String(d.name || '').slice(0,10) + '</span></span>' +
              '<span style="width:48px;text-align:right;color:#fca5a5;font-weight:600">' + (d.boxes ? formatNum(d.boxes) : '—') + '</span>' +
              '<span style="width:48px;text-align:right;color:#e2e8f0">' + (d.transit ? formatNum(d.transit) : '—') + '</span>' +
              '<span style="width:40px;text-align:center;color:' + supplyColor + '">' + supplyLabel + '</span>' +
              '</div>';
          });
        } else {
          html += '<br/><span style="color:#64748b;font-size:11px">该品牌×RDC 无缺货 SKU</span>';
        }
        return html;
      }
    },
    grid: { left: 70, right: 30, top: 50, bottom: 30 },
    xAxis: { type: 'category', data: rdcs, position: 'top', axisLine: { lineStyle: { color: '#334155' } }, axisLabel: { color: '#94a3b8', fontSize: 11, rotate: 15 } },
    yAxis: { type: 'category', data: brands, axisLine: { lineStyle: { color: '#334155' } }, axisLabel: { color: '#94a3b8', fontSize: 11 } },
    visualMap: { min: 0.7, max: 1, calculable: true, orient: 'horizontal', left: 'center', bottom: 5, textStyle: { color: '#94a3b8', fontSize: 10 }, inRange: { color: ['#ef4444', '#f97316', '#facc15', '#84cc16', '#34d399'] }, formatter: v => (v*100).toFixed(0)+'%' },
    series: [{ type: 'heatmap', data: heatData, cursor: 'default', label: { show: true, color: '#fff', fontSize: 11, formatter: p => {
      const brand = brands[p.value[1]];
      const rdc = rdcs[p.value[0]];
      if (!cellMap[brand + '|' + rdc]) return '无订单';
      return (p.value[2]*100).toFixed(0)+'%';
    } }, itemStyle: { borderColor: '#0a0e27', borderWidth: 1 } }]
  });
}
'''

final = new_top[:hist2] + ['', new_func.rstrip('\n'), ''] + new_top[hist2:]

with io.open(path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(final))

print('start line (1-based):', start + 1)
print('history marker line (1-based):', hist + 1)
print('new total lines:', len(final))
print('contains renderHeatMatrix call:', any('renderHeatMatrix();' in l for l in final))
print('contains function def:', any('function renderHeatMatrix()' in l for l in final))
