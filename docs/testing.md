# 测试说明

Phase 1 的验证分为两类，结果分别记录：

- **自动测试（Mock）**：验证 Adapter 自身逻辑。用一个按 SillyTavern 1.19.0 源码行为编写的替身页面运行，不需要 SillyTavern、浏览器或任何界面。
- **真实 SillyTavern 集成测试**：在实际运行的 SillyTavern 中执行，用来确认宿主兼容性。

只通过 Mock 的行为，不视为"已在真实 SillyTavern 中验证"。

## 自动测试

### 运行

```bash
npm test
```

需要 Node.js 22 或更高版本，无需安装依赖（使用 Node 内置的 `node:test`）。

### 结构

| 位置 | 内容 |
| --- | --- |
| `tests/unit/` | 纯 Core 逻辑：Patch、JSON 比较、冲突判断、Order 规划（含随机不变量与穷举对照） |
| `tests/adapter/` | SillyTavern Adapter，接在替身页面上运行 |
| `tests/helpers/fake-sillytavern.js` | 替身页面，复现 1.19.0 的关键行为：缓存命中返回拷贝、未命中返回缓存对象本身、保存时缓存按引用存储、全书共用一个保存防抖、立即保存会取消防抖、`_save` 不检查 HTTP 状态、`WORLDINFO_UPDATED` 把保存的对象交给监听者、不存在的书返回空壳、只读斜杠命令；支持注入 500、网络错误、"返回 200 但未写入"等故障 |
| `tests/helpers/adapter-setup.js` | 每个测试新建一个替身页面与 Adapter，各自使用独立的锁与保存记录 |
| `tests/fixtures/worldbooks.js` | 按 1.19.0 文件结构编写的测试书：ST 编辑器保存的完整条目、角色卡导入条目（带 `extensions`）、第三方字段与新版本字段、字符串 Order、未知 position、缺字段的旧条目、`originalData` 与自定义书级字段、违反约定的条目 |
| `tests/integration/` | 真实 SillyTavern 集成测试脚本（不在 `npm test` 中运行） |

### Issue #1 要求的覆盖项

| # | 要求 | 测试 |
| --- | --- | --- |
| 1 | Worldbook 正确读取 | `tests/adapter/read.test.js` `[1]` |
| 2 | Entry 完整读取 | `read.test.js` `[2]` |
| 3 | 未知字段 round-trip 不丢失 | `tests/adapter/write.test.js` `[3]`；`tests/unit/entry-patch.test.js` |
| 4 | 修改 Content 时其他字段保持不变 | `write.test.js` `[4]` |
| 5 | 单字段修改不产生缩水对象 | `write.test.js` `[5]`；`entry-patch.test.js` |
| 6 | Entry 创建 | `write.test.js` `[6]` |
| 7 | Entry 更新 | `write.test.js` `[7]`；`tests/adapter/concurrency.test.js` |
| 8 | Entry 删除 | `write.test.js` `[8]` |
| 9 | Order 读取 | `read.test.js` `[9]`；`tests/adapter/order.test.js` `[9]`；`tests/unit/order.test.js` |
| 10 | Order 修改符合 ST 实际语义 | `order.test.js` `[10]`；`tests/unit/order.test.js`；`tests/unit/order-optimality.test.js` |
| 11 | 异常 API 返回不被当作成功 | `tests/adapter/failure.test.js` `[11]` |
| 12 | 操作隔离在目标 Worldbook | `write.test.js` `[12]` |
| 13 | 失败时返回明确错误 | `failure.test.js` `[13]` |
| 14 | Adapter 测试不依赖最终 UI | `read.test.js` `[14]`；所有 Adapter 测试默认不提供 DOM 与 Tavern Helper |
| 15 | 不污染正式 AIRP Chat | `tests/adapter/chat-safety.test.js` `[15]` |

