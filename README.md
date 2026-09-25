# MieMie Worldbook Manager · 咩咩世界书管理

**SillyTavern World Info / Lorebook Manager**

MieMie Worldbook Manager 是面向 SillyTavern 原生 World Info / Lorebook 的高级管理前端与 AI 长期资料维护工作台。

MieMie Worldbook Manager is an advanced management frontend for SillyTavern's native World Info / Lorebook and a workspace for AI-assisted long-term information maintenance.

## 项目状态 / Status

- **Early Development**：已完成 Phase 1 世界书兼容层（SillyTavern 世界书读写 Adapter），尚无用户界面，暂不能作为扩展直接使用。
- 初始计划版本 / Initial planned version：**0.1.0**。
- GitHub Repository：**SheepSheepLab/MieMie-Worldbook-Manager**。
- Extension ID：**`miemie.worldbook-manager`**。

项目以兼容 SillyTavern 原生 World Info / Lorebook 为设计目标，不创造 MieMie 私有世界书格式。目前的兼容层在 SillyTavern 1.19.0 上验证过，其余版本与界面功能尚在开发中。

The project is designed for compatibility with SillyTavern's native World Info / Lorebook. It does not define a proprietary MieMie worldbook format. Phase 1 provides the worldbook data layer, verified against SillyTavern 1.19.0; there is no user interface yet.

正式开发需求基线见 [产品与开发企划书 v0.1](docs/PRODUCT_PLAN.md)。参与社区协作前请阅读 [贡献说明](CONTRIBUTING.md)。

## 开发 / Development

- [Worldbook Adapter](docs/worldbook-adapter.md)：世界书数据层的结构、接口与数据安全规则。
- [SillyTavern 1.19.0 兼容性调研](docs/compatibility/sillytavern-1.19.0.md)：字段、Order 语义、读写接口与已知限制。
- [测试说明](docs/testing.md)：自动测试与真实 SillyTavern 集成测试。

运行自动测试需要 Node.js 22 或更高版本，无需安装依赖：

```bash
npm test
```

## 授权 / Licensing

Copyright © 2026 SheepSheep

本项目的软件代码采用 **GNU General Public License v3.0 or later**（SPDX：`GPL-3.0-or-later`）。你可以按照 GNU 通用公共许可证第 3 版，或自行选择自由软件基金会发布的任何后续版本，使用、研究、修改、再分发及商业使用软件。软件不提供任何担保，具体权利与义务见 [LICENSE](LICENSE)。

Software code is licensed under the GNU General Public License, version 3 or (at your option) any later version (`GPL-3.0-or-later`), without warranty. `LICENSE` contains the complete, unmodified GNU GPL v3 text; this statement specifies the “or later” option.

MieMie / 咩咩品牌身份、Logo、角色形象及指定美术资产，不因为软件代码采用 GPL 而自动获得相同授权。品牌／IP 与指定素材单独说明，不向 GPL 软件代码附加商业使用禁令或其他额外限制。当前仓库尚未包含需要单独授权的指定角色／品牌美术资产。

MieMie branding, logos, characters and designated artwork are managed separately from the software license. These notices add no restrictions to GPL-covered software code. No designated character or brand artwork is included in this initial repository.

- [品牌身份与正常引用规则 / Brand identity](BRAND.md)
- [当前素材范围 / Asset scope](ASSETS-LICENSE.md)
- [第三方声明 / Third-party notices](THIRD_PARTY_NOTICES.md)
