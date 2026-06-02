# Kiro × Memora 自动记忆集成设计

> 日期：2026-05-15
> 状态：设计完成，待实现

## 目标

让 Kiro 自动与 Memora MCP 记忆系统形成闭环：对话开始时检索相关记忆作为上下文，对话结束时将关键决策和经验保存为新记忆。全局生效，适用于所有项目。

## 约束

- 依赖已有的 Memora MCP 服务器（`mcp_memora_*` 工具族）
- 不引入新的外部依赖
- 不影响对话中间的执行效率
- 只保存高价值信息（决策、经验、踩坑），不保存噪音

## 架构

```
对话开始
    ↓
Steering 规则触发
    ↓
Kiro 调用 mcp_memora_memory_hybrid_search(query=用户消息关键词, top_k=5)
    ↓
获取相关记忆 → 作为内部工作上下文（不直接输出给用户）
    ↓
正常对话/开发...
    ↓
对话结束 (agentStop hook 触发)
    ↓
Kiro 判断：本次对话是否产生了值得保存的决策/经验？
    ↓
是 → 调用 mcp_memora_memory_create(content, tags, metadata)
否 → 不保存，静默结束
```

## 组件 1：Steering 规则（检索）

**文件位置**：`~/.kiro/steering/memora-recall.md`

**作用范围**：全局，所有项目

**触发时机**：每次新对话的第一次响应前

**行为**：
1. 从用户的首条消息中提取核心关键词（技术术语、组件名、问题描述）
2. 调用 `mcp_memora_memory_hybrid_search`，参数：
   - `query`：提取的关键词
   - `top_k`：5
   - `semantic_weight`：0.6（默认，平衡语义和关键词）
3. 如果返回结果 count > 0，将记忆内容作为内部参考上下文
4. 如果返回结果 count = 0，正常继续，不做额外操作
5. 不向用户展示检索过程，除非用户主动询问

**不做的事**：
- 不在对话中间重复检索
- 不对每条追问消息都触发检索
- 不将记忆内容原样输出给用户

## 组件 2：agentStop Hook（保存）

**文件位置**：`~/.kiro/hooks/memora-save.kiro.hook`

**作用范围**：全局，所有项目

**触发时机**：每次 agent 执行结束时（`agentStop` 事件）

**行为**：提醒 Kiro 判断本次对话是否产生了值得保存的记忆

### 保存判断标准

**✅ 应该保存的**：
- 架构决策及其理由（"为什么选 X 不选 Y"）
- Bug 根因分析（"问题出在 X，因为 Y"）
- API/库的踩坑经验（"X 库的 Y 方法在 Z 条件下会失败"）
- 性能优化发现（"将 X 改为 Y 后性能提升 Z%"）
- 协议/规范的关键约束（"RDP 的 CLIPRDR 必须在内容变化时才发 FormatList"）
- 配置/环境的重要发现（"macOS 上必须用 rustup 管理的 rustc，Homebrew 版本不够"）

**❌ 不应该保存的**：
- 简单问答（"这个函数是做什么的"）
- 纯文件浏览/搜索
- 格式调整、typo 修复
- 已有记忆中已记录的相同内容
- 用户明确表示是临时/实验性的操作

### 保存格式

调用 `mcp_memora_memory_create`，参数：

```json
{
  "content": "简洁的一段话，描述决策/经验/发现。包含：是什么、为什么、关键上下文。",
  "tags": ["项目名", "技术领域", "组件名"],
  "metadata": {
    "source": "kiro-session",
    "files": ["相关文件路径（可选）"]
  }
}
```

**标签规范**：
- 项目名：小写，如 `nextdesk`、`tube-server`
- 技术领域：如 `rdp`、`tauri`、`react`、`clash`
- 组件名：如 `cliprdr`、`rdp-proxy`、`gfx-handler`

## 组件 3：去重机制

保存前，Kiro 应先用 `mcp_memora_memory_hybrid_search` 快速检查是否已有类似记忆：
- 如果找到相似度 > 0.8 的已有记忆，不重复保存
- 如果已有记忆需要更新（新发现补充了旧知识），使用 `mcp_memora_memory_update` 更新而非新建

## 实现清单

1. 创建 `~/.kiro/steering/memora-recall.md`（always included steering 文件）
2. 创建 `~/.kiro/hooks/memora-save.kiro.hook`（agentStop hook）
3. 验证：新对话中 Kiro 自动检索记忆
4. 验证：对话结束后 Kiro 正确判断并保存/不保存

## 不做的事

- 不保存 session 摘要（噪音太多，信噪比低）
- 不在对话中间自动检索（只首次一次）
- 不自动记录文件修改（那是 git 的职责）
- 不替换或修改现有 Memora MCP 服务器配置
- 不引入额外的 MCP 服务器或外部服务
