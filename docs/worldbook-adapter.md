# Worldbook Adapter（Phase 1）

本文说明 Phase 1 世界书数据层的结构、公开接口、写入流程与数据安全规则。字段语义与宿主行为的依据见 [SillyTavern 1.19.0 兼容性调研](compatibility/sillytavern-1.19.0.md)，测试方式见 [测试说明](testing.md)。

## 分层

```text
src/
├── index.js                     统一导出
├── core/                        与宿主无关
│   ├── worldbook-port.js        Core 依赖的接口约定（WorldbookPort）与按书绑定的 WorldbookHandle
│   ├── entry-patch.js           对原始条目做定向 Patch
│   ├── entry-compare.js         基线与当前条目的比较（冲突检测）
│   ├── order.js                 Order 读取、显示排序与最小改动规划
│   ├── json.js                  JSON 语义比较、差异路径、指纹
│   ├── keyed-lock.js            按世界书串行化
│   └── errors.js                错误类型与错误码
└── adapters/sillytavern/        SillyTavern 专用
    ├── st-host.js               所有宿主访问集中于此（context、HTTP、事件、DOM）
    ├── st-schema.js             SillyTavern 1.19.0 字段定义、默认模板、枚举、字段校验与编辑器自动改写规则
    └── st-worldbook-adapter.js  WorldbookPort 的 SillyTavern 实现
```

- Core 只依赖 `WorldbookPort` 的形状，不接触 `SillyTavern`、Tavern Helper 或 DOM。
- 宿主差异全部收在 `adapters/sillytavern/`。读取 ST 世界书编辑器当前打开的是哪本书只能通过 DOM（ST 没有 API 或事件），这部分只在 `st-host.js` 内。
- 条目始终是 SillyTavern 的原始对象。项目内没有缩减版的 Entry 结构，也没有"按已知字段重新拼装条目"的步骤。

## 运行环境

| 项目 | 说明 |
| --- | --- |
| 宿主 | SillyTavern 页面内，原生扩展（主窗口）或 Tavern Helper 脚本 iframe 均可（两者都已实测）：只需要 `SillyTavern.getContext()` 与同源 `fetch` |
| 已验证版本 | SillyTavern 1.19.0（`7e8663cd9c184a550b37238218bdd32c6efc68e9`）；Tavern Helper 4.11.0 仅作可选的只读来源 |
| 最低要求 | `getContext()` 需要提供 `loadWorldInfo`、`saveWorldInfo`、`getRequestHeaders`，以及 `getWorldInfoNames`（SillyTavern 1.18.0 起提供）或 Tavern Helper 的 `getWorldbookNames`。1.18.x 未实际验证 |
| 构建 | 无。纯 ES Module，无第三方依赖 |

## 公开接口

```js
import { createSillyTavernWorldbookAdapter } from './src/index.js';

const adapter = createSillyTavernWorldbookAdapter();
```

`createSillyTavernWorldbookAdapter(options?)` 在创建时检查宿主函数，缺失时抛出 `HOST_UNAVAILABLE`。

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `getContext` | `SillyTavern.getContext` | 宿主 context 获取函数 |
| `fetch` | 全局 `fetch` | 读取服务器上的世界书文件 |
| `tavernHelper` | 全局 `TavernHelper`（若存在） | 仅用于只读查询；传 `null` 可停用 |
| `document` | 自动探测（本窗口或同源父窗口） | 仅用于读取 ST 编辑器当前打开的书；传 `null` 可停用。停用或找不到编辑器时，每次写入后都会请 ST 编辑器重新读取这本书（见写入流程第 11 步） |
| `orderRange` | `{ min: 0, max: 9999 }` | Adapter 可分配的 Order 取值范围（ST 编辑器输入框范围） |
| `settleTimeoutMs` | `1500` | 每本书等待 ST 尚未落盘的保存的最长时间（ST 防抖为 1000 ms）。ST 编辑器正打开另一本有未落盘改动的书时，一次写入先后等这两本书，最多等两倍时间 |
| `sharedState` | 挂在 ST 页面窗口上的共享对象 | 各书的写入锁与"哪些保存来自 Adapter"的记录。同一页面内的所有 Adapter 实例（主窗口与各个脚本 iframe）默认共用，一般不需要传 |

