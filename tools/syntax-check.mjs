// 内联 JS 语法检查（等价 node --check，但不落临时文件）
// 用法：node tools/syntax-check.mjs rdc-dashboard.html
import fs from 'fs';
import vm from 'vm';
import path from 'path';

const file = process.argv[2] || 'rdc-dashboard.html';
const html = fs.readFileSync(path.resolve(file), 'utf8');
const re = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/g;
let m, i = 0, bad = 0;
while ((m = re.exec(html))) {
  i++;
  const js = m[1];
  const startLine = html.slice(0, m.index).split('\n').length;
  try {
    new vm.Script(js, { filename: 'inline#' + i });
  } catch (e) {
    bad++;
    console.log('X inline#' + i + ' (起始行 ' + startLine + '): ' + e.message);
  }
}
console.log('inline scripts=' + i + ' syntaxErrors=' + bad);
process.exit(bad ? 1 : 0);
