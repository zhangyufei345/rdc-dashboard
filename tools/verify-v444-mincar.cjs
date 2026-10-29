// v444 验证：山姆「最小起补量（车）」参数
// ①默认 0.5 时未填库存 → 车数零回归 ②填 0 完全退化 ③0.1/0.5 两档门槛行为 ④页面输入框与文案
const chromium = require('C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules/playwright-core').chromium;
const fs = require('fs'); const path = require('path');
const http = require('http');
const ROOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
function findChromium() {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : 'C:/Users/zhangyufei1/AppData/Local/ms-playwright';
  const c = [];
  for (const d of fs.readdirSync(base)) { c.push(path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); c.push(path.join(base, d, 'chrome-win64', 'chrome.exe')); }
  return c.find(p => fs.existsSync(p));
}
const MIME = { '.html': 'text/html;charset=utf-8', '.json': 'application/json;charset=utf-8', '.xlsx': 'application/octet-stream' };
function serve(dir, port) {
  return new Promise(res => {
    const s = http.createServer((req, rr) => {
      let f = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
      if (f === '/') f = '/rdc-dashboard.html';
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) { rr.writeHead(404); return rr.end('nf'); }
      rr.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(rr);
    });
    s.listen(port, '127.0.0.1', () => res(s));
  });
}
const pad = (s, n) => String(s).padStart(n);
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')); }
}

