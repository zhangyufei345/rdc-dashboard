#!/usr/bin/env node
/**
 * 搜索框中文输入法（IME）兼容回归自检（v383 新增）
 *
 * 背景：2026-09-24 用户反馈「缺货分析 → 客户维度缺货分析」的客户组搜索框无法输入中文。
 *   根因：该搜索框 oninput 直调 renderXxx()，而那条渲染路径整页 `page.innerHTML = ...`，
 *   把「正在组字」的 <input> 节点一起替换掉 → 输入法组字目标脱离 DOM、composition 被销毁
 *   → 汉字永远上不了屏；连带英文/数字也只能进 1 个字符（打完第一个字符焦点就掉到 BODY）。
 *   实测：组字中派发 isComposing 的 input 后，原节点 isConnected=false、activeElement=BODY。
 *
 * 🔴 本工具同时守住一条血泪教训：**不要用 oncompositionstart / oncompositionend 内容属性做门控**
 *   —— 本环境 Chrome 里 `el.oncompositionend` / `el.oncompositionstart` 均为 undefined，
 *   写在 HTML 属性里的处理器压根绑不上；若再用「粘性全局标记」做门控，标记会永远清不掉、
 *   把搜索彻底卡死（v383 第一版方案就这么翻的车）。可靠判据只有 input 事件自带的 ev.isComposing。
 *
 * 用法（本地，项目根执行）：
 *   NODE_PATH="C:/Users/zhangyufei1/.workbuddy/binaries/node/workspace/node_modules" \
 *   "C:/Users/zhangyufei1/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" tools/verify-search-ime.cjs
 *   # 直连线上（部署后复核）：加  RDC_BASE=https://rdc-dashboard.pages.dev
 *
 * 覆盖范围：全库文本输入框共 4 个（无 textarea / contenteditable）——
 *   ① #filter-shortage-search 缺货分析（quadrant 深链落地的旧模板）   ← v383 修复
 *   ② #filter-customer-search 缺货分析/客户维度缺货分析「客户组名称」  ← v383 修复（用户报的）
 *   ③ #trans-search 转储/转储明细（对照：只重渲染子容器，本就正常）
 *   ④ #oi-sku-search 订单数据洞察/SKU差异明细（对照：同上）
 *
 * 退出码：全部断言通过 → 0；否则 1。
 */
const chromium = require('playwright-core').chromium;
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8931);
const LIVE = process.env.RDC_BASE || '';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const MIN_VERSION = 383; // 本修复引入的版本，用 >= 判定，避免后续 bump 后假失败

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(base)) throw new Error('未找到 ms-playwright 目录：' + base);
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('ms-playwright 下未找到 chromium 可执行文件');
}