所有方法的 `options` 都可以省略或传 `null`。

### 读取与切换

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `listWorldbooks({ refresh? })` | `string[]` | ST 当前已知的世界书名；`refresh: true` 先从服务器刷新列表 |
| `getActiveWorldbooks()` | `ActiveWorldbooks` | 全局、角色主书与附加书、群聊各成员的书、聊天绑定、人设、ST 编辑器当前打开的书，每项注明来源；只读，不改任何绑定 |
| `getWorldbook(name, { source? })` | `WorldbookSnapshot` | `data` 为整本书（含全部书级字段）；`entries` 为合法条目，按显示顺序排列；`anomalies` 列出违反 ST 约定的条目；`fingerprint` 为 `data` 的内容指纹；`source` 默认 `'stored'`（服务器文件），可选 `'cache'`（ST 页面内存副本） |
| `getEntry(name, uid, { source? })` | 原始条目或 `null` | 完整原始对象 |
| `worldbook(name)` | `WorldbookHandle` | 绑定到一本书的句柄，提供 `read`、`getEntry`、`createEntry`、`updateEntry`、`deleteEntry`、`moveEntry`、`saveHostCopy`，每次调用都只作用于这本书 |
| `watchWorldbooks(listener)` | 取消订阅函数 | 同一页面内其他代码（ST 编辑器、Tavern Helper 等）保存世界书时通知 `{ worldbook }`。按保存的对象识别 Adapter 自己的保存，所以 Adapter 正在写某本书时，别的代码对同一本书的保存照样会通知 |
| `describeHost()` | 对象 | 版本与可用宿主函数，便于诊断 |

读取结果都是私有副本，调用方修改不会影响 ST。

### 写入

| 方法 | 说明 |
| --- | --- |
| `createEntry(name, { fields?, placement?, onHostDrift? })` | 以 ST 1.19.0 新建条目模板为基础，叠加 `fields`；uid 取最小空闲整数；默认放在列表最上面（当前最大 Order + 1）。`fields.order` 与 `placement` 只能二选一 |
| `updateEntry(name, uid, patch, { baseline?, conflictScope?, onHostDrift? })` | 定向 Patch；未提及的字段原样保留。传入 `baseline` 时进行冲突检测 |
| `deleteEntry(name, uid, { baseline?, onHostDrift? })` | 删除一个条目；传入 `baseline` 时，条目有变化即拒绝 |
| `moveEntry(name, uid, placement, { expectedSequence?, onHostDrift? })` | 只通过修改 Order 调整显示位置；`expectedSequence` 为调用方看到的显示顺序（uid 数组），列表已变化时拒绝 |
| `saveHostCopy(name, { expectedStoredFingerprint? })` | 把 ST 页面里的这本书原样存为文件，用于回应 `HOST_UNSAVED_CHANGES`（见下文） |

写入结果的公共字段：

| 字段 | 含义 |
| --- | --- |
| `worldbook` | 书名 |
| `written` | 是否实际保存。请求没有产生任何变化时为 `false`，此时不保存 |
| `verified` | 已回读文件确认。成功返回时始终为 `true` |
| `hostDrift` | 写入前 ST 页面副本与文件的关系：`'none'` 一致；`'normalized'` 只差 ST 编辑器自动做的改写；`'substantive'` 有其他差异 |
| `hostChangesDiscarded` | 本次写入覆盖了 ST 页面副本中的实质差异（仅在 `onHostDrift: 'use-stored'` 时可能为 `true`） |
| `hostUnsavedBooks` | 保存时仍与文件有实质差异的其他书（目前检查 ST 编辑器正打开的那一本）。本次保存可能已取消了它排队中的防抖保存，界面可据此提醒用户 |

各方法另外返回：

