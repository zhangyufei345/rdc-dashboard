const fs = require('fs');
function sd(s) {
  if (typeof s === 'number') return new Date(Date.UTC(1899, 11, 30) + s * 86400000).toISOString().slice(0, 10);
  return String(s || '').slice(0, 10);
}
const files = ['_data-2026-07.json', '_data-2026-08.json', '_data.json'];
const all = {};
files.forEach(f => {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  Object.keys(j.sheets || {}).forEach(k => {
    // 每个文件自带表头：缺货汇总前 2 行、其余前 1 行
    const rows = j.sheets[k] || [];
    const cut = (k === '缺货汇总') ? rows.slice(2) : rows.slice(1);
    all[k] = (all[k] || []).concat(cut);
  });
});

// ---- 缺货汇总 ----
const shRaw = all['缺货汇总'] || [];
const COL = { date: 0, sku: 1, name: 2, brand: 3, abc: 5, dcSupply: 7, transit: 11 };
const RDC = { '华北RDC': 13, '西南RDC': 15, '东北RDC': 17, '华中RDC': 19, '华南RDC': 21, '西北RDC': 25 };
const shortage = [];
for (let i = 2; i < shRaw.length; i++) {
  const r = shRaw[i]; if (!r || r[COL.sku] == null) continue;
  const o = { dateStr: sd(r[COL.date]), materialCode: String(r[COL.sku]).trim(), materialName: r[COL.name], brand: r[COL.brand], abcClass: r[COL.abc] || 'C', dcSupply: r[COL.dcSupply] || '', rdcTransitTotal: Number(r[COL.transit]) || 0 };
  Object.keys(RDC).forEach(n => { o[n] = Number(r[RDC[n]]) || 0; });
  shortage.push(o);
}
shortage.sort((a, b) => a.dateStr < b.dateStr ? -1 : 1);
const latestDate = shortage[shortage.length - 1].dateStr;
console.log('latestDate =', latestDate, ' shortage rows =', shortage.length);

// ---- 候选池（复刻 L10078-10108）----
const latestShortage = shortage.filter(d => d.dateStr === latestDate);
const candidates = [];
latestShortage.forEach(d => {
  if (d.dcSupply && d.dcSupply.indexOf('整体缺货') >= 0 && d.rdcTransitTotal <= 0) return;
  Object.keys(RDC).forEach(rdcName => {
    const sv = d[rdcName] || 0;
    if (sv <= 0) return;
    const key = d.materialCode + '|' + rdcName;
    if (candidates.some(c => c.key === key)) return;
    candidates.push({ key, materialCode: d.materialCode, materialName: d.materialName, rdc: rdcName, rdcShortBoxes: sv });
  });
});
console.log('candidates =', candidates.length);

// ---- 60 天窗口 demandMap（复刻 L10110-10126）----
const latest = new Date(latestDate);
const sixty = new Date(latest); sixty.setDate(sixty.getDate() - 60);
const sixtyStr = sixty.toISOString().slice(0, 10);
const seven = new Date(latest); seven.setDate(seven.getDate() - 7); const sevenStr = seven.toISOString().slice(0, 10);
const fourteen = new Date(latest); fourteen.setDate(fourteen.getDate() - 14); const fourteenStr = fourteen.toISOString().slice(0, 10);
console.log('window 60d:', sixtyStr, '~', latestDate, '| 7d:', sevenStr, '| 14d:', fourteenStr);

const odRaw = all['订单明细'] || [];
const demandMap = {};
for (let i = 1; i < odRaw.length; i++) {
  const r = odRaw[i]; if (!r) continue;
  const dateStr = sd(r[0]);
  if (dateStr < sixtyStr || dateStr > latestDate) continue;
  const k = String(r[4] || '').trim() + '|' + String(r[8] || '').trim();
  if (!demandMap[k]) demandMap[k] = { total: 0, fulfill: 0, dailyVals: {} };
  demandMap[k].total += Number(r[9]) || 0;
  demandMap[k].fulfill += Number(r[11]) || 0;
  demandMap[k].dailyVals[dateStr] = (demandMap[k].dailyVals[dateStr] || 0) + (Number(r[9]) || 0);
}

// ---- shortTrendMap（复刻 L10138-10149）----
const stMap = {};
shortage.forEach(d => {
  if (!d.dateStr || d.dateStr > latestDate) return;
  Object.keys(RDC).forEach(n => {
    const sv = d[n] || 0; if (sv <= 0) return;
    const k = d.materialCode + '|' + n;
    if (!stMap[k]) stMap[k] = { recent7: 0, prev7: 0 };
    if (d.dateStr >= sevenStr) stMap[k].recent7 += sv;
    else if (d.dateStr >= fourteenStr) stMap[k].prev7 += sv;
  });
});

