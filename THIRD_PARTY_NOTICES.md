# 第三方声明

MieMie Worldbook Manager 当前处于早期开发阶段，尚无第三方运行依赖，也未引入开发／测试依赖（测试使用 Node.js 内置的 `node:test`），未复制或捆绑第三方产品实现、字体、图标库或其他媒体素材。当前没有需要列出的第三方组件及版本清单。

README 中提及 SillyTavern World Info / Lorebook，是对项目定位与原生格式兼容目标的说明。当前仓库不包含 SillyTavern 的实现，不替其声明许可证，也不表示本项目获得了 SillyTavern 的官方背书。为实现格式互通，`src/adapters/sillytavern/st-schema.js` 记录了 SillyTavern 1.19.0 世界书条目的字段名、默认值、枚举值与取值范围，以及其编辑器会自动做的字段改写；兼容性文档引用了 SillyTavern 与 Tavern Helper 的源码位置。二者均为接口事实，未复制其实现代码。

后续如实际引入或随包分发第三方代码、依赖、素材或工具，应按实际版本更新本文件，记录来源、许可证及使用范围，并保留分发所需的版权、LICENSE 与 NOTICE。第三方作品保持其原有许可，不被重新声明为 SheepSheep 的作品。

本项目软件代码采用 GPL-3.0-or-later，完整文本见 [LICENSE](LICENSE)。品牌及当前素材范围分别见 [BRAND.md](BRAND.md) 和 [ASSETS-LICENSE.md](ASSETS-LICENSE.md)。