| 方法 | 字段 |
| --- | --- |
| `createEntry` | `uid`、`entry`（写入的条目）、`orderChanges`（为腾出位置而改动的其他条目，`{ uid, from, to }`） |
| `updateEntry` | `uid`、`entry`、`changedPaths`（本次实际改变的路径）、`externalChanges`（基线之后条目上的所有变化路径，含 ST 自动改写的；无基线时为空） |
| `deleteEntry` | `uid`、`deleted`（被删除的条目） |
| `moveEntry` | `uid`、`order`（移动后的 Order）、`orderChanges`、`sequence`（移动后的显示顺序） |
| `saveHostCopy` | 只有 `worldbook`、`written`、`verified` |

### Patch

两种写法：

```js
{ content: '新内容', disable: false }                       // 顶层字段
[
  { path: ['characterFilter', 'names'], value: ['Alice'] }, // 深层路径
  { op: 'unset', path: 'myExtensionField' },                // 删除一个字段（ST 模板中的字段不能删除）
]
```

| 规则 | 说明 |
| --- | --- |
| 路径 | 字符串路径就是一个顶层键，不按 `.` 拆分，含点号的未知字段也能被精确指定。数组内只能写已有下标或紧接末尾的下标（不会产生空洞），删除数组元素请整体设置数组 |
| 受保护 | `uid` 不可修改；路径中不能出现 `__proto__`、`prototype`、`constructor` |
| 值 | 只接受 JSON 能原样保存的值：普通对象、无空洞数组、字符串、有限数字、布尔、`null`。`undefined` 被拒绝（删除请用 `unset`），含循环引用的值被拒绝。响应式框架的 Proxy 对象按其普通值写入 |
| 检查时机 | 整个 Patch 应用完之后，对每个被改动的顶层字段检查一次，深层写入与整字段写入同样受检 |
| 不可删除的字段 | ST 1.19.0 新建模板中的 39 个字段不能 `unset`，ST 默认条目上有这些字段。`characterFilter` 等模板之外的字段可以删除 |
| 别名 | `characterFilterNames`、`characterFilterTags`、`characterFilterExclude` 只是 ST 斜杠命令的别名，不能写入，请改写 `characterFilter` |
| 未知字段 | 不做任何检查，也不会被改写 |

已知字段按 ST 1.19.0 的取值范围检查：

| 字段 | 允许的值 |
| --- | --- |
| 字符串字段（`content`、`comment`、`group`、`outletName`、`automationId` 等） | 字符串 |
| 布尔字段（`disable`、`constant`、`selective` 等） | `true` / `false` |
| `caseSensitive`、`matchWholeWords`、`useGroupScoring` | 布尔或 `null` |
| `key`、`keysecondary` | 字符串数组（正则写成 `"/pattern/flags"`） |
| `triggers` | 数组，元素只能是 `normal`、`continue`、`impersonate`、`swipe`、`regenerate`、`quiet` |
| `position` | 0–7 |
| `role` | 0、1、2 或 `null` |
| `selectiveLogic` | 0–3 |
| `depth` | 0–10000 的整数 |
| `scanDepth` | `null` 或 0–1000 的整数 |
| `probability` | 0–100 |
| `groupWeight` | 1–10000 |
| `sticky`、`cooldown`、`delay` | `null` 或非负整数 |
| `delayUntilRecursion` | 布尔，或不小于 0 的层级数字 |
| `characterFilter` | `{ isExclude: boolean, names: string[], tags: string[] }` |
| `order`、`displayIndex` 等数字字段 | 有限数字 |

### Placement

`'top'`、`'bottom'`、`{ index }`（不含被移动条目时的显示位置）、`{ aboveUid }`、`{ belowUid }`，或同时给出相邻的 `aboveUid` 与 `belowUid`。

### 示例

以下代码已在 SillyTavern 1.19.0 页面中实际运行（导入路径按安装位置调整）：

```js
const { createSillyTavernWorldbookAdapter } = await import('/scripts/extensions/third-party/MieMie-Worldbook-Manager/src/index.js');

const adapter = createSillyTavernWorldbookAdapter();
const book = adapter.worldbook('Doc Example Book');

// 读取：完整原始对象，按 Order 从大到小排好
const snapshot = await book.read();
const first = snapshot.entries[0];

// 局部修改：只改 content，带基线做冲突检测
const updated = await book.updateEntry(first.uid, { content: `${first.content}\n（已更新）` }, { baseline: first });

// 新建：SillyTavern 默认模板，放在列表最上面
const created = await book.createEntry({ fields: { comment: '新条目', content: '来自工作对话。' } });

// 移动：放到 uid 0 与 uid 1 之间，只改必要条目的 Order
const moved = await book.moveEntry(created.uid, { aboveUid: 0, belowUid: 1 });

// 删除
const removed = await book.deleteEntry(created.uid);
```