(async () => {
  const port = 8802;
  const srv = await serve(ROOT, port);
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1100 } })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/rdc-dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => typeof dataStore !== 'undefined' && dataStore && dataStore.loaded === true, null, { timeout: 180000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => navigateTo('sams-fc'));
  await page.waitForFunction(() => document.querySelectorAll('#page-sams-fc .card').length >= 4, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(3500);

  // 口径钉死：覆盖 14 天
  await page.evaluate(() => {
    window._samsState.coverDays = 14;
    window._samsState.curStock = {};
    renderSamsFc();
  });
  await page.waitForTimeout(1200);

  const snap = () => page.evaluate(() => {
    const st = window._samsState;
    const arr = samsAllMetrics(st) || [];
    return {
      ratio: st.minCarRatio,
      car: st.car,
      rows: arr.map(m => ({ short: m.short, need: Math.round(m.needEff || 0), cars: m.byTargetEff, boxes: Math.round(m.batchBoxes || 0), noCarByFloor: !!m.noCarByFloor, minCarBoxes: Math.round(m.minCarBoxes || 0) })),
      totalCars: arr.reduce((s, m) => s + (m.byTargetEff || 0), 0),
      totalBoxes: arr.reduce((s, m) => s + (m.batchBoxes || 0), 0)
    };
  });

  console.log('\n【1】默认值');
  let r = await snap();
  check('minCarRatio 默认 0.5', r.ratio === 0.5, '实际 ' + r.ratio);
  check('起补线 = 0.5 × 5568 = 2,784 箱', r.rows.every(x => x.minCarBoxes === 2784), '各仓 ' + r.rows.map(x => x.minCarBoxes).join('/'));

  console.log('\n【2】库存未填时零回归（改动前 = 8 车 / 44,544 箱）');
  check('总车 = 8', r.totalCars === 8, '实际 ' + r.totalCars);
  check('总箱 = 44,544', r.totalBoxes === 44544, '实际 ' + r.totalBoxes.toLocaleString());
  check('无仓触发未达起补量', r.rows.every(x => !x.noCarByFloor), '');

  console.log('\n【3】minCarRatio = 0（应完全退化为原 ceil）');
  await page.evaluate(() => { window._samsState.minCarRatio = 0; window._samsState.curStock = {}; renderSamsFc(); });
  await page.waitForTimeout(800);
  r = await snap();
  check('未填库存仍 8 车', r.totalCars === 8, '实际 ' + r.totalCars);

  console.log('\n【4】门槛行为：缺口梯度 × 两档参数');
  for (const ratio of [0.5, 0.1]) {
    for (const X of [200, 700, 1000, 2784, 3000]) {
      const out = await page.evaluate((o) => {
        const st = window._samsState;
        st.minCarRatio = o.ratio;
        st.curStock = {};
        const base = samsAllMetrics(st) || [];
        base.forEach(m => { st.curStock[m.short] = Math.max(0, Math.round((m.targetDemandEff || 0) - o.X)); });
        const arr = samsAllMetrics(st) || [];
        return arr.map(m => ({ short: m.short, need: Math.round(m.needEff || 0), cars: m.byTargetEff, floor: !!m.noCarByFloor }));
      }, { ratio, X });
      const expect = (X / 5568) < ratio ? 0 : Math.ceil(X / 5568);
      const okAll = out.every(x => x.cars === expect);
      check('minCarRatio=' + ratio + ' 缺口' + X + '箱(=' + (X / 5568).toFixed(3) + '车) → 期望 ' + expect + ' 车', okAll,
        '实测 ' + out.map(x => x.short + ':' + x.cars).join(' '));
    }
  }

  console.log('\n【5】页面输入框与文案');
  const ui = await page.evaluate(() => {
    const st = window._samsState;
    st.minCarRatio = 0.5; st.curStock = {}; renderSamsFc();
    const inputs = [...document.querySelectorAll('#page-sams-fc input')];
    const box = inputs.find(i => (i.getAttribute('onchange') || '').indexOf('minCarRatio') >= 0);
    return { found: !!box, val: box ? box.value : null };
  });
  check('参数栏存在「最小起补量(车)」输入框', ui.found, 'value=' + ui.val);
  check('输入框默认值 = 0.5', String(ui.val) === '0.5', '实际 ' + ui.val);

  // 通过 samsSet 改值（模拟真实输入）
  const viaSet = await page.evaluate(() => {
    samsSet('minCarRatio', '0.1');
    return window._samsState.minCarRatio;
  });
  check('samsSet 接受 0.1', viaSet === 0.1, '实际 ' + viaSet);
  const viaSet0 = await page.evaluate(() => { samsSet('minCarRatio', '0'); return window._samsState.minCarRatio; });
  check('samsSet 接受 0（关闭门槛）', viaSet0 === 0, '实际 ' + viaSet0);
  const viaBad = await page.evaluate(() => { window._samsState.minCarRatio = 0.5; samsSet('minCarRatio', '-3'); return window._samsState.minCarRatio; });
  check('非法负值被拒（保持 0.5）', viaBad === 0.5, '实际 ' + viaBad);

  console.log('\n【6】0 车文案区分（未达起补量 vs 无需补货）');
  const txt = await page.evaluate(() => {
    const st = window._samsState;
    st.minCarRatio = 0.5; st.curStock = {};
    const base = samsAllMetrics(st) || [];
    base.forEach(m => { st.curStock[m.short] = Math.max(0, Math.round((m.targetDemandEff || 0) - 700)); });
    renderSamsFc();
    const t = document.getElementById('page-sams-fc').innerText;
    // 逐仓徽章文案（.sams-car-badge 第一个 span 是标签）
    const badges = [...document.querySelectorAll('#page-sams-fc .sams-car-badge')].map(b => { const sp = b.querySelector('span'); return sp ? sp.innerText.trim() : ''; });
    return { hasFloorLabel: t.indexOf('未达起补量') >= 0, badges: badges, snippet: (t.match(/未达起补量[^\n]{0,44}/) || [''])[0] };
  });
  check('页面出现「未达起补量」文案', txt.hasFloorLabel, txt.snippet);
  check('5 个仓徽章全部为「未达起补量」（缺口 700 箱时不再写本批无需补货）',
    txt.badges.length === 5 && txt.badges.every(x => x === '未达起补量'), '实测 ' + JSON.stringify(txt.badges));

  console.log('\n运行时报错: ' + errs.length + (errs.length ? ' → ' + errs.slice(0, 3).join(' | ') : ''));
  check('无 pageerror', errs.length === 0, '');
  console.log('\n===== 结果: 通过 ' + pass + ' / 失败 ' + fail + ' =====');
  await browser.close(); srv.close();
  process.exit(fail ? 1 : 0);
})();
