# RDP 组件国际化修复 — 完成报告

## 修改概要

将 7 个 RDP 组件中约 **60 个硬编码英文字符串**替换为 `useTranslation` hook 的 `t()` 调用，使 RDP 界面完全支持中英文切换。

## 修改文件

| 文件 | 变更内容 |
|---|---|
| [translations.ts](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/i18n/translations.ts) | 新增约 80 个翻译 key（中英文各一套） |
| [RdpSidebar.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpSidebar.tsx) | 侧边栏标题、搜索框、分组操作、右键菜单 |
| [RdpManager.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx) | `friendlyRdpError` 重构（接受 `t` 参数）、EmptyState、连接/错误/重连覆盖层 |
| [RdpConnectDialog.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpConnectDialog.tsx) | 表单标签和按钮 |
| [NewConnectionDialog.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/NewConnectionDialog.tsx) | 表单标签、按钮、GroupSelect 子组件 |
| [RdpGridView.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpGridView.tsx) | STATUS_LABEL 移入组件、空状态文本 |
| [RdpViewer.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpViewer.tsx) | 会话标题、连接提示 |
| [RdpTabBar.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpTabBar.tsx) | 分辨率/剪贴板/文件/断开连接菜单 |

## 关键设计决策

- **`friendlyRdpError`** 改为接受 `t: (key: TranslationKey) => string` 参数，避免在非 React 函数中违反 Hooks 规则
- **参数化翻译**：含动态值的字符串（如 `{name}`, `{count}/{max}`）使用 `t('key', { param: value })` 模式
- **子组件独立 hook**：`EmptyState`、`GroupSelect` 等子组件各自调用 `useTranslation()`

## 验证结果

- ✅ `tsc --noEmit` 零错误
- ✅ grep 扫描无残留硬编码英文 UI 文本
- ⏳ 需手动验证：切换语言后 RDP 界面各区域文本正确显示