对一本含两个条目（uid 0、1，Order 100、90）的书，实际结果为：`updated.changedPaths` 为 `[['content']]`，新条目 uid 2、Order 101，移动后 Order 95，只改了这一个条目。

ST 页面里有未存入文件的改动时，写入会被拒绝，由用户决定保留哪一边：

```js
try {
  await book.updateEntry(0, { comment: '新标题' });
} catch (error) {
  if (error.code !== 'HOST_UNSAVED_CHANGES') throw error;
  if (userKeepsSillyTavernVersion) {
    // 先把 ST 页面里的版本存为文件；文件在用户查看差异之后又被改过则返回 CONFLICT
    await book.saveHostCopy({ expectedStoredFingerprint: error.details.storedFingerprint });
    await book.updateEntry(0, { comment: '新标题' });
  } else {
    // 以文件为准写入，ST 页面里的差异被丢弃
    await book.updateEntry(0, { comment: '新标题' }, { onHostDrift: 'use-stored' });
  }
}
```

## 写入流程

每次写入都在该书的锁内按以下顺序执行。锁在同一页面的所有 Adapter 实例之间共用。

1. 确认书名在 ST 的世界书列表中（找不到时先刷新一次列表）。服务器对不存在的书会返回空壳并在保存时新建文件，所以这一步不能省。
2. 如果 ST 编辑器正打开另一本书，并且它的页面副本与文件有实质差异，先等它可能还在排队的防抖保存落盘（最长 `settleTimeoutMs`）。ST 的立即保存会取消其他书的防抖保存，这一步尽量避免这种丢失。等待之后仍有差异的书列在结果的 `hostUnsavedBooks` 中。
3. 读取目标书的文件，并与 ST 页面副本比较：
   - 只差 ST 编辑器自动做的改写（补模板字段、`role` 设为 `null`、展开条目时 `useProbability` 设为 `true` 等，完整清单见兼容性文档 3.4）：视为一致，直接继续。
   - 有其他差异：可能是 ST 还有一次防抖保存没落盘。等待该书下一次 `WORLDINFO_UPDATED`，最长 `settleTimeoutMs`，然后重读。读取过程中页面内有人保存了这本书，则重新读取。
4. 若文件读成了空壳，再核对一次列表，确认这本书没有在别处被删除。
5. 在文件内容的副本上执行定向修改：只改请求涉及的条目与字段，其余条目、书级字段（含 `originalData`）与未知字段的值和键顺序全部原样保留。条目不存在、基线冲突、Patch 不合法等错误在这一步报告。
6. 请求没有产生任何实际变化时（例如值相同、移动后位置不变），到此结束，不保存。
7. 第 3 步的实质差异仍然存在时，默认拒绝写入并返回 `HOST_UNSAVED_CHANGES`，不改任何东西；`onHostDrift: 'use-stored'` 时以文件为基础继续写入。
8. 第 3 步判定只差自动改写时，本次未涉及的条目改用 ST 页面副本中的版本，这正是 ST 下次保存会写入的内容。这样这些条目在 ST 中的 JSON 不变，ST 按条目 JSON 匹配的进行中 sticky/cooldown 不受影响。
9. 记下本次应写入的条目内容，然后调用 `saveWorldInfo(name, book, true)` 立即保存，同时更新 ST 页面缓存。
10. 重新读取文件，逐一核对本次涉及的条目与第 9 步记下的内容。
    - 核对通过才算成功。ST 在保存后把同一个对象交给 `WORLDINFO_UPDATED` 的监听者，监听者改动这个对象不会影响核对。
    - 核对失败时，读取文件的最新内容，把交给 ST 的那个对象原地改回文件内容，ST 页面缓存随之恢复（ST 按引用把它存为缓存）。这一步不再写入服务器；这本书已被删除时不做。然后抛出 `WRITE_NOT_CONFIRMED` 或 `WRITE_FAILED`。
    - 保存请求报错、但回读发现文件已写入时，按成功处理。