冲突检测基础在 `tests/adapter/concurrency.test.js`：基线比较、ST 编辑器自动改写不算冲突、外部脚本修改同一条目或不同字段、ST 尚未落盘的防抖保存、其他标签页写入与 `HOST_UNSAVED_CHANGES`、并发调用串行化、外部保存通知。

`tests/adapter/robustness.test.js` 覆盖更少见的情况：同一页面内两个 Adapter 实例共用锁、Adapter 保存期间同一本书被别的代码保存、`WORLDINFO_UPDATED` 监听者改动保存对象、`saveHostCopy` 遇到已删除的书或文件又被改过、Proxy 与循环引用的值、uid 被新条目复用、`options` 传 `null` 或非法取值、等待 ST 编辑器那本书期间目标书被写入。这些测试都做过反向验证：把对应的处理临时去掉，测试会失败。

### 结果

2026-09-25，Node.js 24.15.0，Windows 11：`npm test` 共 130 项，全部通过。

## 真实 SillyTavern 集成测试

### 环境

| 项目 | 版本 |
| --- | --- |
| SillyTavern | 1.19.0，commit `7e8663cd9c184a550b37238218bdd32c6efc68e9`（`git clone --branch 1.19.0`，`npm ci`，`node server.js`） |
| Tavern Helper | 4.11.0，tag commit `18544ddfd2a477adb69552f639f7a1b8d39039cc`，安装为全局第三方扩展 |
| 数据 | 全新用户数据：仅有 ST 自带的角色 Seraphina 与世界书 Eldoria，打开一个 Seraphina 聊天（1 条消息） |
| 浏览器 | Chromium，桌面尺寸 |

### 步骤

1. 在**测试用**的 SillyTavern 1.19.0 中，把本仓库放到 `public/scripts/extensions/third-party/MieMie-Worldbook-Manager/`（`git clone` 或复制均可）。Phase 1 没有扩展入口，服务端会提示该目录没有 `manifest.json` 并跳过，这是预期行为。
2. （可选）安装 Tavern Helper，用于 A6、A7。
3. 启动 SillyTavern，打开任意角色的聊天。
4. （可选）在服务器上记录 `data/<user>/chats`、`data/<user>/worlds`、`data/<user>/settings.json` 的哈希值。
5. 在浏览器控制台运行：

   ```js
   const m = await import('/scripts/extensions/third-party/MieMie-Worldbook-Manager/tests/integration/st-integration.browser.js');
   const report = await m.runIntegration();
   console.table(report.results);
   ```

6. 预期：`report.passed` 为 `true`，所有项目为 `PASS`。脚本只创建、修改并最终删除名称以 `MieMie IT` 开头的世界书。
7. （可选）再次计算第 4 步的哈希值，预期与运行前一致。

脚本会临时替换页面的 `fetch` 来模拟服务器失败，并在 ST 世界书编辑器中打开测试书、展开条目、模拟输入（B10、B15、B16），所以请不要在日常使用的界面上运行。

在 Tavern Helper 脚本 iframe 中运行时，把第 5 步的代码作为一个全局脚本启用即可（结果可写到 `window.parent` 上查看）。故障注入与编辑器操作会自动改用父窗口；A5 需要导入 SillyTavern 自身的模块，在 iframe 中跳过。

### 实际结果（2026-09-25）

