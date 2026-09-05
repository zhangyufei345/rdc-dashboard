// 复刻 v207 parseInventoryTurnoverSheet 逻辑（逐字取自 rdc-dashboard.html L1225-1309）
const inv = require("C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40/.cache/live-core.json");
const sh = (inv.sheets||inv)["2026周转"];

function parseInventoryTurnoverSheet(shI) {
  if (!shI || shI.length < 10) return null;
  const RDC_SHORT = ['东北','华北','华东','华南','华中','西南','西北'];
  const RDC_FULL = ['东北RDC','华北RDC','华东RDC','华南RDC','华中RDC','西南RDC','西北RDC'];
  const ALL_RDC_NAMES = ['东北','华北','华东','华南','华中','西南','西北','总仓'];
  function num(v){ if(v==null||v==='') return null; const s=String(v).replace(/,/g,'').replace(/[^\d.\-]/g,''); const n=parseFloat(s); return isNaN(n)?null:n; }
  function rowVals(r, c1, c2){ const a=[]; for(let c=c1;c<=c2;c++) a.push(num(r?r[c]:null)); return a; }
  const invData = { allLocation:{}, sharedLocation:{}, subLocation:{}, inventoryByRdc:{}, shipmentCost:{}, rdcOrder:[], months:[], formula:'' };
  let rightStartCol=-1, amountHeaderRow=-1, costHeaderRow=-1, sharedHeaderRow=-1;
  for (let i=0;i<shI.length;i++){ const r=shI[i]; if(!r) continue;
    for (let c=7;c<=10;c++){ const v=r[c]!=null?String(r[c]).trim():'';
      if (v.indexOf('库存金额统计')>=0 && rightStartCol<0){ rightStartCol=c; amountHeaderRow=i; }
      if (v.indexOf('出货成本统计')>=0){ rightStartCol=c; costHeaderRow=i; } }
    if (r[0] && String(r[0]).indexOf('RDC共享库位库存周转天数')>=0){ sharedHeaderRow=i; } }
  if (rightStartCol<0) rightStartCol=8;
  let splitPoint = costHeaderRow>=0 ? costHeaderRow : shI.length;
  let monthCount=0;
  if (shI[1]){ for (let c=1;c<shI[1].length;c++){
    if (num(shI[1][c])!=null) monthCount=c;
    else if (c>1 && monthCount>0) break; } }
  if (monthCount<7) monthCount=7;
  for (let c=1;c<=monthCount;c++) invData.months.push(c+'月');
  for (let i=0;i<shI.length;i++){ const r=shI[i]; if(!r) continue;
    const left=r[0]!=null?String(r[0]).trim():'';
    const right=r[rightStartCol]!=null?String(r[rightStartCol]).trim():'';
    if (left==='RDC（全库位）') invData.totalAllLocation=rowVals(r,1,monthCount);
    else if (left==='RDC（共享仓）') invData.totalSharedLocation=rowVals(r,1,monthCount);
    else if (left==='总仓') invData.headquarters=rowVals(r,1,monthCount);
    else if (left.indexOf('RDC分仓')>=0 && (sharedHeaderRow<0||i<sharedHeaderRow)){ const idx=RDC_SHORT.findIndex(x=>left.indexOf(x)===0);
      if (idx>=0){ const name=RDC_FULL[idx]; invData.allLocation[name]=rowVals(r,1,monthCount); if(invData.rdcOrder.indexOf(name)<0) invData.rdcOrder.push(name); } }
    else if (sharedHeaderRow>=0 && i>sharedHeaderRow){ const idx=RDC_SHORT.findIndex(x=>left===x);
      if (idx>=0){ invData.subLocation[RDC_FULL[idx]]=rowVals(r,1,monthCount); } }
    if (right && ALL_RDC_NAMES.indexOf(right)>=0){ const mapKey=right==='总仓'?'总仓':RDC_FULL[RDC_SHORT.indexOf(right)];
      if (i<splitPoint){ invData.inventoryByRdc[mapKey]=rowVals(r,rightStartCol+1,rightStartCol+6); }
      else { const vals=rowVals(r,rightStartCol+1,rightStartCol+monthCount); invData.shipmentCost[mapKey]=vals; if(right==='总仓') invData.shipmentCost['总部']=vals; } } }
  return invData;
}

const d = parseInventoryTurnoverSheet(sh);
console.log("月份标签 months:", JSON.stringify(d.months));
console.log("monthCount detected:", d.months.length);
console.log("华中RDC 周转天数(全8月):", JSON.stringify(d.allLocation['华中RDC']));
console.log("  → 8月(末位):", d.allLocation['华中RDC'][d.allLocation['华中RDC'].length-1]);
console.log("华中 出货成本(全8月):", JSON.stringify(d.shipmentCost['华中RDC']));
console.log("  → 8月(末位):", d.shipmentCost['华中RDC'][d.shipmentCost['华中RDC'].length-1]);
console.log("总仓 周转天数:", JSON.stringify(d.headquarters));
console.log("总仓 出货成本:", JSON.stringify(d.shipmentCost['总仓']));
// 旧逻辑(写死7月)对比
function oldParse(shI){ const RDC_FULL=['东北RDC','华北RDC','华东RDC','华南RDC','华中RDC','西南RDC','西北RDC'];
  function num(v){if(v==null||v==='')return null;const s=String(v).replace(/,/g,'').replace(/[^\d.\-]/g,'');const n=parseFloat(s);return isNaN(n)?null:n;}
  function rv(r,a,b){const x=[];for(let c=a;c<=b;c++)x.push(num(r?r[c]:null));return x;}
  let rs=-1,sp=shI.length; for(let i=0;i<shI.length;i++){const r=shI[i];if(!r)continue;for(let c=7;c<=10;c++){const v=r[c]!=null?String(r[c]).trim():'';if(v.indexOf('出货成本统计')>=0){rs=c;sp=i;}}}
  if(rs<0)rs=8; const out={all:{},cost:{}};
  for(let i=0;i<shI.length;i++){const r=shI[i];if(!r)continue;const left=r[0]!=null?String(r[0]).trim():'';const right=r[rs]!=null?String(r[rs]).trim():'';
    const idx=['东北','华北','华东','华南','华中','西南','西北'].findIndex(x=>left.indexOf(x)===0);
    if(left.indexOf('RDC分仓')>=0&&idx>=0)out.all[RDC_FULL[idx]]=rv(r,1,7);
    if(right&&['东北','华北','华东','华南','华中','西南','西北','总仓'].indexOf(right)>=0){const mk=right==='总仓'?'总仓':RDC_FULL[['东北','华北','华东','华南','华中','西南','西北'].indexOf(right)];if(i>=sp)out.cost[mk]=rv(r,rs+1,rs+7);}}
  return out;}
const o=oldParse(sh);
console.log("\n=== 旧逻辑(写死7月) 华中RDC 周转天数 ===", JSON.stringify(o.all['华中RDC']), "→ 8月被丢弃");
console.log("=== 旧逻辑 华中 出货成本 ===", JSON.stringify(o.cost['华中']), "→ 8月被丢弃");
