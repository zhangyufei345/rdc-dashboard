import io

path = r'C:\Users\zhangyufei1\WorkBuddy\2026-06-30-09-24-40\rdc-dashboard.html'
with io.open(path, 'r', encoding='utf-8') as f:
    lines = f.read().split('\n')

# 1-based ranges to remove
ranges = [(4020, 4031),   # 日订单满足矩阵 卡片
          (4227, 4228),   # renderShortage 中的 renderBrandRdcMatrix() 调用
          (4246, 4408)]   # renderBrandRdcMatrix + showMatrixTooltip + hideMatrixTooltip

remove = set()
for (a, b) in ranges:
    for i in range(a - 1, b):
        remove.add(i)

kept = [l for i, l in enumerate(lines) if i not in remove]

with io.open(path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(kept))

joined = '\n'.join(kept)
checks = {
    'card-brand-rdc-matrix 应消失': 'card-brand-rdc-matrix' not in joined,
    'renderBrandRdcMatrix 应消失': 'function renderBrandRdcMatrix' not in joined,
    'showMatrixTooltip 应消失': 'function showMatrixTooltip' not in joined,
    'hideMatrixTooltip 应消失': 'function hideMatrixTooltip' not in joined,
    'MATRIX_BRANDS 应保留': 'const MATRIX_BRANDS' in joined,
    'renderHeatMatrix 应保留': 'function renderHeatMatrix' in joined,
    'getTopFirstDayShortSKUsByBrand 应保留': 'function getTopFirstDayShortSKUsByBrand' in joined,
    'matrixColor 应保留': 'function matrixColor' in joined,
    'exportShortageOrderDetailCSV 应保留': 'function exportShortageOrderDetailCSV' in joined,
}
print('lines:', len(lines), '->', len(kept))
for k, v in checks.items():
    print(('OK  ' if v else 'FAIL') + ' ' + k)
