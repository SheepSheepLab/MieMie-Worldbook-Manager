# SillyTavern 1.19.0 兼容性调研与 Compatibility Map

本文记录 Phase 1（Issue #1）对 SillyTavern World Info / Lorebook 与 Tavern Helper 世界书接口的调研结果，是 [Worldbook Adapter](../worldbook-adapter.md) 各项设计的依据。

## 1. 基线与方法

| 对象 | 版本 | 固定位置 |
| --- | --- | --- |
| SillyTavern | 1.19.0（2026-09-14 发布，当前最新 release） | commit `7e8663cd9c184a550b37238218bdd32c6efc68e9` |
| Tavern Helper（JS-Slash-Runner） | 4.11.0（2026-09-22，当前最新 tag） | commit `18544ddfd2a477adb69552f639f7a1b8d39039cc` |

- 结论依据当前源码逐行阅读，每条均附源码位置。`ST:` 指 SillyTavern 仓库，`TH:` 指 Tavern Helper 仓库，行号对应上表 commit。
- 与数据安全相关的关键结论，另在本地运行的 SillyTavern 1.19.0 + Tavern Helper 4.11.0 中实测（主窗口与 Tavern Helper 脚本 iframe 各一次），编号 A1–A7 见 [测试说明](../testing.md#真实-sillytavern-集成测试)。
- 官方文档（docs.sillytavern.app World Info 页）与 1.17.0–1.19.0 的 release notes 已对照：这三个版本没有新增条目字段；与源码不一致之处在下文注明。

## 2. 结论速览

1. **世界书文件结构**：`{ entries: { "<uid>": entry }, ... }`。`entries` 是唯一必需的键；`originalData`、`name`、`extensions` 等书级字段也会被原样存取。
2. **条目字段**：1.19.0 定义了 42 个字段（`newWorldInfoEntryDefinition`），其中 39 个进入新建模板。此外 `uid`、`displayIndex`、`characterFilter`、`extensions`（角色卡导入）、`extra`（Tavern Helper）等也会出现在存储的条目上。
3. **无损写入必须走 SillyTavern 原生接口**：`getContext().loadWorldInfo / saveWorldInfo` 与服务器端 `/api/worldinfo/edit` 原样保存整个对象，不删任何键。
4. **Tavern Helper 的世界书写入接口都是有损的**：会按自身模型重建整本书，只保存 `{ entries }`。实测一次"原样读写"就丢失了书级字段、未知字段和 `extensions`，并改动了 `delayUntilRecursion`、`useProbability`/`probability`、`selective`、`displayIndex`、未知 position 等值（A7）。它的 `getWorldbook` 遇到缺 `keysecondary` 的旧条目会直接抛错（A6）。所以 Tavern Helper 只用于只读查询。
5. **`saveWorldInfo` 从不报告 HTTP 失败**：服务器返回 500 时它照样 resolve，还先把未保存的数据写进了页面缓存（A1）。因此每次写入都必须回读确认。
6. **全局只有一个保存防抖**：立即保存任何一本书，都会取消另一本书还在排队的防抖保存（A2）。这是 ST 自身行为，Adapter 无法消除，只能规避同书的情况。
7. **Order 语义**：在同一插入位置内，Order 越大越靠近上下文末尾；↑EM 和 Outlet 两个位置方向相反。最终拼接 prompt 时，所有生效世界书的条目按 Order 统一排序，所以 Order 值在书与书之间是共用的。Order 相同的条目先后不确定。
8. **ST 没有版本号或锁**：写入是整文件覆盖，后写者胜。冲突检测只能由 Adapter 自己比较内容。
9. **ST 编辑器会自己改写字段**：显示一本书、展开条目时，编辑器在页面缓存里补模板字段、规范数值和布尔值，下次保存时一并写进文件（清单见 3.4）。比较内容时必须把这些改写和真正的编辑区分开，否则几乎每次都会误报。

## 3. Compatibility Map

### 3.1 数据与身份

| 产品目标 | SillyTavern 实际字段 / 行为 | 使用接口 | 依据 | 差异 / 限制 |
| --- | --- | --- | --- | --- |
| 世界书文件 | `data/<user>/worlds/<sanitize(name)>.json`；身份即文件名；内容 `{ entries: {...}, originalData?, name?, extensions?, ... }` | 读：`POST /api/worldinfo/get`；写：`getContext().saveWorldInfo(name, data, true)` | ST:src/endpoints/worldinfo.js:17-35, 134-157 | `/edit` 只校验 `entries` 存在，然后 `JSON.stringify(data, null, 4)` 整文件覆盖。服务器不删字段，但会重新缩进；整数形式的键按升序输出 |
| 读取不存在的书 | `/get` 对不存在的文件返回 `{ entries: {} }`（HTTP 200），`/edit` 会新建任何名字 | Adapter 每次操作前先核对世界书列表 | ST:src/endpoints/worldinfo.js:17-35, 71-79；实测 A4 | 拼错书名或已在别处删除的书，若不先核对，会被"读成空书"或"写回来" |
| 条目 UID | 整数，每本书内唯一。新建时取最小空闲整数（`getFreeWorldEntryUid`，< 1,000,000），删除后会被复用 | Adapter 同样取最小空闲值，并额外避开只存在于 ST 页面副本中的 uid | ST:public/scripts/world-info.js:4137-4149, 4395-4409 | 因为 uid 会复用，冲突检测需要比较内容，不能只看 uid 是否存在 |
| 条目 key 与 `uid` | ST 默认 `entries` 的 key 等于 `String(entry.uid)`，编辑器、运行时和斜杠命令混用按 key 与按值两种查找 | 读取时报告不一致的条目（`anomalies`）；写入时拒绝修改这类条目（`MALFORMED_DATA`） | ST:public/scripts/world-info.js:2358-2367, 4515, 4797 | 不一致时 ST 自己会写错条目，所以 Adapter 不猜测、不修复 |
| 空条目 | `entries` 中出现 `null` 时，运行时解构报错，这次生成的整个 World Info 都会失效 | 保留原值，报告为 `anomalies`，不写入新的 `null` | ST:public/scripts/world-info.js:4535, 4590-4643 | — |
| `originalData` | 仅由角色卡导入（`convertCharacterBook`）产生。编辑器的镜像写入按 `uid` 查找，但卡片条目只有 `id`，实际上找不到任何条目。服务器保存角色时虽然先读 `originalData`，下一行就用 `entries` 重新生成的内容覆盖了 | 原样保留，不镜像 | ST:public/scripts/world-info.js:2687-2784, 5617-5674；ST:src/endpoints/characters.js:628-644 | 嵌进角色卡的世界书始终由 `entries` 生成，所以原样保留 `originalData` 与 ST 的实际效果一致 |
| 条目 `extensions` | 角色卡导入的条目带有 `extensions`（含第三方卡片扩展数据）。ST 编辑时不更新它，导出到卡片时先展开它再覆盖已知键 | 原样保留 | ST:public/scripts/world-info.js:5667；ST:src/endpoints/characters.js:682-684 | Tavern Helper 的写入会删掉它（A7） |
| 未知字段 / 新版本字段 | ST 编辑器保存整个对象，未知字段随之保留 | Adapter 的定向 Patch 不会碰未涉及的字段 | ST:public/scripts/world-info.js:4151-4190 | 运行时副本上的 `world`、`decorators`、`hash` 是 ST 内部字段，不会写回文件 |

### 3.2 条目字段

"默认值"指 ST 1.19.0 新建模板中的值（ST:public/scripts/world-info.js:4082-4129）。Adapter 对所有字段都通过原始对象读写（`entry.<字段>`），下表只列语义与差异。

| 产品目标 | ST 字段 | 类型 / 默认值 | 语义要点 | 依据 | 差异 / 限制 |
| --- | --- | --- | --- | --- | --- |
| 启用 / 停用 | `disable` | boolean / `false` | 启用 = `!disable`；运行时判断用 `entry.disable == true` | world-info.js:4094, 4801-4804 | 条目上没有 `enabled` 字段；角色卡格式用 `enabled` |
| 标题 / Memo | `comment` | string / `''` | 编辑器标题；为空时显示关键词 | world-info.js:4085, 3371-3387 | 编辑器渲染时会把 CRLF 变成 LF（jQuery `val()`） |
| 内容 | `content` | string / `''` | 开头的 `@@activate` / `@@dont_activate` 是装饰器，运行时剥离 | world-info.js:4086, 4652-4698 | — |
| 策略 Strategy | `constant`、`vectorized` | boolean / `false`、`false` | 没有单独的 strategy 字段：`constant === true` 为常驻，否则 `vectorized === true` 为向量化，否则为关键词触发。两者都为 true 时常驻优先 | world-info.js:4087-4088, 3284-3316 | 切换策略时 ST 会同时写这两个布尔值（`strategyPatch()` 提供同样的写法）；核心扫描不读 `vectorized`，由 Vectors 扩展使用 |
| 主关键词 | `key` | string[] / `[]` | 纯文本或 `/pattern/flags` 形式的正则字符串 | world-info.js:4083, 4905-4917, 337-366 | 必须以字符串存储，不能存 RegExp 对象 |
| 可选过滤 | `keysecondary` | string[] / `[]` | 只有 `selective` 为真且非空时才参与判断 | world-info.js:4084, 4924-4988 | — |
| `selective`（计划书未列出） | `selective` | boolean / `true` | 不是策略，只决定是否启用可选过滤；ST 编辑器展开条目时会强制设为 true | world-info.js:4089, 4925, 3614-3630 | 从角色卡导入的 `selective: false` 在被 ST 编辑器打开之前，可选过滤不生效 |
| 逻辑 Selective Logic | `selectiveLogic` | enum / `0` | `AND_ANY 0`、`NOT_ALL 1`、`NOT_ANY 2`、`AND_ALL 3` | world-info.js:33-38, 4939-4978 | 超出范围时带过滤器的条目永远不会触发 |
| 插入位置 Position | `position` | number / `0` | `↑Char 0`、`↓Char 1`、`↑AN 2`、`↓AN 3`、`@D 4`、`↑EM 5`、`↓EM 6`、`Outlet 7` | world-info.js:855-864, 5212-5262 | 未知值：条目会被激活并占预算，但不插入任何位置 |
| 深度 Depth | `depth` | number / `4` | 仅 `position === 4` 时使用；运行时 `entry.depth ?? 4` | world-info.js:96, 4107, 5235-5246 | ST 编辑器渲染时 `null` 会变成 0 |
| 角色 Role | `role` | enum / `0` | `SYSTEM 0`、`USER 1`、`ASSISTANT 2`；仅 `@D` 使用，运行时 `role ?? SYSTEM` | script.js:494-498；world-info.js:4117, 5236-5243 | ST 编辑器渲染时，非 `@D` 条目的 `role` 会被设为 `null`（运行效果相同） |
| 触发概率 | `probability`、`useProbability` | number / `100`，boolean / `true` | `!useProbability` 或 `probability === 100` 时不掷骰 | world-info.js:4105-4106, 5028-5049 | ST 编辑器展开条目时把 `useProbability` 强制设为 true；`probability: null` 在渲染时会变成 0 |
| 包含组 Inclusion Group | `group` | string / `''` | 逗号分隔可属于多个组 | world-info.js:4109, 5388-5475 | 跨扫描轮次的"已激活"判断按整串比较，多组条目有误差 |
| 组权重 Group Weight | `groupWeight` | number / `100` | 组内加权随机 | world-info.js:97, 4111, 5451-5465 | UI 实际取值范围 1–10000 |
| 优先包含 Prioritize Inclusion | `groupOverride` | boolean / `false` | 组内所有优先条目中 **Order 最高者** 胜出 | world-info.js:4110, 5443-5449 | 改 Order 可能改变组内胜出者 |
| 组评分 Group Scoring | `useGroupScoring` | boolean \| null / `null` | `null` 跟随全局；任一成员为 true 即启用该组评分 | world-info.js:4115, 5292-5328 | — |
| Automation ID | `automationId` | string / `''` | 条目激活时执行对应 Quick Reply | world-info.js:4116；extensions/quick-reply/src/AutoExecuteHandler.js:85-100 | 执行顺序跟随 Quick Reply 列表，不跟随激活顺序（官方文档未说明） |
| 角色过滤 Character Filter | `characterFilter` | `{ isExclude, names, tags }`，不在模板中 | `names` 是角色头像文件名（不含扩展名），`tags` 是标签 ID | world-info.js:4121-4123, 4815-4843 | 编辑器展开条目时会删掉本地不存在的角色名；`characterFilterNames/Tags/Exclude` 只是斜杠命令别名，不是存储字段 |
| 触发类型 Triggers | `triggers` | string[] / `[]` | 空数组 = 全部；可选 `normal`、`continue`、`impersonate`、`swipe`、`regenerate`、`quiet` | constants.js:36-43；world-info.js:4806-4813 | 编辑器会丢弃未知值 |
| 扫描深度覆盖 | `scanDepth` | number \| null / `null` | `null` 使用全局值；上限 1000 | world-info.js:98, 4112, 279-293 | — |
| 大小写 / 整词匹配覆盖 | `caseSensitive`、`matchWholeWords` | boolean \| null / `null` | `null` 使用全局值；正则关键词忽略这两项 | world-info.js:4113-4114, 268-271 | `/setentryfield` 可能写入字符串 `'false'`（类型漂移），Adapter 原样保留 |
| 递归选项 | `excludeRecursion`、`preventRecursion`、`delayUntilRecursion` | boolean / `false`、`false`；boolean \| number / `0` | `delayUntilRecursion` 为 true 表示第 1 层，数字表示层级 | world-info.js:4096-4097, 4104, 4753-4762, 4860-4873 | 必须保留 boolean 与 number 的区别；Tavern Helper 会把 `true` 写成 `false`（A7） |
| Sticky / Cooldown / Delay | `sticky`、`cooldown`、`delay` | number \| null / `null` | `null` 和 0 都表示关闭 | world-info.js:4118-4120, 584-611 | 进行中的 sticky/cooldown 按整条条目的哈希匹配（见 3.5） |
| 向量化 Vectorized | `vectorized` | boolean / `false` | 见"策略" | world-info.js:4088；extensions/vectors/index.js:1659 | — |
| Outlet | `outletName` | string / `''` | 仅 `position === 7` 时使用，通过 `{{outlet::名称}}` 宏输出 | world-info.js:4108, 5248-5258；macros.js:668 | Outlet 内 Order 越大越靠前（见 3.5） |
| 额外匹配来源（计划书未列出） | `matchPersonaDescription`、`matchCharacterDescription`、`matchCharacterPersonality`、`matchCharacterDepthPrompt`、`matchScenario`、`matchCreatorNotes` | boolean / `false` | 为 true 时把对应文本加入该条目的扫描范围 | world-info.js:4098-4103, 299-316 | — |
| 忽略预算（计划书未列出） | `ignoreBudget` | boolean / `false` | 预算溢出后仍插入 | world-info.js:4095, 5017-5026 | 官方文档未说明 |
| `addMemo`（计划书未列出） | `addMemo` | boolean / `false` | 仅界面用途，无运行效果 | world-info.js:4091, 3586-3598 | — |
| 编辑器自定义排序（计划书未列出） | `displayIndex` | number，不在模板中 | 只用于 ST 编辑器的 "Custom" 排序与拖拽，无运行效果 | world-info.js:2170-2176, 2365, 2656-2682 | ST 编辑器拖拽只改它、不改 Order；Adapter 不修改它 |
| 插入顺序 Order | `order` | number / `100` | 见 3.5 | world-info.js:88, 4092 | — |

1.19.0 在计划书清单之外存储的字段：`selective`、`addMemo`、`ignoreBudget`、六个 `match*`、`displayIndex`、`extensions`、`extra`。三个 `characterFilter*` 别名只存在于定义中。模板与字段定义已在运行中的 ST 1.19.0 上逐项比对一致（A5）。

### 3.3 世界书获取与切换

| 产品目标 | SillyTavern 实际来源 | Adapter 读取方式 | 依据 | 差异 / 限制 |
| --- | --- | --- | --- | --- |
| 世界书列表 | `world_names`（页面加载与 `updateWorldInfoList()` 时更新） | `getContext().getWorldInfoNames()`（1.18.0 起提供）；需要时 `updateWorldInfoList()` 刷新 | st-context.js:281-284；world-info.js:2061-2084 | 其他标签页新建或删除的书，要刷新后才可见；`updateWorldInfoList` 会请求整个 `/api/settings/get` |
| 全局世界书 | `selected_world_info`（不在 context 中） | `/getglobalbooks` 斜杠命令（只读）；回退 Tavern Helper `getGlobalWorldbookNames` | world-info.js:1604-1614, 1666-1672 | Tavern Helper 读的是 `world_info.globalSelect`，界面修改后最多滞后约 1 秒 |
| 角色主书 | `characters[chid].data.extensions.world` | `getContext().characters[characterId]` | world-info.js:4475-4525 | — |
| 角色附加书 | `world_info.charLore`（不在 context 中） | `/getcharbook type=additional`（只读）；回退 Tavern Helper `getCharWorldbookNames` | world-info.js:1115-1152, 1699-1738 | — |
| 群聊成员的书 | 群聊中 `this_chid` 仅在生成时逐个成员切换 | 逐个成员读取：主书来自 `characters`，附加书用 `/getcharbook type=additional "<头像文件名>"`（指定角色时只读），回退 Tavern Helper | world-info.js:1115-1152 | 未安装的成员，以及头像文件名含 `"`、`\`、`\|`、`{`、`}` 的成员不走斜杠命令（ST 会弹出错误提示），这时只能靠 Tavern Helper，都不可用时 `additional` 为 `null` |
| 聊天绑定书 | `chat_metadata['world_info']` | `getContext().chatMetadata.world_info`，只读；指向已删除的书时标记 `dangling` | world-info.js:94, 4544-4562 | **不使用** `/getchatbook`：其 `create` 默认为 true，会新建世界书并写聊天文件（world-info.js:1159-1182, 1642-1665）；也不使用 Tavern Helper 的 `getChatWorldbookName`，它读取时会删掉失效的绑定 |
| 人设书 | `power_user.persona_description_lorebook` | `getContext().powerUserSettings` | world-info.js:4564-4588 | — |
| ST 编辑器当前打开的书 | `#world_editor_select` 的值（`world_names` 下标） | 仅能读 DOM，隔离在 `st-host.js` | world-info.js:6213-6224 | 没有 API 与事件；编辑器切换书时 ST 不发任何事件 |
| 切换 | ST 自身的绑定写入都会改设置、角色卡或聊天文件 | Adapter **不改** ST 的任何绑定；"切换"即以另一书名取得 `WorldbookHandle`，之后的操作都只作用于该书 | world-info.js:4232-4338；TH:src/function/lorebook.ts:249-362 | 默认显示哪本书需由产品决定（见第 6 节） |

### 3.4 条目 CRUD 与持久化

| 产品目标 | SillyTavern 实际行为 | Adapter 的做法 | 依据 | 差异 / 限制 |
| --- | --- | --- | --- | --- |
| 读取 | `loadWorldInfo`：缓存命中返回深拷贝；**未命中时返回缓存对象本身**；缓存从不主动失效 | 默认直接读取服务器文件（与 `loadWorldInfo` 同一接口）；页面缓存只用于判断是否还有未落盘的保存；所有结果都是私有副本 | world-info.js:882, 2036-2059；util/StructuredCloneMap.js:29-55；实测 A3 | 缓存看不到其他标签页的写入；ST 编辑器渲染时会原地改写缓存对象 |
| 保存 | `saveWorldInfo(name, data, immediately)`：先按引用写入缓存；`immediately` 为 true 时立即 POST；否则进入**全书共用**的 1000 ms 防抖。`_save` 不检查响应状态，并始终发出 `WORLDINFO_UPDATED` | 始终 `immediately = true`；交给 ST 的对象之后不再修改；保存后回读文件核对 | world-info.js:83, 4151-4190；utils.js:574-623；实测 A1、A2 | 立即保存会取消另一本书尚未落盘的防抖保存（ST 自身行为，见第 5 节） |
| 新建 | `createWorldInfoEntry`：最小空闲 uid + 模板，不设 `displayIndex`，不保存 | 同样的模板与 uid 规则；Order 按 MieMie 规则（默认置顶） | world-info.js:4137-4149 | ST 自己新建条目的 Order 固定为 100 |
| 修改 | ST 编辑器与 `/setentryfield`：修改后保存整本书 | 在文件内容上做定向 Patch，保存整本书，只有目标字段改变 | world-info.js:1343-1447, 3379-3399 | `/setentryfield` 走防抖、只能改已定义字段，并按字符串转换类型，不适合 MieMie 使用 |
| 删除 | `deleteWorldInfoEntry`：`delete data.entries[uid]`，不保存，不处理 `originalData` | 同样只删除该键 | world-info.js:4043-4073 | ST 编辑器删除时另会调用 `deleteWIOriginalDataValue`，但由于上文的 `id`/`uid` 不匹配，实际上什么也不做 |
| 失败识别 | ST 不提供任何成功信号 | 回读核对，核对的是交给 ST 之前记下的内容；失败时把交给 ST 的对象原地改回文件最新内容，ST 页面缓存随之恢复，不再写服务器 | world-info.js:4151-4161 | — |
| 外部修改通知 | `WORLDINFO_UPDATED(name, data)`：仅在本页面 `_save` 完成后发出（失败也发）；`data` 就是交给 `saveWorldInfo` 的那个对象，监听者可以改动它 | `watchWorldbooks()` 转发，按对象识别并过滤掉 Adapter 自己的保存；写入前据此等待同书的防抖保存落盘 | events.js:42；world-info.js:4160 | 看不到其他标签页的写入，也不能说明写入成功；新建、删除、导入书时 ST 不发事件 |
| ST 编辑器旧副本 | 编辑器闭包持有整本书副本，任何字段修改都会保存整本书，外部写入之后会被覆盖回去 | 写入后若编辑器正显示该书，调用 `reloadWorldInfoEditor` | world-info.js:2310-2311, 1040-1046；实测 B10 | `reloadEditor` 会清空 ST 编辑器的搜索与分页；编辑器没打开书时，它会把第 0 本书打开，所以 Adapter 这时不调用它 |
| ST 编辑器的自动改写 | 编辑器显示一本书、展开条目时，会在页面缓存里原地改写字段（见下表），下次保存时一并写进文件 | 判断页面副本是否有未落盘改动、判断基线冲突时，这些改写不算差异；页面副本只差这些改写时，写入中未涉及的条目按页面副本保存 | 见下表；实测 B15、B16 | 与自动改写结果完全相同的人工修改无法区分，也按自动改写处理 |
| 页面副本与文件不一致 | 页面缓存可能含有未落盘或保存失败的改动；文件也可能被其他标签页改过。ST 下次保存会整本覆盖 | 有实质差异时拒绝写入（`HOST_UNSAVED_CHANGES`），由调用方选择以文件为准（`onHostDrift: 'use-stored'`）或保留 ST 的版本（`saveHostCopy`） | 实测 A1、B8、B17 | 见第 5 节 |

ST 1.19.0 编辑器的自动改写（`st-schema.js` 的 `isHostNormalization` 按此判断）：

| 时机 | 改写 | 依据 |
| --- | --- | --- |
| 显示条目列表 | 缺少的模板字段补默认值；`key`、`keysecondary` 不是数组时改为 `[]`；缺少 `characterFilter` 时补空过滤器；缺少 `displayIndex` 时设为 uid | world-info.js:2104-2136, 2365-2370 |
| 渲染条目标题 | `comment`、`content` 去掉 `\r`；`order`、`probability`、`depth` 转为数字（`null`、空串变 0，非数字的 `order` 变 0）；`probability` 限制在 0–100；非 `@D` 条目的 `role` 设为 `null`，`@D` 条目的 `null` 设为 0；`constant`、`vectorized` 只保留严格的 `true`（两者都为真时常驻优先） | world-info.js:3173-3190, 3255-3316, 3371-3452 |
| 展开条目 | `addMemo`、`selective`、`useProbability` 设为 `true`；各复选框字段转为布尔；`caseSensitive`、`matchWholeWords`、`useGroupScoring` 转为布尔或 `null`；`groupWeight` 的 `null` 变 1 并限制在 1–10000；`scanDepth` 规范为 `null` 或 0–1000 的整数；`group` 去掉首尾空白；`triggers` 去掉未知值；`characterFilter` 删掉本地未安装角色的名字，全空时删除整个字段；`delayUntilRecursion` 为假值时变 `false`，字符串转为数字 | world-info.js:3555-3868 |
| 输入框回写 | `sticky`、`cooldown`、`delay` 的 `null` 变 0；`outletName`、`automationId` 的 `null` 变空串；字符串形式的 `position`、`selectiveLogic` 转为数字 | world-info.js:3371-3868 |

### 3.5 Order

| 项目 | SillyTavern 实际行为 | 依据 |
| --- | --- | --- |
| 存储 | 条目字段 `order`，number，默认 100。UI 输入框 `min=0 max=9999`，但 JS 不强制；输入非数字时存 0 | world-info.js:4092, 3389-3401；index.html:7212 |
| 非常规值 | 缺少 `order`：ST 编辑器显示这本书时补为 100，下次保存写进文件；在此之前，prompt 排序中它与其他条目比较得到 `NaN`，位置不确定。`null`、空串与非数字字符串：编辑器渲染时变为 0；prompt 排序中 `null`、空串按 0 比较，非数字字符串同样得到 `NaN`。数字字符串按数值比较 | world-info.js:88, 2104-2136, 2370, 3389-3401 |
| 在 prompt 中的位置 | 拼接时，所有已激活条目（来自所有生效的书）一起按 `b.order - a.order` 排序，再逐个 `unshift` 进对应位置，所以文本中是**升序**：同一位置内 Order 越大越靠后，也就越靠近上下文末尾 | world-info.js:88, 5201-5246 |
| 反向的位置 | Outlet（7）用 `push`，Order 越大越靠前；↑EM（5）在 `script.js` 中逐个 `unshift` 进示例消息，Order 越大越靠前 | world-info.js:5248-5258；script.js:4638-4653 |
| 预算与优先 | 扫描时 Order 高者先处理：预算溢出时先丢 Order 低的（在各自来源分组内）；`groupOverride` 的组内胜出者是 Order 最高者 | world-info.js:4590-4625, 4993-5006, 5443-5449 |
| 跨书 | 拼接 prompt 时所有书一起排序；扫描阶段按插入策略（evenly / character_first / global_first）分组，聊天书与人设书总在最前 | world-info.js:4606-4625, 5203 |
| 相同 Order | 排序稳定，先后取决于激活顺序；再经 `unshift` 反转。同一本书、同一轮时 uid 小的反而更靠后。实际结果受 sticky、递归轮次与插入策略影响，每次生成可能不同 | world-info.js:4999, 5075, 5203-5214 |
| ST 编辑器显示 | 默认 "Priority"（常驻 → 普通 → 停用，再按 Order 降序、uid 升序）；另有 "Order ↘"；"Custom" 按 `displayIndex` | world-info.js:2146-2210；index.html:4852-4867 |
| ST 的重编号 | 只有用户手动点的 "Apply Current Sorting" 会整本重编号（1.19.0 起可设起点与步长）；ST 编辑器拖拽只改 `displayIndex` | world-info.js:2496-2618, 2656-2682 |
| 修改的副作用 | 进行中的 sticky/cooldown 记录在 `chat_metadata.timedWorldInfo` 中，按整条条目 JSON 的哈希匹配。修改一个条目的**任何**字段（包括 Order），它进行中的效果都会失配 | world-info.js:593-611, 4627-4634 |

对应的 MieMie 规则（详见 [Adapter 文档](../worldbook-adapter.md#order-规则)）：非常规值按 ST 编辑器的解释读取（缺失为 100，`null`、空串与非数字值为 0），书在 ST 编辑器中打开并保存一次后也正是这些值；显示时 Order 大者在上，与 ST 的 "Order ↘" 一致；移动时只改插入点附近连续的一段，被移动条目与邻居严格不相等，不制造新的并列；Adapter 分配的新值是整数，默认取 0–9999，书中已有超出这个范围的值时向外放宽一格；未改动条目的原值保持不变，它们在 ST 页面中的 JSON 也保持不变（页面副本只差自动改写时沿用页面副本），因此进行中的 sticky/cooldown 不受影响；以文件为准丢弃页面差异（`onHostDrift: 'use-stored'`）时除外。

### 3.6 Tavern Helper 4.11.0 接口

Tavern Helper 在主窗口挂载 `window.TavernHelper`，脚本 iframe 中的同名函数直接引用主窗口实现（TH:src/function/index.ts；TH:src/iframe/predefine.js:1-34）。

| 接口 | 行为 | 依据 | MieMie 使用 |
| --- | --- | --- | --- |
| `getWorldbookNames` | `world_names` 的副本 | TH:src/function/worldbook.ts:23-25 | 列表的回退来源 |
| `getGlobalWorldbookNames` | 读 `world_info.globalSelect`（可能滞后约 1 秒） | worldbook.ts:27-29 | 全局书的回退来源 |
| `getCharWorldbookNames` | 只读 | worldbook.ts:50-52；lorebook.ts:219-243 | 附加书、群聊成员的来源 |
| `getTavernHelperVersion` | 返回 manifest 版本 | TH:src/function/version.ts:5-15 | 诊断 |
| `getWorldbook` | 经 `toWorldbookEntry` 转换后的视图（按 `displayIndex` 排序），不是原始对象；遇到缺 `keysecondary` 的条目直接抛错 | worldbook.ts:205-261, 356-365；实测 A6 | **不使用** |
| `createOrReplaceWorldbook` / `replaceWorldbook` / `updateWorldbookWith` / `createWorldbookEntries` / `deleteWorldbookEntries` | 都经 `fromWorldbookEntry` 从头重建**每一个**条目，只保存 `{ entries }`，走 ST 防抖保存 | worldbook.ts:262-324, 377-473；实测 A7 | **不使用**（有损） |
| `getLorebookEntries` / `setLorebookEntries` / `createLorebookEntries` / `deleteLorebookEntries`（3.4.0 起废弃） | 从默认值重建条目，损失比 Worldbook 接口更多：丢 `characterFilter`、`triggers`、`outletName`、`ignoreBudget`、`extra`，重置 `match*`，Outlet 变成 `@D` | TH:src/function/lorebook_entry.ts:94-430；TH:CHANGELOG.md（3.4.0） | **不使用** |
| `rebindChatWorldbook` / `getOrCreateChatWorldbook` / `getChatWorldbookName` | 前两者写聊天文件；后者读取时会删掉失效的绑定 | worldbook.ts:65-82；lorebook.ts:310-362 | **不使用**（会影响正式聊天） |
| `importRawWorldbook` | 原样写入条目，但只保留 `entries`、丢弃书级字段 | TH:src/function/import_raw.ts:89-97 | 不使用 |

A7 的实测结果（对含未知字段的测试书执行一次 `updateWorldbookWith(name, entries => entries)`）：

- 书级 `originalData`、`name`、`extensions` 和自定义键全部丢失。
- 条目的未知字段、`extensions` 丢失。
- `delayUntilRecursion` 从 `true` 变为 `false`。
- `useProbability`/`probability` 从 `false`/35 变为 `true`/100。
- `selective` 从 `false` 变为 `true`。
- 正则关键词 `/Alice/ig` 变为 `/Alice/gi`。
- `displayIndex` 从 17 变为 4。
- 未知的 position 8 变为 4。

### 3.7 正式接口与需要隔离的行为

| 操作 | 正式接口 | Adapter 的实现 |
| --- | --- | --- |
| 列出世界书 | `getContext().getWorldInfoNames()`、`updateWorldInfoList()` | 直接使用 |
| 读取世界书 / 条目 | `getContext().loadWorldInfo()`（有缓存别名与失效问题） | 使用 ST 自己也在用的 `POST /api/worldinfo/get` 读文件；`loadWorldInfo` 只用于和页面缓存比较 |
| 保存 | `getContext().saveWorldInfo(name, data, true)` | 直接使用，外加回读核对 |
| 新建条目的模板 | 无（`newWorldInfoEntryTemplate` 只能 ES import，不在 context 中） | 在 `st-schema.js` 固定 1.19.0 的定义，已与运行时逐项比对（A5） |
| 全局书、角色附加书 | 无 context 接口；有只读斜杠命令 | `executeSlashCommandsWithOptions('/getglobalbooks')` 等，回退 Tavern Helper |
| ST 编辑器当前打开的书 | 无 | 读 DOM `#world_editor_select`，隔离在 `st-host.js` |
| 刷新 ST 编辑器 | `getContext().reloadWorldInfoEditor()` | 仅在编辑器正显示目标书时调用 |
| 外部修改通知 | `eventSource` + `WORLDINFO_UPDATED` | 直接使用 |
| 冲突检测 / 版本 | 无（服务器无版本号、无锁） | Adapter 自行比较内容 |

## 4. 与 PRODUCT_PLAN.md 的差异及处理

| 计划书 | 当前实现情况 | 处理方式 | 是否改变产品行为 |
| --- | --- | --- | --- |
| §45 优先使用 Tavern Helper 的 `getWorldbook`、`updateWorldbookWith`、`getLorebookEntries`、`setLorebookEntries`、`createLorebookEntries`、`deleteLorebookEntries` | 这些写入接口会丢字段、改值（A6、A7），Lorebook 系列已废弃 | 读写都改用 SillyTavern 原生 context 接口；Tavern Helper 只用于只读查询 | 否，属于技术路径调整；计划书 §3"不得删除未识别字段"的要求因此得以满足 |
| §3 字段清单 | 1.19.0 另有 `selective`、`addMemo`、`ignoreBudget`、`match*`、`displayIndex`、条目 `extensions` 等 | 全部原样读写，已列入 3.2 | 否 |
| §3 "enabled / disabled" | 存储字段是 `disable`（取反） | 按原字段读写 | 否 |
| §3 "Strategy" | 由 `constant`、`vectorized` 两个布尔值表示；`selective` 是另一回事 | 提供 `readStrategy()` / `strategyPatch()` | 否 |
| §6.1 "Order 越大越接近上下文末端" | 位置 0–4、6 成立；↑EM（5）与 Outlet（7）相反 | 规则照计划书实现；差异记录在此，供界面说明使用 | 否（如需在界面上区分，由后续 Phase 决定） |
| §7 新条目 `newOrder = currentMaxOrder + 1` | ST 自身固定用 100；计划书的规则兼容 | 按计划书取本书最大值 + 1；空书用 100；最大值已到 9999 时把最近的一段推开 | 否 |
| §7 "只有不存在安全排序方案时才做整体重排" | 只要插入点上方或下方到取值范围边界之间还有空着的整数，就有局部方案 | 从不整本重排；两侧都没有空位时返回 `ORDER_SPACE_EXHAUSTED` | 否 |
| §9 拖动后"更新真正的 SillyTavern World Info Order" | ST 编辑器自己的拖拽只改 `displayIndex` | 按计划书改 `order`，不改 `displayIndex` | 否；ST 编辑器的 "Custom" 视图因此与 MieMie 顺序无关 |
| §44 "打开编辑时记录原始版本，保存前重新读取" | ST 的 `loadWorldInfo` 缓存看不到其他标签页；ST 编辑器会在内存里改写字段 | 每次写入都重新读取服务器文件；同书防抖保存先等待落盘；冲突检测默认按整条比较，ST 编辑器的自动改写不算冲突；ST 页面副本与文件有实质差异时拒绝写入，由用户选择保留哪一边 | 否 |
| §49 "写入后确认保存结果" | ST 不提供成功信号 | 回读核对，失败时恢复 ST 页面缓存（不再写服务器） | 否 |

## 5. 已知限制

- **跨书防抖丢失（ST 自身行为）**：ST 的立即保存会取消另一本书还在排队的防抖保存（A2）。
  - 典型场景：用户刚在 ST 编辑器里改了书 A，不到 1 秒 MieMie 就保存了书 B，这时书 A 的改动只留在页面内存里，没有写进文件。
  - 同一本书：Adapter 先等待落盘。
  - ST 编辑器正打开的另一本书：Adapter 保存前先等它落盘，等不到时在结果的 `hostUnsavedBooks` 中列出。其他书的防抖保存无法检测。
  - 同样的问题也会因 ST 自己的"新建书""移动条目"等操作触发。
- **竞争窗口**：服务器没有版本号或比较后写入的能力。读取、比较与保存之间仍有很短的窗口。如果其他设备恰好在这个窗口内写入同一本书，后写者胜。同一页面内的写入由共用的锁串行化，不受此影响。
- **页面副本与文件不一致时需要用户选择**：ST 此前有一次保存失败、ST 编辑器改动还没落盘，或文件被其他标签页改过时，写入返回 `HOST_UNSAVED_CHANGES`，不会自动选边。
  - 以文件为准（`onHostDrift: 'use-stored'`）会丢掉 ST 页面里的差异；保留 ST 的版本（`saveHostCopy`）会覆盖文件里独有的内容。
  - 差异持续存在时，对这本书的第一次写入会先等满 `settleTimeoutMs`（默认 1.5 秒），同样的差异之后不再重复等待。
- **自动改写清单以 1.19.0 为准**：其他版本的 ST 编辑器若新增了改写，这些改写会被当作实质差异或冲突，结果是写入被拒绝，不会覆盖数据。
- **修改会中断进行中的 sticky/cooldown**：这是 ST 按条目哈希匹配的固有行为，ST 编辑器也一样。Adapter 不改动的条目在 ST 页面中的 JSON 保持不变，不受影响；以文件为准丢弃页面差异时，有差异的条目例外。
- **ST 编辑器的状态**：写入后刷新 ST 编辑器，会重置它的搜索与分页。无法读取编辑器状态时（没有 DOM）每次写入都会刷新；这时如果编辑器没打开任何书、而写入的书排在列表第一位，ST 会把它打开。
- **文件会被重新格式化**：保存的是 JSON 解析后的值。由其他工具写入或导入的文件，第一次保存时缩进、数字写法（`1.50` → `1.5`）与整数形式键的顺序会变化，超过 2^53 的整数会损失精度。ST 编辑器保存时也是如此。
- **未验证的运行环境**：
  - 只验证了 SillyTavern 1.19.0；1.18.x 理论上可用（依赖 `getWorldInfoNames`），未实测。
  - 移动端未实测。
- **群聊**：未安装的成员、头像文件名含特殊字符的成员只能通过 Tavern Helper 读取附加书，都不可用时 `additional` 为 `null`。

## 6. 待维护者确认

1. **默认显示哪本书**（计划书 §4）：同时生效的书可能有聊天书、角色主书与附加书、人设书、全局书，外加 ST 编辑器当前打开的书。Adapter 已全部提供并注明来源；优先顺序需要产品决定。ST 自身扫描时的去重顺序是 全局 > 聊天 > 人设 > 角色。
2. **"新条目置顶"取的最大值**：目前按本书计算。Order 在书与书之间共用，如果希望"置顶"意味着高于所有同时生效的书，需要改为跨书计算。
3. **复制条目**（计划书 §11，属于 Phase 2）：计划书说复制时不复制 "Order / 排列位置"。这里应理解为列表位置，而不是 ST 的 `position` 字段（插入位置），否则副本会被插入到别处。另外，副本会共用 `group`（加入同一抽签）和 `automationId`（重复触发 Quick Reply），需要决定是否提示。
4. **Order 显示提示**：↑EM 与 Outlet 的方向相反，界面是否需要说明。
