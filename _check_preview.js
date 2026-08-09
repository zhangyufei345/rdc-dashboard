const fs = require('fs');

// 1) 验证原始预览页业务脚本语法
const html = fs.readFileSync('C:/Users/zhangyufei1/WorkBuddy/2026-06-30-09-24-40/overview-preview.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/g);
console.log('匹配到的script块:', m ? m.length : 0);
// 业务脚本在最后一个 <script> 块
const bizMatch = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (bizMatch) {
  const biz = bizMatch[1];
  console.log('业务脚本长度:', biz.length);
  try { new Function(biz); console.log('✅ 业务脚本语法有效'); }
  catch(e) { console.log('❌ 业务脚本语法错误:', e.message, '\n@附近:', biz.slice(e.message.length > 60 ? 0 : 0, 200)); }
} else {
  console.log('未匹配到业务脚本');
}