11. 如果 ST 世界书编辑器正显示这本书，调用 `reloadWorldInfoEditor`，防止编辑器之后用旧副本覆盖本次写入。
    - 编辑器没打开任何书时不调用：ST 会把"未打开"当作第 0 本书并把它打开。
    - 无法读取编辑器状态时（`document: null` 或找不到编辑器元素）每次都调用。不调用的话，编辑器里的旧副本之后可能覆盖本次写入；代价是编辑器没打开书、而这本书又排在列表第一位时，ST 会把它打开。

保存的是 JSON 解析后的值：由其他工具写入或导入的文件，第一次保存时会被重新格式化（缩进、`1.50` 写成 `1.5`、整数形式的键排到前面），超过 2^53 的整数会损失精度。ST 编辑器保存时也是如此。

## ST 页面副本与文件不一致

ST 页面内存里的书可能含有文件里没有的内容：ST 的一次保存失败了、ST 编辑器改动还没落盘，或者文件被其他标签页、其他设备改过。这时直接写入必然丢掉其中一边，所以 Adapter 拒绝写入，返回 `HOST_UNSAVED_CHANGES`：

| `details` 字段 | 含义 |
| --- | --- |
| `worldbook` | 书名 |
| `entries` | 有实质差异的条目：`{ uid, fields }`，`fields` 为有差异的字段名；条目只存在于一边时 `fields` 为 `null` |
| `bookKeys` | 有差异的书级字段 |
| `storedFingerprint` | 此刻文件内容的指纹 |

之后由用户选择：

| 选择 | 做法 | 效果 |
| --- | --- | --- |
| 以文件为准 | 带 `onHostDrift: 'use-stored'` 重试原操作 | 在文件内容上写入，ST 页面副本随之更新为文件内容，页面里的差异被丢弃；结果中 `hostChangesDiscarded` 为 `true` |
| 保留 ST 的版本 | `saveHostCopy(name, { expectedStoredFingerprint })`，然后重试原操作 | 把 ST 页面副本原样存为文件并回读核对；文件里独有的内容被覆盖。传入 `details.storedFingerprint` 时，如果文件在此之后又变了，返回 `CONFLICT` 且不写入 |

`saveHostCopy` 的其他规则：页面副本与文件一致时不保存（`written: false`）；书已在别处被删除时返回 `WORLDBOOK_NOT_FOUND`，不会重新建出文件；保存失败时不改动 ST 页面副本。

## 冲突检测

| 场景 | 行为 |
| --- | --- |
| `updateEntry` 带 `baseline`，默认 `conflictScope: 'entry'` | 基线之后条目有任何变化即返回 `CONFLICT`，ST 编辑器自动做的改写除外 |
| `conflictScope: 'fields'` | 只有本次要写的字段（含其父路径与子路径）在基线之后被改过，才返回 `CONFLICT`；其他字段的外部修改被保留，并在结果的 `externalChanges` 中列出 |
| 条目被换成了另一个 | 标题、主关键词、内容三者都与基线不同时，视为 uid 被新条目复用（ST 删除后会复用最小空闲 uid），两种范围都返回 `CONFLICT` |
| 基线之后条目被删除 | `updateEntry` 返回 `CONFLICT`，`details.current` 为 `null` |
| `deleteEntry` 带 `baseline` | 条目有变化即返回 `CONFLICT`，ST 编辑器自动做的改写除外 |
| `moveEntry` 带 `expectedSequence` | 当前显示顺序与调用方看到的不同即返回 `CONFLICT` |

`CONFLICT` 错误的 `details` 同时带有 `baseline`（调用方看到的版本）、`current`（最新版本）、`attempted`（本次想写成的样子，删除时没有）与 `changedPaths`，可直接用于后续的冲突界面。

