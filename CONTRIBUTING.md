# 参与贡献 · Contributing

欢迎参与 MieMie Worldbook Manager（咩咩世界书管理）。请先阅读 [README](README.md) 和正式开发需求基线 [PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md)。当前仍处于早期开发阶段。

## 协作流程

Issue → Fork / Branch → Development → Pull Request → Review → Test → Maintainer Merge

- PR 应尽量对应明确的 Issue；较大的功能或产品调整请先与维护者讨论，再开始开发。
- 社区贡献者可在自己的 Fork 中创建工作分支，并向官方仓库的 `main` 提交 PR；不需要官方仓库的 Admin 或直接写入权限。
- 一次 PR 聚焦一个明确目标，不要夹带大量无关改动。说明解决的问题、主要变化及验证结果；尚未验证的部分请如实注明。
- 根据 Review 反馈修改，完成与改动相关的测试或人工验证，再由维护者作出最终合并决定。数据操作相关改动应对照计划书的 Golden Path 验收要求。
- `main` 是官方正式上游，社区代码主要通过 PR 合入。Owner 保留必要时维护仓库的通道。

## 产品与数据边界

- 不得擅自改变产品定位；计划书是正式开发需求基线，需求变更须先经维护者确认。
- 不创造 MieMie 私有 Worldbook 格式，必须保持 SillyTavern 原生 World Info / Lorebook 兼容。
- 读取原对象、局部修改指定字段；未识别字段不得因保存操作丢失。
- AI 只能提出修改建议，未经用户审核与确认不得直接写入世界书。写入前检查最新数据与冲突，写入后确认保存结果；失败不得冒报成功。

## 提交前检查

- 不得提交 API Key、Token、Secret、私有凭据或包含这些内容的日志与配置。
- 不得提交无关的 exe / dll / dmg / pkg 等二进制、生成产物或不必要依赖。
- 检查提交差异，确保只包含本次贡献所需内容，并说明适用的测试或人工验证结果；当前没有约定的构建命令或 CI 时，不要虚构检查通过。
- 软件代码沿用 [GPL-3.0-or-later](LICENSE)，品牌与素材分别遵循 [BRAND.md](BRAND.md) 和 [ASSETS-LICENSE.md](ASSETS-LICENSE.md)。引入第三方内容时，应说明来源与许可证，并更新 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
