# AGENTS.md — NextDesk

NextDesk 是基于 Tauri 2、React 19 和 TypeScript 的 macOS / Windows RDP、SSH 客户端。版本、依赖和命令以当前 manifest、脚本及 CI 为准。

## 工作边界

- 在用户已授权的范围内完成实现和必要验证；常规、可逆的本地工作可直接推进。只有答案会改变范围、安全性或结果且无法从上下文判断时才询问，并继续不依赖答案的工作。
- 保留已有未提交改动。本地修改不自动授权提交、推送、发布、修改远端或覆盖用户配置；这些操作须已有会话授权。凭证、私钥和完整连接配置不得写入日志、文档或提交。
- Skill 用于补足当前任务需要的知识；同名 skill 选一份，按需读取相关分支。用户要求优先于 skill 的通用流程，不自动串联设计、计划、TDD、复审和 Git 收尾。
- 委派遵循宿主权限与用户要求，只有独立子任务的收益足以抵消协调成本时才采用；独立复审不是每次修改的完成门槛。

## 项目约束

- 用户可见文本走 `t('key')`，在 `frontend/src/i18n/translations.ts` 同时维护中英文；变量和代码注释用英文。
- 使用函数组件、Hooks、Tailwind CSS v4、现有 ShadcnUI 组件和 `cn()`；沿用所在模块的状态管理方式。
- 后端调用复用类型化桥接：通用 API 在 `frontend/src/api.ts`，KKTerm 在 `frontend/src/rdp/kkterm/commands.ts`，SSH 在 `frontend/src/ssh/ssh-api.ts`。避免在 UI 中另建调用协议。
- Tauri 上下文使用现有异步运行时和 `tauri::async_runtime::spawn()`；不得另建 Runtime 并 `block_on()`。命令在 `src-tauri/src/lib.rs` 注册，平台代码用对应 `cfg` 隔离。
- 持久化配置沿用 `src-tauri/src/config.rs`；所有 RDP 引擎通过 `connection_resolver.rs` 解析路由，保持云端优先、直连回退及用户路由策略。
- 涉及本地 IronRDP 时保留同级 `../IronRDP` 的 NextDesk 补丁；不能直接用上游覆盖。实际依赖来源以所选 Cargo manifest 为准，补丁基线及应用方式见 CI 和 `patches/ironrdp-nextdesk.patch`。

## 按任务读取

- 改动 RDP 输入、剪贴板、分辨率、渲染、会话生命周期或构建引擎时，读 [RDP 约束与运行入口](docs/agents/rdp.md)。
- 发布、打 tag 或检查更新器时，读 [发布流程](RELEASE.md) 和 [发布验收门槛](docs/qa/release-acceptance-gate.md)；其中完整质量门槛保留为发布要求。
- 操作 issue / spec 时，按 [本地 Markdown tracker](docs/agents/issue-tracker.md) 使用 `.scratch/`；分流时使用 [canonical labels](docs/agents/triage-labels.md)。
- 涉及领域术语或架构决策时，按 [领域文档约定](docs/agents/domain.md) 查相关上下文与 ADR。
- `.agent/` 是本项目保留的可选旧工作流入口，不是 Codex 的 `.agents/skills/`。仅在任务明确选用时读取；历史计划里的平台工作流声明不自动激活它。

## 验证与完成

- 根据改动和风险选择验证。文档改动检查内容、链接和 diff；行为改动验证受影响路径及必要回归。检查已通过且相关内容未变时复用结果，出现新改动、失败或未解决疑点再扩大或重跑。
- 搜索和读取以解决当前问题为止，不要求预读整个项目、固定数量的资料或假设。简单修改无需新建计划或逐项 tracker。
- RDP 运行验证使用仓库开发构建，确认引擎、平台和进程；`/Applications/NextDesk.app` 的结果不能替代当前代码的验证。
- 完成时简要说明改动、验证结果和实际限制。没有真实运行证据的硬件 / 跨平台项目标为 `Not Verified`。
