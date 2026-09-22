/* 取「已拒绝」标注展示草案所需的全部真实数字（只读，不改代码） */
const fs = require('fs'), path = require('path');
const D = path.resolve(__dirname, '..');
const j = JSON.parse(fs.readFileSync(path.join(D, 'data.json'), 'utf8'));
const bs = j.boxSpecMap || {};
const rows = j.sheets['订单明细'], H = rows[0], I = n => H.indexOf(n);
const C = { d: I('SAP放行日期'), o: I('销售单号'), ch: I('主渠道'), sku: I('SKU编码'), nm: I('SKU名称'), rj: I('订单拒绝原因'), wh: I('仓库名称'), oq: I('订单支数'), fd: I('首日排单支数'), fq: I('首日缺货量') };
const nd = v => { if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10); const m = String(v || '').match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/); return m ? m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0') : String(v || ''); };
const n = v => { const x = Number(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(x) ? x : 0; };
const od = [];
for (let i = 1; i < rows.length; i++) { const r = rows[i]; if (!r || !r[C.sku]) continue; od.push({ d: nd(r[C.d]), o: String(r[C.o] || '').trim(), ch: String(r[C.ch] || '').trim(), sku: String(r[C.sku]).trim(), nm: String(r[C.nm] || '').trim(), rj: (r[C.rj] && String(r[C.rj]).trim()) ? String(r[C.rj]).trim() : '', wh: String(r[C.wh] || '').trim(), oq: n(r[C.oq]), fd: n(r[C.fd]), fs: n(r[C.fq]) }); }
const box = (u, c) => { const b = bs[c]; return b ? u / b : u; };

console.log('### 1) 9/21 KA 未清 TOP3 —— 缺货汇总 sheet 的在途/大仓供应');
const sr = j.sheets['缺货汇总'], SH = sr[0], SI = x => SH.indexOf(x);
const sMap = {}; sr.slice(1).forEach(r => { if (!r || !r[SI('物料号')]) return; sMap[String(r[SI('物料号')]).trim()] = { t: n(r[SI('RD在途总箱数')]), sup: String(r[SI('大仓供应情况')] || '').trim() }; });
['72187', '89025', '09805'].forEach(k => console.log(`   ${k}  在途箱=${sMap[k] ? sMap[k].t : '无记录'}  大仓供应=${sMap[k] ? (sMap[k].sup || '空') : '无记录'}`));

console.log('\n### 2) 月清单样例：9月 含已拒绝的 SKU×RDC 组合（带订单量/天数）');
const m = {};
od.filter(x => x.fs > 0 && x.d.slice(0, 7) === '2026-09').forEach(x => {
  const k = x.sku + '@' + x.wh; m[k] = m[k] || { sku: x.sku, nm: x.nm, wh: x.wh, oq: 0, fs: 0, r: 0, days: new Set(), shortDays: new Set(), ro: new Set(), ao: new Set() };
  m[k].oq += x.oq; m[k].fs += x.fs; m[k].days.add(x.d); m[k].ao.add(x.o);
  if (x.fs > 0) m[k].shortDays.add(x.d);
  if (x.rj) { m[k].r += x.fs; m[k].ro.add(x.o); }
});
Object.values(m).filter(x => x.r > 0).sort((a, b) => b.r - a.r).slice(0, 6).forEach(x => {
  console.log(`   ${x.sku} ${x.nm.slice(0, 16)} @${x.wh}`);
  console.log(`      订单量 ${x.oq.toLocaleString()} 支 (${Math.round(box(x.oq, x.sku)).toLocaleString()} 箱) | 首日缺货 ${Math.round(box(x.fs, x.sku)).toLocaleString()} 箱，其中已拒绝 ${Math.round(box(x.r, x.sku)).toLocaleString()} 箱 (${(x.r / x.fs * 100).toFixed(0)}%)`);
  console.log(`      缺货天数/有单天数 ${x.shortDays.size}/${x.days.size} | 拒绝单 ${x.ro.size}/${x.ao.size}`);
});

console.log('\n### 3) 补货窗口样例：华南RDC 补货日 9/15 → 到货 9/19 → 窗口 9/19~9/22');
const win = ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22'];
const w = {};
od.filter(x => x.wh === '华南RDC' && win.includes(x.d) && x.fs > 0).forEach(x => {
  w[x.sku] = w[x.sku] || { nm: x.nm, u: 0, r: 0, ro: new Set(), ao: new Set() };
  w[x.sku].u += x.fs; w[x.sku].ao.add(x.o); if (x.rj) { w[x.sku].r += x.fs; w[x.sku].ro.add(x.o); }
});
const wl = Object.entries(w).sort((a, b) => b[1].u - a[1].u);
console.log(`   窗口内有缺货的 SKU 数=${wl.length}，含已拒绝的=${wl.filter(x => x[1].r > 0).length}`);
wl.slice(0, 6).forEach(([k, v], i) => console.log(`   ${i + 1}. ${k} ${v.nm.slice(0, 14)}  窗口缺货 ${Math.round(box(v.u, k)).toLocaleString()} 箱${v.r > 0 ? `  ← 其中已拒绝 ${Math.round(box(v.r, k)).toLocaleString()} 箱 (${(v.r / v.u * 100).toFixed(0)}%, ${v.ro.size}/${v.ao.size} 单)` : ''}`));

console.log('\n### 4) 9月整体（各 RDC）首日缺货 & 已拒绝');
const byWh = {}; od.filter(x => x.fs > 0).forEach(x => { byWh[x.wh] = byWh[x.wh] || { u: 0, r: 0 }; byWh[x.wh].u += x.fs; if (x.rj) byWh[x.wh].r += x.fs; });
Object.entries(byWh).sort((a, b) => b[1].u - a[1].u).forEach(([k, v]) => console.log(`   ${k}  ${v.u.toLocaleString()} 支 中已拒绝 ${v.r.toLocaleString()} 支 (${(v.r / v.u * 100).toFixed(1)}%)`));