- **主窗口**（浏览器控制台，从第 1 步的标准扩展路径加载）：24 项全部 `PASS`。
- **Tavern Helper 脚本 iframe**：用 `TavernHelper.replaceScriptTrees` 建立一个全局脚本运行同一脚本，23 项 `PASS`，A5 按设计跳过；之后删除该脚本，恢复原来的脚本列表。
- 两轮之后，`chats/`、`worlds/`、`settings.json` 的 SHA-256 与运行前一致，测试书全部清理。
- [Adapter 文档](worldbook-adapter.md#示例) 中的两段示例代码也在同一环境中运行过，结果与文档一致（`HOST_UNSAVED_CHANGES` 的两种处理方式各运行一次）。

| 编号 | 内容 | 结果 |
| --- | --- | --- |
| A1 | `saveWorldInfo` 在 HTTP 500 时照样 resolve，并已把未保存数据写入页面缓存 | 已复现 |
| A2 | 立即保存书 B 会取消书 A 尚未落盘的防抖保存 | 已复现 |
| A3 | `loadWorldInfo` 缓存未命中时返回缓存对象本身 | 已复现 |
| A4 | `/api/worldinfo/get` 对不存在的书返回 `{"entries":{}}`（HTTP 200） | 已复现 |
| A5 | `st-schema.js` 的模板、字段定义、position 与 logic 枚举与运行中的 ST 一致（39 个模板字段） | 一致 |
| A6 | Tavern Helper `getWorldbook` 读含旧条目（缺 `keysecondary`）的书时抛错 | 已复现：`Cannot read properties of undefined (reading 'map')` |
| A7 | Tavern Helper `updateWorldbookWith(identity)` 丢字段、改值 | 已复现，详见兼容性文档 3.6 |
| B1 | `getWorldbook` 与文件完全一致，显示顺序正确 | 通过 |
| B2 | 只改 `content`，文件差异仅此一处，其他条目的 JSON（含键顺序）完全相同 | 通过 |
| B3 | 新建条目与 ST 运行时模板一致，uid 取最小空闲值，Order = 最大值 + 1 | 通过 |
| B4 | 移动后严格位于两邻居之间，只改 1 个条目；显示顺序正好是 ST prompt 拼接顺序的反向 | 通过 |
| B5 | 删除只移除一个条目，`originalData` 不变 | 通过 |
| B6 | 服务器 500：返回 `WRITE_NOT_CONFIRMED`，文件不变，ST 页面缓存恢复为文件内容 | 通过 |
| B7 | ST 同书尚未落盘的防抖保存被保留 | 通过 |
| B8 | 另一标签页写过文件（ST 页面副本过期）：默认返回 `HOST_UNSAVED_CHANGES`；改用 `onHostDrift: 'use-stored'` 后写入，另一标签页的内容被保留，`hostChangesDiscarded` 为 `true` | 通过 |
| B9 | 基线之后同一字段被改：返回 `CONFLICT`，不覆盖 | 通过 |
| B17 | `saveHostCopy`：文件在报告差异之后又被改过时返回 `CONFLICT` 且不写入；指纹匹配时把 ST 页面副本存为文件，回读核对通过，ST 缓存与文件一致 | 通过 |
| B10 | ST 世界书编辑器打开同一本书时，Adapter 写入后编辑器再次保存，不会覆盖 Adapter 的修改 | 通过 |
| B15 | 真实 ST 编辑器显示一本书并展开条目后，页面缓存里的改写（本次观察到 51 处，涉及模板补齐、`role`、`delayUntilRecursion`、`sticky` 等）全部识别为自动改写，写入结果 `hostDrift` 为 `'normalized'`，不报 `HOST_UNSAVED_CHANGES` | 通过 |
| B16 | 真实 ST 编辑器把这些改写保存进文件后，带旧基线的 `updateEntry` 不报 `CONFLICT` | 通过 |
| B11 | `getActiveWorldbooks` 通过斜杠命令、context 与 DOM 读取，无副作用 | 通过 |
| B12 | 不存在的书：`WORLDBOOK_NOT_FOUND`，不会新建文件 | 通过 |
| B13 | `watchWorldbooks` 只报告页面内其他代码的保存 | 通过 |
| B14 | 聊天与聊天元数据不变，其他世界书列表不变 | 通过 |

### 尚未验证

| 项目 | 状态 |
| --- | --- |
| SillyTavern 1.18.x 及更早版本 | 未测试 |
| 移动端浏览器 | 未测试 |
| 真实的多设备同时编辑 | 只用直接写文件模拟过（B8、B9、B17） |
| 真实 AIRP 世界书样本 | 未取得样本，只用测试书验证过 |
