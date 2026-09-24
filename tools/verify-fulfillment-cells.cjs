#!/usr/bin/env node
/**
 * 订单满足率模块回归工具（v384 新增）
 *
 * 守住两类「静默出错」的问题——它们都不报 JS 错误，只会把数字显示得看似合理：
 *   ① RDC×渠道 订单满足率统计表：该 RDC×渠道 在该口径下**完全没有订单**时（分母=0），
 *      必须显示「无订单」，不得显示 0.0%（0.0% 读起来像"全部缺货"，与事实相反）。
 *      —— 2026-09-24 用户报：东北RDC × KA 当日无订单却显示红色 0.0%。
 *   ② 悬浮弹窗「RDC在途(箱)」：带前导零的 SKU（09872/09860…）此前**恒为 —**。
 *      根因 = buildSupplyMaps 建索引时对物料码去了前导零、查询侧却用原始码 → 键形式不一致。
 *      —— 2026-09-24 用户报：华中仓 09872 / 09860 有在途却不显示。
 *
 * 断言口径（项目铁律）：
 *   - 期望值一律从本地 data.json **同源复算**（照抄 parseData 的取值 / 跳过 / 去重规则），
 *     不硬编码任何会随时间变化的量：日期取数据里最近 N 天，SKU 取缺货汇总实际存在的码。
 *   - 「无订单」渲染用**确定性合成场景**验证（临时抽掉一个 RDC×渠道 的订单行再渲染），
 *     不依赖"今天恰好有没有零分母格"，避免随数据日假失败。
 *   - 版本用 >= 判定（MIN_VERSION），避免后续 bump 后假失败。
 *
 * 用法（项目根执行）：
 *   NODE_PATH="C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules" \
 *   "C:/Users/zhangyufei1/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" tools/verify-fulfillment-cells.cjs
 *   # 直连线上复核（部署后）：加  RDC_BASE=https://rdc-dashboard.pages.dev
 *   # 扫描天数（默认 5）：加  SCAN_DAYS=3
 *
 * 退出码：全部通过 0，否则 1（可直接用于部署前卡口）。
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8932);
const LIVE = process.env.RDC_BASE || '';
const BASE = LIVE ? LIVE.replace(/\/$/, '') : 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const MIN_VERSION = 384;   // 本修复引入的版本，用 >= 判定
const SCAN_DAYS = Number(process.env.SCAN_DAYS || 5);

const RDC_LIST = ['华南RDC', '华北RDC', '东北RDC', '西北RDC', '华中RDC', '西南RDC'];
const CHANNELS = ['KA', '经销商'];
// 缺货汇总按 RDC 分列的两个列位（对应 rdc-dashboard.html parseExcel Sheet1）：
// [13/14]华北 [15/16]西南 [17/18]东北 [19/20]华中 [21/22]华南 [23/24]华东 [25/26]西北
const TRANSIT_COL = { '华南RDC': 22, '华北RDC': 14, '东北RDC': 18, '西北RDC': 26, '华中RDC': 20, '西南RDC': 16 };

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(base)) throw new Error('未找到 ms-playwright 目录：' + base);
  const cands = [];
  for (const d of fs.readdirSync(base)) {
    cands.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    cands.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
  }
  const hit = cands.find(p => fs.existsSync(p));
  if (!hit) throw new Error('ms-playwright 下未找到 chromium 可执行文件');
  return hit;
}
function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(ROOT, rel);
    if (!file.replace(/\\/g, '/').startsWith(ROOT.replace(/\\/g, '/')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('nf'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- 同源复算（照抄页面 parseData 规则，离线） ----------
function fmtDate(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') { const d = new Date((v - 25569) * 86400 * 1000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  return String(v).trim();
}
const gs = (r, i) => (r[i] == null ? '' : String(r[i]).trim());
const gn = (r, i) => { const v = r[i]; if (v == null || v === '' || isNaN(Number(v))) return 0; return Number(v); };
const pct = (f, o) => (f / o * 100).toFixed(1) + '%';
// 单元格期望文案 = 页面规则：分母>0 → 百分比；分母=0 → 「无订单」
const cellWant = (agg, rdc, ch) => { const v = agg[rdc + '|' + ch]; return (v && v.o > 0) ? pct(v.f, v.o) : '无订单'; };
function totalWant(agg, rdc) {
  let o = 0, f = 0;
  CHANNELS.forEach(ch => { const v = agg[rdc + '|' + ch]; if (v) { o += v.o; f += v.f; } });
  return o > 0 ? pct(f, o) : '无订单';
}
function addTo(box, k, oq, fq) { (box[k] = box[k] || { o: 0, f: 0 }); box[k].o += oq; box[k].f += fq; }

const dj = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const od = dj.sheets['订单明细'];

// 期望聚合：日口径 / 月口径（去重键 = 日期|销售单号|SKU编码，与页面一致）
const byDay = {}, byMon = {};
const seen = new Set(), allDates = new Set();
for (let i = 1; i < od.length; i++) {
  const r = od[i];
  if (!r || r.length < 14) continue;
  const d = fmtDate(r[0]);
  if (!d) continue;
  allDates.add(d);
  const dk = d + '|' + gs(r, 1) + '|' + gs(r, 4);
  if (seen.has(dk)) continue;
  seen.add(dk);
  const k = gs(r, 8) + '|' + gs(r, 2);       // 仓库|渠道
  const oq = gn(r, 9), fq = gn(r, 10), tf = gn(r, 11);
  const mon = d.slice(0, 7);
  byDay[d] = byDay[d] || {}; byMon[mon] = byMon[mon] || {};
  addTo(byDay[d], k, oq, fq);
  addTo(byMon[mon], k, oq, tf);              // 月口径分子 = 总履约排单支数
}
// MTD = 月初 ~ 该日累计
function mtdAgg(dateStr) {
  const mon = dateStr.slice(0, 7), out = {};
  Object.keys(byDay).forEach(d => {
    if (!d.startsWith(mon) || d > dateStr) return;
    const agg = byDay[d];
    Object.keys(agg).forEach(k => addTo(out, k, agg[k].o, agg[k].f));
  });
  return out;
}

// 期望：缺货汇总原始码 + 各 SKU 最新一条的各 RDC 在途
const sh = dj.sheets['缺货汇总'];
const rawCodes = new Set(), newestTransit = {};
for (let i = 2; i < sh.length; i++) {
  const r = sh[i];
  if (!r || r.length < 14) continue;
  const d = fmtDate(r[0]);
  if (!d) continue;
  const code = gs(r, 1);
  if (!code) continue;
  rawCodes.add(code);
  if (!newestTransit[code] || d > newestTransit[code].dateStr) {
    const t = {};
    RDC_LIST.forEach(rdc => { t[rdc] = gn(r, TRANSIT_COL[rdc]); });
    newestTransit[code] = { dateStr: d, transit: t };
  }
}
const scanDates = [...allDates].sort().reverse().slice(0, SCAN_DAYS);

// ---------- 页面复核 ----------
(async () => {
  let chromium;
  try { chromium = require('playwright-core').chromium; }
  catch (e) { console.error('需要 playwright-core：设置 NODE_PATH 指向 binaries/node/workspace/node_modules'); process.exit(2); }

  const res = { ok: true, checks: [], errors: [], scanned: scanDates };
  const add = (name, pass, detail) => { res.checks.push({ name, pass: !!pass, detail }); if (!pass) res.ok = false; };

  const server = LIVE ? null : await startServer();
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message || e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text().slice(0, 300)); });

  const readGrid = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#table-rdc-channel-fulfill table tbody tr')];
    const txt = td => { const s = td.querySelector('span'); return (s ? s.textContent : td.textContent).trim(); };
    return rows.map(tr => {
      const tds = [...tr.children];
      return { rdc: tds[0].textContent.trim(), day: [txt(tds[1]), txt(tds[2]), txt(tds[3])], mon: [txt(tds[4]), txt(tds[5]), txt(tds[6])] };
    });
  });
  const setFilters = (dateStr, rateType) => page.evaluate(({ d, t }) => {
    filters.dataMonth = d.slice(0, 7); filters.fulfillRateType = t; filters.fulfillDate = d; filters.fulfillRDC = 'all';
    navigateTo('fulfillment'); renderFulfillment();
  }, { d: dateStr, t: rateType });

  try {
    await page.goto(`${BASE}/?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    if (LIVE) await wait(2000);
    await page.fill('#login-user', 'admin').catch(() => {});
    await page.fill('#login-pass', 'admin123').catch(() => {});
    await page.click('#login-page button').catch(() => {});
    const loaded = await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, null, { timeout: 240000 }).then(() => true).catch(() => false);
    add('数据装载 dataStore.loaded', loaded, loaded ? 'OK' : '超时');
    // 🔴 handleLogin 收尾会强制 navigateTo('overview')，必须等 _bootLoading 结束再导航
    await page.waitForFunction(() => window._bootLoading === false, null, { timeout: 240000 }).catch(() => {});
    await wait(1500);

    const ver = await page.evaluate(() => ({ build: BUILD_VERSION, db: DB_VERSION }));
    add(`BUILD_VERSION >= ${MIN_VERSION}`, ver.build >= MIN_VERSION, '实际 ' + ver.build);
    add('DB_VERSION 仍为 234（纯展示修复不该 bump）', ver.db === 234, '实际 ' + ver.db);

    // ================= ① 表格单元格：无订单 → 「无订单」 =================
    const LABELS = ['日KA', '日经销商', '日合计', '月KA', '月经销商', '月合计'];
    let badCells = [], noOrderSeen = 0, pctBadFormat = [];
    for (const d of scanDates) {
      await setFilters(d, 'day');
      await page.waitForSelector('#table-rdc-channel-fulfill table tbody tr', { timeout: 60000 });
      await wait(200);
      const grid = await readGrid();
      if (grid.length !== RDC_LIST.length) { badCells.push(d + ' 行数 ' + grid.length + ' ≠ 6'); continue; }
      grid.forEach(row => {
        const want = [
          cellWant(byDay[d] || {}, row.rdc, 'KA'), cellWant(byDay[d] || {}, row.rdc, '经销商'), totalWant(byDay[d] || {}, row.rdc),
          cellWant(byMon[d.slice(0, 7)] || {}, row.rdc, 'KA'), cellWant(byMon[d.slice(0, 7)] || {}, row.rdc, '经销商'), totalWant(byMon[d.slice(0, 7)] || {}, row.rdc)
        ];
        row.day.concat(row.mon).forEach((g, i) => {
          if (g !== want[i]) badCells.push(d + ' ' + row.rdc + ' ' + LABELS[i] + ' 期望"' + want[i] + '" 实际"' + g + '"');
          if (g === '无订单') noOrderSeen++;
          else if (!/^\d{1,3}(\.\d)?%$/.test(g)) pctBadFormat.push(d + ' ' + row.rdc + ' ' + LABELS[i] + ' = "' + g + '"');
        });
      });
      // 零分母格的悬浮提示必须是「当日无订单」，不能与「有订单但无缺货」的「无缺货记录」混淆
      // 注意：提示文案须取**全文**再匹配——它前面还有「RDC · 渠道 / 订单支数」两行，
      //   先 slice 再测正则会切掉「当日无订单」那句，造出假失败。
      const zeroTips = await page.evaluate(agg => {
        const rows = [...document.querySelectorAll('#table-rdc-channel-fulfill table tbody tr')];
        const out = [];
        rows.forEach(tr => {
          const rdc = tr.children[0].textContent.trim();
          [['KA', 1], ['经销商', 2]].forEach(([ch, idx]) => {
            const rec = agg[rdc + '|' + ch];
            if (rec && rec.o > 0) return;
            const tipIdx = tr.children[idx].getAttribute('data-tip');
            out.push({ label: rdc + '·' + ch, tip: (window._tipStore[Number(tipIdx)] || '').replace(/\s+/g, ' ') });
          });
        });
        return out;
      }, byDay[d] || {});
      zeroTips.forEach(o => {
        if (!/当日无订单/.test(o.tip) || /无缺货记录/.test(o.tip)) badCells.push(d + ' ' + o.label + ' 无订单提示异常: ' + o.tip.slice(0, 160));
      });
    }
    add(`① 扫描 ${scanDates.length} 天（${scanDates.join(', ')}）：6 RDC × 6 格 与同源复算逐格一致`, badCells.length === 0, badCells.slice(0, 8).join(' ; ') || '全部一致');
    add('① 表格内无 0.0% 死值、无非百分比脏值', pctBadFormat.length === 0, pctBadFormat.slice(0, 5).join(' ; ') || '0 个');
    res.note_noOrderCellsSeen = noOrderSeen;

    // ①-确定性：合成零订单场景（临时抽掉 华中RDC×KA 全部订单行 → 该格必须显示「无订单」）
    const synth = await page.evaluate(() => {
      const bak = dataStore.orderDetail;
      dataStore.orderDetail = bak.filter(function (x) { return !(x.warehouse === '华中RDC' && x.channel === 'KA'); });
      renderFulfillment();
      const rows = [...document.querySelectorAll('#table-rdc-channel-fulfill table tbody tr')];
      const tr = rows.find(function (x) { return x.children[0].textContent.trim() === '华中RDC'; });
      const txt = function (td) { const s = td.querySelector('span'); return (s ? s.textContent : td.textContent).trim(); };
      const out = {
        dayKa: tr ? txt(tr.children[1]) : '(无行)',
        monKa: tr ? txt(tr.children[4]) : '(无行)',
        dayDealerStillPct: tr ? /%$/.test(txt(tr.children[2])) : false,
        dayTotalStillPct: tr ? /%$/.test(txt(tr.children[3])) : false,
        tip: tr ? (window._tipStore[Number(tr.children[1].getAttribute('data-tip'))] || '').replace(/\s+/g, ' ') : ''
      };
      dataStore.orderDetail = bak;      // 立即还原
      renderFulfillment();
      return out;
    });
    add('① 合成零订单场景：华中RDC×KA 日/月格 = 「无订单」，经销商/合计仍为百分比',
      synth.dayKa === '无订单' && synth.monKa === '无订单' && synth.dayDealerStillPct && synth.dayTotalStillPct,
      JSON.stringify(synth).slice(0, 200));
    add('① 合成零订单场景：该格悬浮提示 = 「当日无订单」',
      /当日无订单/.test(synth.tip) && !/无缺货记录/.test(synth.tip), synth.tip.slice(0, 110));

    // MTD 口径回归（不应把有订单的格子误判为无订单）
    let mtdBad = [];
    for (const d of scanDates.slice(0, 3)) {
      await setFilters(d, 'mtd');
      await wait(300);
      const grid = await readGrid();
      const agg = mtdAgg(d);
      grid.forEach(row => {
        const want = [cellWant(agg, row.rdc, 'KA'), cellWant(agg, row.rdc, '经销商'), totalWant(agg, row.rdc)];
        row.day.forEach((g, i) => { if (g !== want[i]) mtdBad.push(d + ' ' + row.rdc + ' MTD#' + i + ' 期望"' + want[i] + '" 实际"' + g + '"'); });
      });
    }
    add('① MTD 模式与同源复算一致（扫描 ' + Math.min(3, scanDates.length) + ' 天）', mtdBad.length === 0, mtdBad.slice(0, 6).join(' ; ') || '全部一致');

    // ================= ② 弹窗「RDC在途(箱)」键形式一致 =================
    const cov = await page.evaluate(codes => {
      if (!window._shortageByCode || !Object.keys(window._shortageByCode).length) buildSupplyMaps();
      const keys = Object.keys(window._shortageByCode);
      const miss = codes.filter(c => !window._shortageByCode[c]);
      return { keyCount: keys.length, missCount: miss.length, miss: miss.slice(0, 20) };
    }, [...rawCodes]);
    add('② 缺货汇总原始码 100% 可查（索引键不去前导零）', cov.missCount === 0,
      '索引键 ' + cov.keyCount + ' 个（含其它月份）／本表原始码 ' + rawCodes.size + ' 个，未命中 ' + cov.missCount + (cov.miss.length ? ' 例: ' + cov.miss.join(',') : ''));

    const transitProbe = await page.evaluate(args => {
      const out = [];
      args.codes.forEach(function (c) { args.rdcs.forEach(function (rdc) { out.push({ code: c, rdc: rdc, boxes: getSkuSupplyInfo(c, rdc).transitBoxes }); }); });
      return out;
    }, { codes: Object.keys(newestTransit), rdcs: RDC_LIST });
    const transitBad = transitProbe
      .filter(p => Number(p.boxes) !== Number(newestTransit[p.code].transit[p.rdc]))
      .map(p => p.code + '@' + p.rdc + ' 期望' + newestTransit[p.code].transit[p.rdc] + ' 实际' + p.boxes);
    add('② 全部 ' + Object.keys(newestTransit).length + ' 个 SKU × 6 RDC 的「RDC在途(箱)」与 data.json 最新记录逐位一致',
      transitBad.length === 0, transitBad.slice(0, 8).join(' ; ') || '全部一致');

    // 用户报的两个带零 SKU：只要还出现在缺货汇总里，就必须能取到在途（存在性驱动，不写死）
    const pairCodes = ['09872', '09860'].filter(c => newestTransit[c]);
    if (pairCodes.length) {
      const pair = await page.evaluate(codes => codes.map(function (c) { return { code: c, box: getSkuSupplyInfo(c, '华中RDC').transitBoxes }; }), pairCodes);
      const pairBad = pair.filter(p => !(Number(p.box) > 0)).map(p => p.code + ' 华中在途=' + p.box);
      add('② 带前导零 SKU 可取到在途（' + pairCodes.join(' / ') + '）', pairBad.length === 0, pairBad.join(' ; ') || pair.map(p => p.code + '=' + p.box).join(' , '));
    } else {
      add('② 用户报的带零 SKU 已不在本次缺货汇总（跳过，非失败）', true, '09872 / 09860 均不在 data.json 缺货汇总');
    }

    // 弹窗 HTML 端到端：华中RDC·经销商 提示里，带零 SKU 所在行的「RDC在途(箱)」列必须出现数字
    await setFilters(scanDates[0], 'day');
    await wait(400);
    const tipHtml = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#table-rdc-channel-fulfill table tbody tr')];
      const tr = rows.find(function (x) { return x.children[0].textContent.trim() === '华中RDC'; });
      if (!tr) return '';
      return window._tipStore[Number(tr.children[2].getAttribute('data-tip'))] || '';
    });
    const tipRows = tipHtml.split('<tr').slice(1);
    const inTipZeroCodes = Object.keys(newestTransit).filter(c => /^0/.test(c) && tipRows.some(r => r.indexOf('<td>' + c + '</td>') >= 0));
    const stillDash = inTipZeroCodes.filter(c => {
      const row = tipRows.find(r => r.indexOf('<td>' + c + '</td>') >= 0);
      // 列序：# / SKU代码 / 品名 / 订单缺口 / RDC在途(箱) / 大仓供应 →第 5 个 <td> 是在途
      const tds = row.split('<td');
      return !/\d/.test((tds[5] || '').replace(/<[^>]+>/g, '').trim());
    });
    add('② 华中RDC·经销商 弹窗内带零 SKU（' + (inTipZeroCodes.join(',') || '本日无') + '）的在途列均非「—」',
      stillDash.length === 0, stillDash.length ? ('仍为 — : ' + stillDash.join(',')) : '全部有数');

    add('运行时零错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '0');
  } catch (e) {
    res.ok = false;
    res.errors.push('探针异常: ' + e.message);
  }

  await browser.close();
  if (server) server.close();
  res.checks.forEach(c => console.log((c.pass ? '  ✓ ' : '  ✗ ') + c.name + '  → ' + c.detail));
  const passN = res.checks.filter(c => c.pass).length;
  console.log('\n' + (res.ok ? '✅ 全部通过' : '❌ 有失败项') + '  （' + passN + '/' + res.checks.length + '）');
  if (res.errors.length) console.log('异常: ' + res.errors.join(' | '));
  process.exit(res.ok ? 0 : 1);
})();
