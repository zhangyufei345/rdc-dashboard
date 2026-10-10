// 2026-10-10 v394 回归探针：「跨月部署后自动跟随最新月份」
// 用法：NODE_PATH=<...> node tools/verify-month-follow.cjs
//
// 【为什么需要这个探针】用户 2026-10-10 报「总仪表盘还是9月的数据」。线上数据文件已 100% 是 10 月
// （json 哈希全对、响应头 no-cache、无 CDN 缓存层），新用户看到 2026-10-09 —— 只有老用户停在 9 月。
// 根因：老用户 IDB 缓存里只有 5~9 月 → loadFromIDB() 末尾 detectAllMonths() 在「后台补拉新数据之前」
// 就把 _latestMonth 判为 '2026-09' → 紧随其后的自动选中逻辑把 filters.dataMonth 从 'all' 写成 '2026-09'；
// 之后 refreshFromManifest 拉到 10 月、_latestMonth 变 '2026-10'，但全部自动跟随点的判据都是
// `filters.dataMonth === 'all'`，此刻已不成立 → 全部失效 → 数据自愈了但 dataMonth 拉不回来。
// 只在**首次跨月切换**时暴露（月内更新 _latestMonth 不变）。
//
// 本探针不依赖历史数据版本，直接验证修改后的行为契约（当前数据最新月 = 2026-10）。
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = process.env.VERIFY_ROOT || 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
const SHOT = path.join(ROOT, '.cache');
const LATEST = '2026-10';   // 本次数据最新月；换月时同步前移
const OLD = '2026-09';
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'application/javascript' };

function serve() {
  return new Promise(res => {
    const s = http.createServer((req, rq) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rq.writeHead(404); rq.end('nf'); return; }
      rq.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rq);
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}

const R = [];
function ck(name, ok, detail) { R.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); }