const server = LIVE ? null : http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const fp = path.resolve(ROOT, rel);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (server) await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const BASE = LIVE || `http://127.0.0.1:${PORT}`;
  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });   // 线上复核必须禁缓存，否则会拿旧 HTML 假通过

  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto(`${BASE}/?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await wait(2000);
  await page.fill('#login-user', 'admin').catch(() => {});
  await page.fill('#login-pass', 'admin123').catch(() => {});
  await page.click('#login-page button').catch(() => {});
  await page.waitForFunction(() => window._bootLoading === false, null, { timeout: 240000 });
  await wait(2000);

  const checks = [];
  const ck = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

  const version = await page.evaluate(() => (typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : null));
  const dbVersion = await page.evaluate(() => (typeof DB_VERSION !== 'undefined' ? DB_VERSION : null));
  ck(`BUILD_VERSION >= ${MIN_VERSION}`, version >= MIN_VERSION, `BUILD=${version} DB=${dbVersion}`);
  ck('统一入口 onSearchInput 存在', await page.evaluate(() => typeof onSearchInput === 'function'), 'typeof onSearchInput');
  ck('旧「粘性组字标记」门控已彻底移除（会卡死搜索）',
    await page.evaluate(() => typeof window._searchComposing === 'undefined' && typeof onSearchCompositionEnd === 'undefined' && typeof onSearchCompositionStart === 'undefined'),
    '_searchComposing / onSearchCompositionStart / onSearchCompositionEnd 均不存在');
  ck('两个修复点都换成统一入口（不再直接调 renderXxx）',
    await page.evaluate(async () => {
      window._shortageTab = 'customer-dim'; renderShortage();
      const a = document.querySelector('#filter-customer-search');
      return !!a && /^onSearchInput\(/.test(a.getAttribute('oninput') || '');
    }), '#filter-customer-search 的 oninput 以 onSearchInput( 开头');

  // ---------- ① 客户维度缺货分析（用户报的那处） ----------
  await page.evaluate(() => navigateTo('shortage'));
  await wait(3000);
  await page.click('button:has-text("客户维度缺货分析")').catch(() => {});
  await wait(2500);
  const baseCount = await page.evaluate(() => (window._cgSorted || []).length);
  ck('前置：客户组总数已加载', baseCount > 0, `共 ${baseCount} 个客户组`);

  const s1 = await page.evaluate(() => {
    const el = document.querySelector('#filter-customer-search');
    if (!el) return { found: false };
    filters.search = ''; el.focus();
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    el.value = 'tianhong';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'tianhong', inputType: 'insertCompositionText' }));
    return { found: true, nodeAlive: el.isConnected, focused: document.activeElement === el, search: String(filters.search) };
  });
  ck('① 组字中：输入框节点存活（组字目标不被销毁）', s1.found && s1.nodeAlive && s1.focused, JSON.stringify(s1));
  ck('① 组字中：拼音串未被当作关键词', s1.search === '', `filters.search="${s1.search}"`);

  await page.evaluate(() => {
    const el = document.querySelector('#filter-customer-search');
    el.value = '天虹';
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '天虹' }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false, data: '天虹', inputType: 'insertCompositionText' }));
  });
  await wait(800);
  const s2 = await page.evaluate(() => {
    const el = document.querySelector('#filter-customer-search');
    return { value: el ? el.value : null, search: String(filters.search), focus: !!el && document.activeElement === el, caretEnd: !!el && el.selectionStart === el.value.length, cg: (window._cgSorted || []).length };
  });
  ck('① 中文提交后写入关键词', s2.search === '天虹', `filters.search="${s2.search}" value="${s2.value}"`);
  ck('① 渲染后焦点与光标还原（可继续输入）', s2.focus && s2.caretEnd, `focus=${s2.focus} caretEnd=${s2.caretEnd}`);
  ck('① 搜索真实生效（客户组被筛掉）', s2.cg > 0 && s2.cg < baseCount, `${baseCount} → ${s2.cg} 个客户组`);

  await page.click('#filter-customer-search');
  await page.keyboard.type('B');
  await wait(900);
  const s3 = await page.evaluate(() => {
    const el = document.querySelector('#filter-customer-search');
    return { value: el ? el.value : null, search: String(filters.search), focused: !!el && document.activeElement === el };
  });
  ck('① 真实键盘连续输入不丢焦点（英文/数字同理）', s3.value === '天虹B' && s3.search === '天虹B' && s3.focused, JSON.stringify(s3));

  // 兜底：个别实现提交时不补发 isComposing=false 的 input，靠真实 compositionend 监听补渲染
  await page.evaluate(() => { filters.search = ''; const el = document.querySelector('#filter-customer-search'); if (el) el.value = ''; renderCustomerToShortage(); });
  await wait(800);
  const s4 = await page.evaluate(async () => {
    const el = document.querySelector('#filter-customer-search');
    el.focus();
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.value = 'tianhong';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'tianhong' }));
    el.value = '天虹';
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '天虹' }));   // 只发 compositionend
    await new Promise(r => setTimeout(r, 800));
    return { search: String(filters.search), cg: (window._cgSorted || []).length };
  });
  ck('① 兜底路径（只发 compositionend）也能生效', s4.search === '天虹' && s4.cg > 0 && s4.cg < baseCount, JSON.stringify(s4));
  await page.evaluate(() => { filters.search = ''; renderCustomerToShortage(); });
  await wait(700);

  // ---------- ② 缺货分析旧模板搜索框 ----------
  await page.evaluate(() => { window._shortageTab = 'quadrant'; renderShortage(); });
  await wait(2500);
  const t1 = await page.evaluate(() => {
    const el = document.querySelector('#filter-shortage-search');
    if (!el) return { found: false };
    filters.search = ''; el.focus();
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.value = 'liu';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'liu' }));
    const mid = { nodeAlive: el.isConnected, focused: document.activeElement === el, search: String(filters.search) };
    el.value = '六神';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false, data: '六神', inputType: 'insertCompositionText' }));
    return { found: true, mid };
  });
  await wait(800);
  const t2 = await page.evaluate(() => {
    const el = document.querySelector('#filter-shortage-search');
    return { search: String(filters.search), value: el ? el.value : null, focus: !!el && document.activeElement === el };
  });
  ck('② 旧模板搜索框：组字中节点存活 + 提交写入关键词',
    t1.found && t1.mid.nodeAlive && t1.mid.search === '' && t2.search === '六神' && t2.focus, JSON.stringify({ mid: t1.mid, after: t2 }));

  // ---------- ③④ 对照组：本就正常的两个搜索框不能因本次改动回退 ----------
  const cRes = await page.evaluate(async () => {
    navigateTo('transship');
    if (typeof ensureTransship === 'function') { try { await ensureTransship(); } catch (e) {} }
    renderTransship();
    await new Promise(r => setTimeout(r, 1500));
    const el = document.querySelector('#trans-search');
    if (!el) return { found: false, note: '当前无转储数据时该输入框不渲染' };
    el.focus(); el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.value = 'kehu'; el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'kehu' }));
    return { found: true, nodeAlive: el.isConnected, focused: document.activeElement === el };
  });
  ck('③ 转储搜索框（对照）组字中节点存活', cRes.found ? (cRes.nodeAlive && cRes.focused) : true, JSON.stringify(cRes));

  const dRes = await page.evaluate(async () => {
    navigateTo('order-insight');
    await new Promise(r => setTimeout(r, 5000));
    const el = document.querySelector('#oi-sku-search');
    if (!el) return { found: false };
    el.focus(); el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.value = 'kehu'; el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'kehu' }));
    return { found: true, nodeAlive: el.isConnected, focused: document.activeElement === el };
  });
  ck('④ 订单洞察搜索框（对照）组字中节点存活', dRes.found ? (dRes.nodeAlive && dRes.focused) : true, JSON.stringify(dRes));

  await wait(800);
  ck('全程零运行时错误', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : '0 条');

  await browser.close(); if (server) server.close();
  const all = checks.every(c => c.pass);
  console.log(`目标：${LIVE || BASE}  （BUILD ${version} / DB ${dbVersion}）\n`);
  console.log(checks.map(c => (c.pass ? '✅ ' : '❌ ') + c.name + ' — ' + c.detail).join('\n'));
  console.log(`\n合计 ${checks.length} 项，失败 ${checks.filter(c => !c.pass).length} 个`);
  process.exit(all ? 0 : 1);
})();
