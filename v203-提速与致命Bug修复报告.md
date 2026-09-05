# v203：订单按月分片 + 修复库存解析致命 Bug

commit `d264801`，线上已生效（`DB_VERSION=203`）

---

## 一、先回答你的问题：A-D 方案部署了吗？

**A（inventory 拆分）、D（部署分片）、R（回归防护）都已部署**，只有两个收益很小的子项没做：

| 子项 | 状态 | 说明 |
|---|---|---|
| D·bootLoad 不再无条件 clearIDB | ✅ v202 | 核心提速 |
| D·源哈希记忆 + `--only` 参数 | ✅ v202 | 实测 7 个源文件全部"跳过" |
| A·inventory 五路拆分 | ✅ v202 | core/plan/master/extra/status |
| R·smoke-test R10-R26 | ✅ v201-v203 | 26 条不变式 |
| **订单按月分片** | ✅ **v203 本次** | 见下文 |
| manifest 三路拆分 | ⏸ 未做 | 改用"按需文件不进单 manifest"等价方案，效果相同 |
| 基础数据列投影瘦身 | ⏸ 未做 | 首屏 41.3MB → 39.5MB，仅 -4%，收益太小 |

---

## 二、🔴 本次最大发现：库存数据一直是空的

### 症状

`parseInventoryExcel` 读了**一个从未声明的变量 `pullbackDiag`** → 抛 `ReferenceError` → 整段解析中断 → `dataStore.inventory` **恒为 null**。

后果链：

```
库存解析失败
  → cov7 = 0，库存/转储/分仓需求三块全部没数据
  → loadFromIDB 健康检查因 cov7 缺失判「缓存残缺」
  → 每次打开都全量重拉 42MB，缓存永远命中不了
```

**这直接解释了你反馈的三个问题**：库存相关模块特别慢、转储数据点开就死、分仓计划监控无数据。

### 是谁引入的（git 考古）

```
v64  (2026-08-09)  pullbackDiag: _diag                    ← 正确
v182 (2026-09-05)  pullbackDiag: (pullbackDiag && ...)
                     ? pullbackDiag : (_prev ? ... : pullbackDiag)   ← 引入 Bug
```

v182 在批量把 `xxx: xxx` 改成 `_keep(xxx, _prev && _prev.xxx)` 的 merge 改造时，**只有这一行被手写成引用自身**，其他字段都规规矩矩用了 `_keep(_diag, ...)`。典型的批量机械改造漏网之鱼。

### 为什么三层防线全漏了

1. `node --check` 只校验语法，不校验未声明引用（这行语法完全合法）
2. 静态检查只覆盖 `render*` 函数，**从未覆盖 `parseInventoryExcel`**
3. 原有检查器要求标识符出现 ≥3 次才报，`pullbackDiag` 恰好只出现 1 次

**只有真实浏览器跑才能暴露**——本轮靠 Playwright 端到端测试的 console 捕获抓到。

### 我的自我纠错

v200「分仓计划监控暂无数据」我当时归因为**"用户没硬刷新"**——**这个归因是错的**。真因就是这个 ReferenceError 导致 cov7 恒空。

---

## 三、订单按月分片

### 问题

首屏 41.3MB 里 **37.9MB（92%）是订单 JSON**。旧逻辑是：

> `data.json` 哈希一变 → 把 8 个历史月文件全部塞进重拉列表

因为 `data.json` 走 replace 模式会清空整个 store，不重拉历史月就会丢数据。结果：**每次更新当月订单都要重传 37.9MB**。

### 解决

已实测前提：**每个订单文件对应唯一月份、零跨月**，七个字段全带 `dateStr`。

把每个月的解析结果单独存成 IndexedDB 记录 `snap_YYYY_MM`。实现上最关键的一步：

```js
// parseExcel 开头：记下各字段解析前长度
const _capStart = { shortage: len, orderDetail: len, ... };
// parseExcel 结尾：slice 出本次新增的行
_snap.orderDetail = dataStore.orderDetail.slice(_capStart.orderDetail);
```

对 replace（清空后从 0 push）和 append（从原长 push）两种模式都成立，**无需改动中间 400 行解析逻辑**。

### 六个必须注意的顺序问题

| # | 要点 | 反了会怎样 |
|---|---|---|
| 1 | `dropMonthRows` 必须在 append 前调用 | 去重逻辑拦住新行 → 快照被存成空 |
| 2 | loadFromIDB 先合并快照再健康检查 | orderDetail 恒 0 → 判残缺 → 每次全量重拉 |
| 3 | data.json 哈希延后到回填后标记 | 中途关页面留下残缺缓存且下轮判无变化 → 永久固化 |
| 4 | clearIDB 连 `snap_*` 一起删 | 旧月份残留，下次合并成脏口径 |
| 5 | current_data 不再存按月字段 | 每次保存都 structured clone 20 万+ 行 |
| 6 | 历史月文件缺失快照时退回网络重拉 | 首次访问/清缓存后拿不到数据 |

---

## 四、验证（Playwright + 本机 Chrome 真实浏览器）

| 场景 | 结果 |
|---|---|
| **P1 冷加载** | 9 个月度快照齐全，订单 238,352 行 / 缺货 8,330 行 / **cov7 = 2,735**（修复前 **0**） |
| **P2 reload** | 0 个订单文件重拉（缓存完全命中） |
| **P3 模拟"只更新 9 月订单"** | **仅 fetch data.json**，历史 8 个月 253,099 行本地回填，订单仍 238,352 行、缺货仍 8,330 行，数据零丢失 |
| **P1 耗时** | **11m11s → 1m17s**（此前一直卡在超时，正是库存解析失败所致） |

---

## 五、新增回归防护 R21-R26

其中 **R26「数据解析函数不得引用未声明标识符」** 就是专门抓这类 Bug 的：

- 覆盖范围从 `render*` 扩到 `parseInventoryExcel` / `parseExcel` / `applyPreparsed` / `loadFromIDB` / `saveToIDB` / `refreshFromManifest`
- 阈值从 ≥3 次降到 ≥1 次

**并做了反向验证**：临时移除声明 → R26 准确报出 `parseInventoryExcel → pullbackDiag`；还原后转绿。

（这条规则迭代了 5 版才消除假警报：切片越界、多变量声明、正则回溯、嵌套函数参数、正则字面量——每版都是检测器自己的锅。）

---

## 六、效果对比

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 打开看板（缓存命中） | 全量重拉 42MB（因 cov7 缺失判残缺） | **0 重传**，秒开 |
| 只更新库存 | 42MB | **3.3MB** |
| 只更新当月订单 | 37.9MB | **仅 data.json（2.4MB）** |
| 库存/转储/分仓需求 | **全部无数据** | 正常 |

---

## 七、剩下的

- `inventory-master.json` 2.67MB 中约 1.6MB 是 30 列的 `null` 占位，列投影可压到 ~1MB（首屏 -4%）
- **已知未改**：`data.json` 变化会 replace 清空 transship，转储数据需进转储页重新触发。属既有行为，非 v203 引入，需要的话单独提