// ---- 组装 ----
const rows = candidates.map(c => {
  const dm = demandMap[c.key] || { total: 0, fulfill: 0, dailyVals: {} };
  const st = stMap[c.key] || { recent7: 0, prev7: 0 };
  const dDays = Object.keys(dm.dailyVals).length;
  const fr = dm.total > 0 ? dm.fulfill / dm.total : 0;
  return { ...c, demandDays: dDays, total: dm.total, fulfill: dm.fulfill, fulfillRate: fr, gap: 1 - fr, recent7: st.recent7, prev7: st.prev7, trendUp: st.recent7 > st.prev7 * 1.1 ? 1 : 0 };
});

function pct(arr, p) { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; }
const dd = rows.map(r => r.demandDays), r7 = rows.map(r => r.recent7), sb = rows.map(r => r.rdcShortBoxes);
console.log('\n=== 分布（候选数 ' + rows.length + '）===');
console.log('demandDays(60天内有需求天数): P25=' + pct(dd, .25) + ' P50=' + pct(dd, .5) + ' P75=' + pct(dd, .75) + ' P90=' + pct(dd, .9) + ' max=' + Math.max(...dd));
console.log('recent7(近7天缺货箱数):       P50=' + pct(r7, .5) + ' P75=' + pct(r7, .75) + ' P90=' + pct(r7, .9) + ' max=' + Math.max(...r7));
console.log('rdcShortBoxes(当日缺货箱数):  P50=' + pct(sb, .5) + ' P75=' + pct(sb, .75) + ' max=' + Math.max(...sb));
console.log('\ndemandDays 直方图（稀疏度）:');
const bins = { '0天(60天无订单)': 0, '1天': 0, '2天': 0, '3-4天': 0, '5-7天': 0, '8-14天': 0, '15+天': 0 };
rows.forEach(r => { const d = r.demandDays; if (d === 0) bins['0天(60天无订单)']++; else if (d === 1) bins['1天']++; else if (d === 2) bins['2天']++; else if (d <= 4) bins['3-4天']++; else if (d <= 7) bins['5-7天']++; else if (d <= 14) bins['8-14天']++; else bins['15+天']++; });
Object.keys(bins).forEach(k => console.log('  ' + k + ': ' + bins[k] + ' (' + (bins[k] / rows.length * 100).toFixed(1) + '%)'));

console.log('\n=== gap 维度现状：gap 得分分布（16分满）===');
const gapScores = rows.map(r => r.gap * 16);
console.log('gap=1.0(满足率0%，拿满16分)的候选数 = ' + rows.filter(r => r.gap >= 0.999).length + ' / ' + rows.length);
console.log('其中 demandDays<=2 的 = ' + rows.filter(r => r.gap >= 0.999 && r.demandDays <= 2).length);
console.log('其中 demandDays=0 的 = ' + rows.filter(r => r.gap >= 0.999 && r.demandDays === 0).length);

console.log('\n=== trend 维度现状 ===');
console.log('trendUp=1(拿满12分)的候选数 = ' + rows.filter(r => r.trendUp === 1).length + ' / ' + rows.length);
const tu = rows.filter(r => r.trendUp === 1).map(r => r.recent7);
console.log('这些候选中 recent7: P25=' + pct(tu, .25) + ' P50=' + pct(tu, .5) + ' P75=' + pct(tu, .75) + ' min=' + Math.min(...tu) + ' max=' + Math.max(...tu));
console.log('trendUp=1 且 recent7<=30箱的 = ' + rows.filter(r => r.trendUp === 1 && r.recent7 <= 30).length);

console.log('\n=== 40266 西南 ===');
const t = rows.filter(r => r.materialCode === '40266');
t.forEach(r => console.log(JSON.stringify(r)));

console.log('\n=== 西南仓全部候选（按 gap+trend 已知分降序，前12）===');
rows.filter(r => r.rdc === '西南RDC').sort((a, b) => (b.gap * 16 + b.trendUp * 12) - (a.gap * 16 + a.trendUp * 12)).slice(0, 12)
  .forEach(r => console.log('  ' + r.materialCode + ' 当日缺' + r.rdcShortBoxes + '箱 days=' + r.demandDays + ' total=' + r.total + ' gap=' + r.gap.toFixed(3) + '(=' + (r.gap * 16).toFixed(1) + '分) recent7=' + r.recent7 + ' prev7=' + r.prev7 + ' trend=' + r.trendUp * 12 + '分 已知小计=' + (r.gap * 16 + r.trendUp * 12).toFixed(1)));
