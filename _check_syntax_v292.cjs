// Extract <script> blocks from rdc-dashboard.html and syntax-check via new Function()
// v292 quick guard
const fs = require('fs');
const html = fs.readFileSync('C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40/rdc-dashboard.html', 'utf8');
const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
console.log('匹配的 <script> 块数：', blocks.length);
let okCount = 0, failCount = 0;
const errors = [];
for (let i = 0; i < blocks.length; i++) {
  const m = blocks[i].match(/<script>([\s\S]*?)<\/script>/);
  if (!m) continue;
  const code = m[1];
  try { new Function(code); okCount++; }
  catch(e) {
    failCount++;
    const msg = e.message;
    // 试着定位错误近似行号（按 \n 算）
    const lns = code.split('\n');
    errors.push(`Block #${i+1} (${code.length} chars, ${lns.length} lines): ${msg}`);
  }
}
console.log('通过：', okCount, ' / 失败：', failCount);
if (errors.length) {
  console.log('--- 错误详情（最多 6 条） ---');
  errors.slice(0, 6).forEach(e => console.log(e));
}
