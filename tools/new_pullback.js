const fs = require('fs');
const html = fs.readFileSync('rdc-dashboard.html', 'utf8');
const start = html.indexOf("function renderPullbackAnalysis(page)");
const end = html.indexOf("\n// ========== 导出 ==========", start);

const newFunc = fs.readFileSync('tools/new_func.txt', 'utf8');
const result = html.slice(0, start) + newFunc + html.slice(end);
fs.writeFileSync('rdc-dashboard.html', result);
console.log("Replaced OK. from byte", start, "to", end, "new length:", result.length);