默认按整条比较，对应 PRODUCT_PLAN §44"外部脚本修改了同一个条目时不直接覆盖"。ST 编辑器显示一本书时会在内存里改写字段并在下次保存时写进文件（完整清单见兼容性文档 3.4），这些改写不算冲突，已在真实 SillyTavern 中验证（B15、B16）。

## Order 规则

- 读取：与 ST 1.19.0 一致。数字按原值；数字字符串按数值；没有 `order` 字段视为 100（ST 编辑器会补上默认值）；`null`、空字符串与非数字字符串视为 0；布尔视为 0 或 1。
- 显示顺序：Order 大的在上，Order 相同按 uid 升序（与 ST 编辑器的 "Order ↘" 一致）。
- 移动或新建时：
  - 被放置的条目与相邻条目**严格不等**，因为 ST 生成 prompt 时，Order 相同的条目先后不确定。
  - 插入点有空隙时只改被放置的条目：中间取两邻居之间的值，顶部取最大值 + 1，底部取最小值 − 1。
  - 没有空隙时，把插入点一侧最近的一段条目推开，每个推开 1 个间隔。在所有可行方案中，选**现有 Order 值总变化量最小**的；其次选改动条目最少的；其次选接近自然值的；仍相同时取较小的值，让上方（优先级更高的）条目保持不变。
  - 不会制造原本不存在的并列；原本并列的一组条目被推开时保持同一个值。
  - 改动只发生在插入点两侧连续的一段内，不会整本重新编号。
  - Adapter 分配的新值是整数。被移动的条目若原值已满足位置要求，保持原值不变（包括字符串数字和小数）。未改动条目的原值（字符串数字、小数、负数、超出范围的值）保持原样。
  - 新值取自 `orderRange`。书中已有超出范围的值时，范围向外放宽到比这些值再多一格，放在这些条目旁边时不必把它们拉回范围内（那样会改变它们相对其他书的优先级）。
  - 空书中的第一个条目使用 ST 默认值 100。
  - 只有在插入点上下两侧直到取值范围边界都找不到可用的整数时，才返回 `ORDER_SPACE_EXHAUSTED`。
- 单元测试以 3000 轮随机用例（含小数、`null` 与缺失值）检查显示顺序、严格居中、不制造新并列、插入点同一侧的并列保持并列、取值范围与改动连续性，并对 200 个小规模用例做穷举对照：在"显示顺序正确、被放置条目严格居中、不制造新并列"的约束下，规划结果的总变化量都等于穷举得到的最小值。

## 错误码

| 代码 | 含义 |
| --- | --- |
| `HOST_UNAVAILABLE` | SillyTavern context 或必需函数不可用 |
| `INVALID_ARGUMENT` | 参数缺失或格式错误（书名、uid、placement、选项取值等） |
| `INVALID_PATCH` | Patch 格式错误、修改受保护字段、值无法按 JSON 保存，或已知字段的值不在 ST 的取值范围内 |
| `WORLDBOOK_NOT_FOUND` | 世界书不存在（包括在其他标签页被删除） |
| `ENTRY_NOT_FOUND` | 条目不存在 |
| `MALFORMED_DATA` | 目标条目违反 ST 约定（不是对象，或 key 不是规范整数、与 `uid` 不一致），拒绝写入且不做修改 |
| `READ_FAILED` | 读取失败、文件无法解析，或读取期间这本书一直在被保存 |
| `WRITE_FAILED` | 保存请求失败，且文件中没有本次修改 |
| `WRITE_NOT_CONFIRMED` | 保存返回了，但文件中没有本次修改，或无法回读确认 |
| `HOST_UNSAVED_CHANGES` | ST 页面副本与文件有实质差异，写入会丢掉其中一边（见上文） |
| `CONFLICT` | 基线之后目标已被他人修改 |
| `ORDER_SPACE_EXHAUSTED` | 取值范围内放不下所需的不同 Order 值 |

- 所有错误都是 `WorldbookError`（冲突为其子类 `WorldbookConflictError`），带有 `code`、`message` 与 `details`。
- 读写方法的错误一律通过返回的 Promise 拒绝。同步抛出错误的只有 `createSillyTavernWorldbookAdapter()` 与 `worldbook(name)`（书名不合法时）。
