#!/usr/bin/env node
/**
 * v440 不变式验证：「按历史销售覆盖」口径下，未来 DP 完全不参与计算（2026-10-26）
 *
 * 做法 = 反事实测试：把 st.data.whs[*].plan（未来 DP）**全部抹成 0**，重算全部指标，
 *   与抹除前逐项比对（rop / reqCover / ssFinal / coverTarget / coverNeed / nCar / batchDays /
 *   cycleDays / ropCapFree / stockAtArrival / leadDemand / arrivalStockDays / k …）。
 *
 * 期望：
 *   · basis=hist → 差异 **0 项**（说明预警线、覆盖天数目标水位、补货车数、售罄天数、免租上限线
 *     全部只由「历史实际出货」驱动）
 *   · basis=plan → 差异 >0（对照组，证明这个探针本身能测出 DP 依赖，不是假绿）
 *
 * 用法（项目根）：NODE_PATH="<node_modules>" node tools/verify-hist-no-dp.cjs
 */
const fs=require('fs'),http=require('http'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.json':'application/json','.css':'text/css','.xlsx':'application/octet-stream'};
function findC(){const b=path.join(process.env.LOCALAPPDATA||'','ms-playwright');const c=[];for(const d of fs.readdirSync(b)){c.push(path.join(b,d,'chrome-headless-shell-win64','chrome-headless-shell.exe'));c.push(path.join(b,d,'chrome-win64','chrome.exe'));}return c.find(p=>fs.existsSync(p));}
function srv(){const s=http.createServer((q,r)=>{const rel=decodeURIComponent(q.url.split('?')[0].split('#')[0]).replace(/^\/+/,'')||'index.html';const f=path.join(ROOT,rel);if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);r.end('nf');return;}r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);});return new Promise(x=>s.listen(0,'127.0.0.1',()=>x(s)));}
(async()=>{
const {chromium}=require('playwright-core');
const server=await srv();const port=server.address().port;
const browser=await chromium.launch({headless:true,executablePath:findC(),args:['--no-sandbox']});
const page=await (await browser.newContext({viewport:{width:1560,height:1000}})).newPage();
const errs=[];page.on('pageerror',e=>errs.push(String(e&&e.message)));
await page.goto('http://127.0.0.1:'+port+'/rdc-dashboard.html',{waitUntil:'domcontentloaded',timeout:120000});
await page.fill('#login-user','admin').catch(()=>{});await page.fill('#login-pass','admin123').catch(()=>{});
await page.click('#login-page button').catch(()=>{});
await page.waitForFunction(()=>typeof dataStore!=='undefined'&&dataStore&&dataStore.loaded===true,null,{timeout:180000});
await page.waitForTimeout(6000);
await page.evaluate(()=>{if(typeof navigateTo==='function')navigateTo('sams-fc');});
await page.waitForTimeout(600);
await page.evaluate(()=>{if(typeof samsLoad==='function')samsLoad(true);});
await page.waitForFunction(()=>window._samsState&&window._samsState.data&&window._samsState.data.whs.length>0,null,{timeout:60000});
await page.waitForTimeout(1200);

const KEYS=['rop','reqCover','ssFinal','ss1','ss2','W_use','dUse','k','coverTarget','coverDemandArr','ssFinalC','coverNeed','nCar','batchBoxes','batchDays','cycleDays','ropCapFree','arrivalStockDays','leadDemand','stockAtArrival'];
const snap=(cfg)=>page.evaluate(o=>{
  samsSet('basis',o.basis);samsSet('win','8');samsSet('coverW','1');samsSet('coverDays',String(o.cd));samsClearStock();
  const st=window._samsState,rows=samsAllMetrics(st);
  const out={};
  rows.forEach(x=>{const r={};['rop','reqCover','ssFinal','ss1','ss2','W_use','dUse','k','coverTarget','coverDemandArr','ssFinalC','coverNeed','nCar','batchBoxes','cycleDays','ropCapFree','arrivalStockDays','leadDemand','stockAtArrival'].forEach(k=>{r[k]=(typeof x[k]==='number'?Math.round(x[k]*1000)/1000:x[k]);});
    r.batchDays=(x.batchDays==null?null:+x.batchDays.toFixed(3));
    r.basis=x.reqBasis;r.basisWhy=x.basisWhy;r.win=x.W_hist;
    out[x.short]=r;});
  const el=document.getElementById('page-sams-fc');
  const card=[].map.call(document.querySelectorAll('#page-sams-fc .kpi-card'),c=>c.innerText.replace(/\n+/g,' ')).find(t=>t.indexOf('惠州')===0)||'';
  return {rows:out, card:card.slice(0,220)};
},cfg);

// 反事实：把所有仓的「未来 DP」全部抹成 0（只动 plan 数组，历史实际不动）
const zeroDP=()=>page.evaluate(()=>{
  const d=window._samsState.data;
  window.__bak=d.whs.map(w=>(w.plan||[]).slice());
  d.whs.forEach(w=>{ if(w.plan) for(let i=0;i<w.plan.length;i++) w.plan[i]=0; });
  return d.whs.length;
});
const restoreDP=()=>page.evaluate(()=>{
  const d=window._samsState.data;
  if(!window.__bak) return 0;
  d.whs.forEach((w,i)=>{ w.plan=window.__bak[i].slice(); });
  window.__bak=null; return d.whs.length;
});

const histDiff = { range10: -1, range7: -1 };
const planDiff = { range10: -1, range7: -1 };
for(const basis of ['hist','plan']){
  for(const cd of [10,7]){
    const A=await snap({basis,cd});
    await zeroDP();
    const B=await snap({basis,cd});
    await restoreDP();
    const C=await snap({basis,cd});
    const diff=[];
    for(const wh in A.rows) for(const k in A.rows[wh]){
      if(['basis','basisWhy','win'].indexOf(k)>=0) continue;
      const a=A.rows[wh][k], b=B.rows[wh][k];
      if(a==null&&b==null) continue;
      if(typeof a==='number'&&typeof b==='number'){ if(Math.abs(a-b)>0.01) diff.push(wh+'.'+k+': '+a+' → '+b); }
      else if(a!==b) diff.push(wh+'.'+k+': '+a+' → '+b);
    }
    if (basis === 'hist') histDiff['range' + cd] = diff.length; else planDiff['range' + cd] = diff.length;
    console.log('\n■ 基准口径='+basis+' 覆盖'+cd+'天 ｜ 抹掉全部未来DP后差异项 = '+diff.length);
    if(diff.length) console.log('   '+diff.slice(0,10).join('\n   '));
    console.log('   惠州 预警线 '+A.rows['惠州'].rop+' / 目标 '+A.rows['惠州'].coverTarget+' / 需补 '+A.rows['惠州'].coverNeed+' / '+A.rows['惠州'].nCar+'车 ｜ reqBasis='+A.rows['惠州'].basis+' basisWhy='+A.rows['惠州'].basisWhy+' k='+A.rows['惠州'].k);
    console.log('   抹掉后：预警线 '+B.rows['惠州'].rop+' / 目标 '+B.rows['惠州'].coverTarget+' / 需补 '+B.rows['惠州'].coverNeed+' / '+B.rows['惠州'].nCar+'车 ｜ 复原后一致='+(JSON.stringify(A.rows['惠州'])===JSON.stringify(C.rows['惠州'])));
  }
}
// 惠州 卡片文案（hist 覆盖10天）
const c10=await snap({basis:'hist',cd:10});
console.log('\n■ 惠州卡片文案（hist·覆盖10天）：\n   '+c10.card);
console.log('\n运行时错误 '+errs.length+(errs.length?': '+errs.slice(0,2).join(' | '):''));
await browser.close();server.close();
// 判定：hist 必须 0 差异（否则有 DP 泄漏）；plan 必须 >0（对照组，防止探针假绿）
const fail = [];
if (histDiff.range10 !== 0) fail.push('hist 覆盖10天 仍依赖 DP：' + histDiff.range10 + ' 项');
if (histDiff.range7 !== 0) fail.push('hist 覆盖7天 仍依赖 DP：' + histDiff.range7 + ' 项');
if (planDiff.range10 === 0 || planDiff.range7 === 0) fail.push('对照组 plan 未测出 DP 依赖（探针失效）');
if (errs.length) fail.push('运行时错误 ' + errs.length);
console.log('\n===== ' + (fail.length ? '❌ 失败：\n  ' + fail.join('\n  ') : '✅ 通过：hist 口径 0 项依赖未来DP；plan 对照组可测出依赖') + ' =====');
process.exit(fail.length ? 1 : 0);
})().catch(e=>{console.error('工具异常:',e&&e.message);process.exit(2);});
