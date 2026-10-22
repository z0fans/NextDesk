# GPT-6 Astra 指令审计记录

本记录说明 2026-09-08 的项目指令调整，不是新的启动流程。

## 阅读依据

已全文阅读以下一手材料，包含官方文档的行为、提示建议与迁移部分，以及 Eric 原文从技能到持久化边界的各节：

- [OpenAI — Using GPT-6 Astra / Model Guidance](https://developers.openai.com/api/docs/guides/latest-model.md)
- [Eric Provencher — Rethinking skills and prompts for GPT-6 Astra](https://x.com/pvncher/status/2095991462416490862)

两者共同支持按需加载、精确触发、减少旧流程约束、按风险验证，以及在授权范围内持续完成工作。官方的多 agent 示例是可调节的工作流选择，不构成每项任务都应委派的要求。

加载关系另按官方 [AGENTS.md 发现规则](https://developers.openai.com/codex/guides/agents-md.md) 和 [skills 发现规则](https://developers.openai.com/codex/skills.md) 核对。

## 实际作用范围

| 来源 | 本次核对结果与处理 |
| --- | --- |
| 项目根 `AGENTS.md` | 本次会话提供的项目指令来源；从 343 行 / 13,913 字节精简为 34 行 / 3,712 字节，字节数减少 73.3%。 |
| `docs/agents/` | 保留本地 issue、canonical label 和领域约定；将领域预读改为相关任务触发，新增 RDP 专用参考。 |
| `.agent/` | 原 Antigravity 目录，不在当前 Codex 自动加载的技能目录中；完整审查并改写 13 份 `SKILL.md`，合计从 3,052 行减到 203 行，同时调整入口和复审模板。保留路径以兼容历史计划。 |
| 当前 Codex profile | `CODEX_HOME=/Users/yuu/.codex-profiles/work-1/codex-home`，配置默认模型为 `gpt-6-astra`；全局 `AGENTS.md` 为空，未设置 `model_instructions_file` 或 `developer_instructions`。项目信任配置已存在。 |
| 其他 profile | `~/.codex/config.toml` 与当前 profile 不同，未将其当作本次配置来源。 |
| 全局共享技能 | 清单存在同名条目；`~/.agents/skills` 指向 `~/.skills-manager/skills`，当前 profile 也有技能副本。另读了通用实现、诊断、复审和指令编写规则，确认有固定全套测试、强制双 agent 复审等要求。共享文件未改写或卸载；项目合同改为按需选一份、按实际任务判断流程。共享清单的描述开销仍然存在，不计入本次节省。 |
| hooks / 宿主 / 记忆 | 当前 profile 配置中的 hooks 项是信任哈希记录，所指 `hooks.json` 不存在。宿主注入规则和记忆没有作为项目文件改写。 |

`.agent/` 和备份目录被现有 `.gitignore` 忽略；这些修改会保留在本机，但不会自动进入 Git 提交。没有新增 `.agents/skills/` 或把旧工作流整体安装进 Codex。

## 删除与调整

- 删除过期版本号、文件大小与行数、完整目录树、重复技术栈说明、重复 WASM 编译段落，以及要求修改全局 Rust 默认版本的命令。
- 删除 1% 相关就加载 skill、任何修改先审批设计、固定 2–5 分钟步骤、每三项暂停、固定 tracker、每项双重复审、自动提交与分支收尾等通用仪式。
- 移除“每次完成声明都必须重跑完整命令”、每函数测试和为补做 TDD 删除现有实现等规则；改为行为证据、变更范围和风险决定检查，复用仍有效的结果。
- 调试不再固定假设数量、先穷尽所有资料或按尝试次数强制升级架构讨论；根据证据推进，明确未验证部分。
- skill 描述缩到具体用途，入口按需读取，不再无条件串联其他 skill。旧 Antigravity 包检查脚本保留为历史工具，`INSTALL.md` 已说明其退役的检查目标。

## 校正后的项目约束

对照当前代码后修正了三项过时断言：

- `src-tauri/Cargo.toml` 和 `Cargo.kkterm.toml` 当前使用发布的 IronRDP 依赖，不能再宣称所有构建都依赖 90+ 个本地 path crate；同级 IronRDP 补丁与 CI 基线仍受保护。
- `RdpManager.tsx` 已按引擎处理分辨率：macOS KKTerm 重连，Windows 原生显示同步，native / official-web 动态调整及回退。保留这些分支，不再全局禁止 `session.resize()`。
- 前端已有通用、KKTerm、SSH 的类型化桥接入口，不再要求把全部后端调用集中到单一 `api.ts`。

保留了凭证保护、已有改动保护、远端 / Git / 发布授权边界、i18n、Tauri 运行时、统一路由、CLIPRDR 内容变化同步、WASM 滚轮输入、会话挂载、分辨率防抖与冷却、默认键盘模式，以及发布完整门槛。专用内容见 [RDP 约束](rdp.md)，发布流程继续以 [RELEASE.md](../../RELEASE.md) 为准。

## 验证与恢复

- `git diff --check -- AGENTS.md docs/agents` 通过；对包括被忽略文件在内的 27 个指导文件检查了末尾换行、空白、Markdown 链接以及 13 份 skill 的名称和描述结构。
- 核对前后 SHA-256，52 个已有修改的业务代码文件均未改变。本次没有运行应用、全套测试或远端操作；没有提交 Git。
- 根指令的体积减少已实测；未运行模型行为 A/B 或任务 Token 基准，不将文件缩短宣称为实测 Token 节省比例。
- 修改前的 26 个现有指导文件保存在 `.scratch/astra-instruction-audit/20260908T012425/before.tar.gz`；完整本地 diff 在同目录的 `changes.patch`，包含被 Git 忽略的改动，文件统计在 `metrics.json`。
- 新增文件是 `docs/agents/rdp.md` 和本记录。恢复时先检查后续编辑，再按需取回备份内容，避免覆盖之后的工作。

新会话会按新文件建立指令链；当前对话已经注入的旧内容不会因磁盘修改而被追溯删除。