(async () => {
  const srv = await serve();
  const port = srv.address().port;
  const exe = (() => {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    const c = [];
    for (const d of fs.readdirSync(base)) {
      c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
      c.push(path.join(base, d, 'chrome-win64', 'chrome.exe'));
    }
    return c.find(p => fs.existsSync(p));
  })();
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errs = [], badRes = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) badRes.push(r.status() + ' ' + r.url().slice(-40)); });

  console.log('=== v394 跨月自动跟随回归探针 ===');
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => (typeof dataStore !== 'undefined') && dataStore.loaded === true, null, { timeout: 240000, polling: 500 });
  await page.waitForTimeout(4000);

  // ---- A) 初始：自动跟随最新月 ----
  const a = await page.evaluate(() => ({ dm: filters.dataMonth, lm: window._latestMonth, av: window._availableMonths }));
  ck(`A 初始自动跟随最新月 = ${LATEST}`, a.dm === LATEST && a.lm === LATEST, `dataMonth=${a.dm} _latestMonth=${a.lm} 可用=${JSON.stringify(a.av)}`);

  // ---- B) 【核心】模拟 bug 现场：dataMonth 被写成旧月且未锁定 → 自动跟随必须拉回 ----
  const b = await page.evaluate((OLD) => {
    filters.dataMonth = OLD;             // 模拟 loadFromIDB 的 detectAllMonths 把 _latestMonth 判成旧月后写入
    window._monthUserLocked = false;      // 用户从未手动选过月份
    const has = (typeof autoSelectLatestMonth === 'function');
    if (has) autoSelectLatestMonth();     // 后台数据到位后的自动跟随点（旧版这里是 if(dataMonth==='all')）
    else if (window._latestMonth && filters.dataMonth === 'all') filters.dataMonth = window._latestMonth; // v393 旧判据
    return { dm: filters.dataMonth, lm: window._latestMonth, has };
  }, OLD);
  ck('B 【核心】未锁定时自动跟随拉回最新月', b.dm === LATEST,
    `dataMonth=${b.dm} autoSelectLatestMonth存在=${b.has}（v393 旧判据在此会停在 ${OLD} —— 即用户报的 bug）`);

  // ---- C) 用户手动选月份 → 锁定，后台刷新不得覆盖 ----
  const c = await page.evaluate((OLD) => {
    onGlobalMonthChange(OLD);
    const locked = !!window._monthUserLocked;
    const manual = filters.dataMonth;
    if (typeof autoSelectLatestMonth === 'function') autoSelectLatestMonth();
    return { locked, manual, after: filters.dataMonth };
  }, OLD);
  ck('C 手动选月后锁定，后台自动跟随不覆盖', c.locked === true && c.manual === OLD && c.after === OLD,
    `lock=${c.locked} 手动后=${c.manual} 自动跟随后=${c.after}`);

  // ---- D) 手动选「全部月份」同样锁定 ----
  const d = await page.evaluate(() => {
    onGlobalMonthChange('all');
    const locked = !!window._monthUserLocked;
    if (typeof autoSelectLatestMonth === 'function') autoSelectLatestMonth();
    return { locked, dm: filters.dataMonth };
  });
  ck('D 手动选「全部月份」同样锁定', d.locked === true && d.dm === 'all', `lock=${d.locked} dataMonth=${d.dm}`);

  // ---- E) 解锁后恢复跟随，且总览缺货日期联动到新月份 ----
  const e = await page.evaluate(() => {
    window._monthUserLocked = false;
    if (typeof autoSelectLatestMonth === 'function') autoSelectLatestMonth();
    ensureOverviewDate();
    if (typeof renderAll === 'function') renderAll();   // 产品路径：自动跟随点后面都跟着 renderAll
    return { dm: filters.dataMonth, ov: filters.overviewDate };
  });
  ck('E 解锁后跟随最新月 + 总览缺货日期联动', e.dm === LATEST && String(e.ov).startsWith(LATEST),
    `dataMonth=${e.dm} overviewDate=${e.ov}`);

  // ---- E2) 顶部月份下拉 DOM 必须同步（populateMonthSelector 由 renderAll 调用）----
  await page.waitForTimeout(1500);
  const e2 = await page.evaluate(() => {
    const sel = document.getElementById('global-month-selector');
    return sel ? { val: sel.value } : null;
  });
  ck('E2 顶部月份下拉 DOM 同步为最新月', e2 && e2.val === LATEST, JSON.stringify(e2));

  // ---- F) 总览页 UI 实际渲染值（与用户截图同源）----
  await page.evaluate(() => { navigateTo('overview'); });
  await page.waitForTimeout(2500);
  const f = await page.evaluate(() => {
    const t = document.getElementById('page-overview') ? document.getElementById('page-overview').innerText : '';
    const m = t.match(/(\d{4}-\d{2}-\d{2})/);
    return { hasLatest: /2026-10-09/.test(t), firstDate: m ? m[1] : null, sample: t.slice(0, 0) };
  });
  ck('F 总览页 UI 出现 2026-10-09（不再是 09-28）', f.hasLatest === true, `页面首个日期=${f.firstDate}`);
  await page.screenshot({ path: path.join(SHOT, 'v394_monthfollow_overview.png'), fullPage: false });

  ck('无 JS 运行时错误（pageerror / console.error）', errs.length === 0, errs.slice(0, 3).join(' | '));
  const realBad = badRes.filter(x => !/favicon/.test(x));
  ck('无资源加载失败（除 favicon）', realBad.length === 0, realBad.slice(0, 4).join(' | '));

  await browser.close();
  srv.close();

  console.log('');
  R.forEach(r => console.log((r.ok ? '✅ ' : '❌ ') + r.name + (r.detail ? '  → ' + r.detail : '')));
  const bad = R.filter(r => !r.ok).length;
  console.log(`\n合计 ${R.length} 项，通过 ${R.length - bad} 项，失败 ${bad} 项`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
