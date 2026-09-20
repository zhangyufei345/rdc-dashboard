// 语法自检：抽取 rdc-dashboard.html 里所有 <script> 块，逐个 node --check
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = 'C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40';
const src = fs.readFileSync(path.join(ROOT, 'rdc-dashboard.html'), 'utf8');
const blocks = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
console.log('script blocks =', blocks.length);
const tmp = os.tmpdir();
let fail = 0;
blocks.forEach((b, i) => {
  const f = path.join(tmp, `chk_${i}.js`);
  fs.writeFileSync(f, b, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`  [${i}] OK  (${b.length} chars)`);
  } catch (e) {
    fail++;
    console.log(`  [${i}] FAIL (${b.length} chars)`);
    console.log(String(e.stderr || e.message).split('\n').slice(0, 8).join('\n'));
  }
});
// 额外：内联 onclick 里的 exportPlanAdvice 调用形态自查
const inline = [...src.matchAll(/onclick="([^"]*exportPlanAdvice[^"]*)"/g)].map(m => m[1]);
console.log('\ninline onclick(exportPlanAdvice) =', inline.length);
inline.forEach(s => console.log('   ' + s));
console.log(fail ? `\n❌ ${fail} block(s) failed` : '\n✅ all blocks passed');
process.exit(fail ? 1 : 0);
