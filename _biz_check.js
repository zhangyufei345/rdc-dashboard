
  // 模拟 ECharts darkMode
  const baseTextStyle = { color: '#cbd5e1', fontSize: 11 };

  // 1. 订单流核心：环形 + 雷达 混合
  echarts.init(document.getElementById('chart-core')).setOption({
    tooltip: { trigger: 'item', backgroundColor: 'rgba(15,23,42,0.95)', borderColor: 'rgba(99,179,237,0.3)', textStyle: { color: '#e2e8f0' } },
    series: [{
      type: 'pie',
      radius: ['60%', '85%'],
      startAngle: 90,
      label: { show: false },
      data: [
        { value: 80, name: '月满足率', itemStyle: { color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 1, colorStops: [{ offset: 0, color: '#60a5fa' }, { offset: 1, color: '#a78bfa' }] } } },
        { value: 20, name: '缺口', itemStyle: { color: 'rgba(99,179,237,0.08)' } }
      ],
      emphasis: { scale: true, scaleSize: 8, itemStyle: { shadowBlur: 30, shadowColor: 'rgba(96,165,250,0.6)' } }
    }]
  });

  // 2. 日订单满足率趋势
  const dates = ['07-30','07-31','08-01','04','05'];
  echarts.init(document.getElementById('chart-trend')).setOption({
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(15,23,42,0.95)', borderColor: 'rgba(99,179,237,0.3)', textStyle: { color: '#e2e8f0' } },
    legend: { data: ['KA 满足率', '经销商 满足率'], textStyle: { color: '#94a3b8', fontSize: 11 }, top: 0 },
    grid: { left: 50, right: 20, top: 35, bottom: 30 },
    xAxis: { type: 'category', data: dates, axisLine: { lineStyle: { color: '#334155' } }, axisLabel: { color: '#94a3b8', fontSize: 11 } },
    yAxis: { type: 'value', min: 0.7, max: 1, axisLine: { lineStyle: { color: '#334155' } }, splitLine: { lineStyle: { color: 'rgba(99,179,237,0.1)' } }, axisLabel: { color: '#94a3b8', formatter: v => (v*100).toFixed(0)+'%' } },
    series: [
      { name: 'KA 满足率', type: 'line', smooth: true, data: [0.86, 0.89, 0.91, 0.88, 0.85], lineStyle: { width: 3, color: '#60a5fa', shadowBlur: 8, shadowColor: 'rgba(96,165,250,0.5)' }, itemStyle: { color: '#60a5fa' }, symbol: 'circle', symbolSize: 8 },
      { name: '经销商 满足率', type: 'line', smooth: true, data: [0.79, 0.81, 0.83, 0.80, 0.78], lineStyle: { width: 3, color: '#34d399', shadowBlur: 8, shadowColor: 'rgba(52,211,153,0.5)' }, itemStyle: { color: '#34d399' }, symbol: 'circle', symbolSize: 8 }
    ]
  });

  // 3. RDC 缺货金额对比
  const rdcs = ['华南','华北','东北','西北','华中','西南'];
  echarts.init(document.getElementById('chart-rdc')).setOption({
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(15,23,42,0.95)', borderColor: 'rgba(99,179,237,0.3)', textStyle: { color: '#e2e8f0' } },
    grid: { left: 60, right: 30, top: 10, bottom: 30 },
    xAxis: { type: 'value', axisLine: { lineStyle: { color: '#334155' } }, splitLine: { lineStyle: { color: 'rgba(99,179,237,0.1)' } }, axisLabel: { color: '#94a3b8', formatter: v => '¥'+(v/10000).toFixed(0)+'万' } },
    yAxis: { type: 'category', data: rdcs, axisLine: { lineStyle: { color: '#334155' } }, axisLabel: { color: '#cbd5e1', fontSize: 11 } },
    series: [{
      type: 'bar',
      data: [168000, 142000, 98000, 72000, 58000, 39000].map(v => ({
        value: v,
        itemStyle: { color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: '#7f1d1d' }, { offset: 1, color: '#ef4444' }] }, borderRadius: [0, 4, 4, 0] }
      })),
      label: { show: true, position: 'right', color: '#fca5a5', fontSize: 11, formatter: p => '¥'+(p.value/10000).toFixed(1)+'万' }
    }]
  });

  // 4. 渠道订单结构（环形饼图）
  echarts.init(document.getElementById('chart-channel')).setOption({
    tooltip: { trigger: 'item', backgroundColor: 'rgba(15,23,42,0.95)', borderColor: 'rgba(99,179,237,0.3)', textStyle: { color: '#e2e8f0' } },
    legend: { orient: 'vertical', right: 10, top: 'center', textStyle: { color: '#cbd5e1', fontSize: 11 }, itemWidth: 12, itemHeight: 12 },
    series: [{
      type: 'pie',
      radius: ['45%', '70%'],
      center: ['38%', '50%'],
      label: { color: '#e2e8f0', formatter: '{b}\n{d}%', fontSize: 11 },
      labelLine: { lineStyle: { color: '#475569' } },
      itemStyle: { borderColor: '#0a0e27', borderWidth: 2 },
      data: [
        { value: 1820, name: 'KA直营', itemStyle: { color: '#60a5fa' } },
        { value: 980, name: '经销商', itemStyle: { color: '#34d399' } },
        { value: 456, name: '新渠道', itemStyle: { color: '#f97316' } }
      ]
    }]
  });

  // 5. 品牌 × RDC 热力图
  const brands = ['家安', '启初', '六神', '美加净', '佰草集'];
  const rdcNames = ['华南RDC','华北RDC','东北RDC','西北RDC','华中RDC','西南RDC'];
  const heatData = [];
  brands.forEach((b, bi) => rdcNames.forEach((r, ri) => {
    heatData.push([ri, bi, +(0.7 + Math.random() * 0.3).toFixed(2)]);
  }));
  echarts.init(document.getElementById('chart-heat')).setOption({
    tooltip: { position: 'top', backgroundColor: 'rgba(15,23,42,0.95)', borderColor: 'rgba(99,179,237,0.3)', textStyle: { color: '#e2e8f0' },
      formatter: p => rdcNames[p.value[0]] + ' · ' + brands[p.value[1]] + '<br/>月满足率：<b>' + (p.value[2]*100).toFixed(1) + '%</b>' },
    grid: { left: 70, right: 30, top: 30, bottom: 50 },
    xAxis: { type: 'category', data: rdcNames, axisLine: { lineStyle: { color: '#334155' } }, axisLabel: { color: '#94a3b8', fontSize: 11, rotate: 15 } },
    yAxis: { type: 'category', data: brands, axisLine: { lineStyle: { color: '#334155' } }, axisLabel: { color: '#94a3b8', fontSize: 11 } },
    visualMap: { min: 0.7, max: 1, calculable: true, orient: 'horizontal', left: 'center', bottom: 5, textStyle: { color: '#94a3b8', fontSize: 10 }, inRange: { color: ['#ef4444', '#f97316', '#facc15', '#84cc16', '#34d399'] }, formatter: v => (v*100).toFixed(0)+'%' },
    series: [{ type: 'heatmap', data: heatData, label: { show: true, color: '#fff', fontSize: 11, formatter: p => (p.value[2]*100).toFixed(0)+'%' }, itemStyle: { borderColor: '#0a0e27', borderWidth: 1 } }]
  });
