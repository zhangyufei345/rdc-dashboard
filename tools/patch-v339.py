# -*- coding: utf-8 -*-
# v339: 下调预警入选加两条硬条件 —— ①必须带前瞻需求衰减(demandDecay>0) ②预警态阈值 0.45→0.50
from pathlib import Path
p = Path(r'C:\Users\zhangyufei1\WorkBuddy\2026-06-30-09-24-40\rdc-dashboard.html')
s = p.read_text(encoding='utf-8')

# ---- 1) 顶部说明注释 ----
o1 = "  //   选取：direction='下调分仓计划'（已下调的） + downScore\u22650.45 但未触发下调（预警态），按 downScore 排序取 Top 8。"
n1 = ("  //   选取（v339 用户裁决）：必须带前瞻需求衰减信号（demandDecay>0），且满足\n"
      "  //   direction='下调分仓计划'（已下调）或 downScore\u22650.50（预警态）。")
assert s.count(o1) == 1, 'o1=%d' % s.count(o1)
s = s.replace(o1, n1)

# ---- 2) 入选过滤条件 ----
o2 = ("      _dwList = _dwAll.filter(function(r){\n"
      "        return r.direction === '\u4e0b\u8c03\u5206\u4ed3\u8ba1\u5212' || (r.downScore != null && r.downScore >= 0.45);\n"
      "      });")
n2 = ("      // v339（用户 2026-09-11 裁决）：入选加两条硬条件\n"
      "      //   \u2460 必须带前瞻需求衰减信号 demandDecay>0 \u2014\u2014 下调预警只针对\u300c\u6362\u5b63/\u9000\u5e02\u524d\u5197\u4f59\u300d，\n"
      "      //      不允许仅靠滞后/慢动/长期低销凑分的 SKU 混入。\n"
      "      //      依据实测：v338 时点 262 条虽全带衰减，但全量无衰减(demandDecay=0)最高分 0.433，\n"
      "      //      距原阈值 0.45 仅 0.017 \u2014\u2014 属侥幸不是机制保证，不锁死则随时可能漏入。\n"
      "      //   \u2461 预警态阈值 0.45 \u2192 0.50，给无衰减池留更安全的余量。\n"
      "      _dwList = _dwAll.filter(function(r){\n"
      "        if (!(r.demandDecay > 0)) return false;\n"
      "        return r.direction === '\u4e0b\u8c03\u5206\u4ed3\u8ba1\u5212' || (r.downScore != null && r.downScore >= 0.50);\n"
      "      });")
assert s.count(o2) == 1, 'o2=%d' % s.count(o2)
s = s.replace(o2, n2)

# ---- 3) 卡片标题（有数据分支）----
o3 = ('<span class="card-title">\u26a0 \u4e0b\u8c03\u9884\u8b66\uff08\u57fa\u4e8e 5+5 \u7ef4\u6253\u5206\u5236 \u00b7 \u542b\u524d\u77bb\u9700\u6c42\u8870\u51cf\uff09</span>'
      '<span style="font-size:11px;color:var(--text-secondary);margin-left:auto">')
n3 = ('<span class="card-title">\u26a0 \u4e0b\u8c03\u9884\u8b66\uff08\u987b\u542b\u524d\u77bb\u9700\u6c42\u8870\u51cf \u00b7 \u4e0b\u8c03\u5206 \u2265 0.50\uff09</span>'
      '<span style="font-size:11px;color:var(--text-secondary);margin-left:auto">')
assert s.count(o3) == 1, 'o3=%d' % s.count(o3)
s = s.replace(o3, n3)

# ---- 4) 卡片标题（空态分支）----
o4 = '<div class="card-header"><span class="card-title">\u26a0 \u4e0b\u8c03\u9884\u8b66\uff08\u57fa\u4e8e 5+5 \u7ef4\u6253\u5206\u5236 \u00b7 \u542b\u524d\u77bb\u9700\u6c42\u8870\u51cf\uff09</span></div>'
n4 = '<div class="card-header"><span class="card-title">\u26a0 \u4e0b\u8c03\u9884\u8b66\uff08\u987b\u542b\u524d\u77bb\u9700\u6c42\u8870\u51cf \u00b7 \u4e0b\u8c03\u5206 \u2265 0.50\uff09</span></div>'
assert s.count(o4) == 1, 'o4=%d' % s.count(o4)
s = s.replace(o4, n4)

# ---- 5) 空态说明文案（用区间定位，规避引号差异）----
a = '\u5f53\u524d\u65e0\u4e0b\u8c03\u4fe1\u53f7\uff08\u6216\u5df2\u8fbe\u5230'
b = '\u524d\u77bb\u9884\u8b66\u3002</div></div>\';'
i = s.index(a); j = s.index(b, i) + len(b)
old_seg = s[i:j]
new_seg = ('\u5f53\u524d\u65e0\u7b26\u5408\u6761\u4ef6\u7684\u4e0b\u8c03\u4fe1\u53f7\uff08\u53e3\u5f84\uff1a'
           '\u4e0b\u6708+\u4e0b\u4e0b\u6708\u8ba1\u5212\u5747\u503c\u4f4e\u4e8e\u5f53\u6708\u8ba1\u5212\uff0c'
           '\u5373\u9700\u6c42\u8870\u51cf\u4fe1\u53f7>0\uff0c\u4e14\u4e0b\u8c03\u5206 \u2265 0.50\uff1b'
           '\u5df2\u4e0b\u8c03\u7684 SKU \u540c\u6837\u9700\u5e26\u8870\u51cf\u4fe1\u53f7\uff09\u3002'
           '\u672c\u5361\u7247\u805a\u7126\u300c\u6362\u5b63/\u9000\u5e02\u524d\u5197\u4f59\u300d\u524d\u77bb\u9884\u8b66\u3002</div></div>\';')
s = s[:i] + new_seg + s[j:]
print('empty-state seg replaced, old_len=%d new_len=%d' % (len(old_seg), len(new_seg)))

# ---- 6) BUILD_VERSION ----
lines = s.split('\n')
hit = 0
for k, ln in enumerate(lines):
    if ln.startswith('const BUILD_VERSION = '):
        lines[k] = ('const BUILD_VERSION = 339; // v339: 下调预警入选加两条硬条件\u2014\u2014\u2460\u5fc5\u987b\u5e26\u524d\u77bb\u9700\u6c42\u8870\u51cf(demandDecay>0)\uff0c'
                    '\u4e0d\u5141\u8bb8\u9760\u6ede\u540e/\u6162\u52a8\u51d1\u5206\u7684 SKU \u6df7\u5165\uff1b\u2461\u9884\u8b66\u6001\u9608\u503c 0.45\u21920.50\u3002')
        hit += 1
assert hit == 1, 'BUILD_VERSION hit=%d' % hit
s = '\n'.join(lines)

p.write_text(s, encoding='utf-8')
print('OK')
