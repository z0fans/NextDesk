# RDP 组件国际化（i18n）修复

## 问题描述

RDP 远程桌面相关的所有 UI 文本均为硬编码英文，未接入已有的 i18n 系统。项目本身已有完善的 i18n 框架（`LanguageProvider` + `useTranslation` hook + `translations.ts`），但 RDP 组件均未使用。

## 根本原因

7 个 RDP 组件中，只有 `RdpTabBar.tsx` 使用了 `useTranslation`（且仅覆盖 2 个 key），其余 6 个组件完全未接入 i18n。

## 修改范围

### 翻译资源

#### [MODIFY] [translations.ts](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/i18n/translations.ts)

添加约 50 个新翻译 key，覆盖所有 RDP 组件中的用户可见文本。

---

### RDP 侧边栏

#### [MODIFY] [RdpSidebar.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpSidebar.tsx)

- 引入 `useTranslation`
- 替换: "Servers", "Search servers...", "Favorites", "Group name", "OK", "Server", "Group", "Drop here", "Rename", "Delete", "Edit", "Move to…"

---

### RDP 主管理器

#### [MODIFY] [RdpManager.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx)

- 引入 `useTranslation`，传给 `EmptyState`
- `EmptyState`: "No Active Sessions", "Add a server to get started", "New Connection"
- 连接状态覆盖层: "Connecting to {name}...", "Retry", "Reconnecting...", "Cancel Reconnect", "Click to connect to {name}", "Connect"
- `friendlyRdpError`: 所有错误消息（约15条）
- 自动重连文本: "Reconnecting ({count}/{max})...", "Connection interrupted\nAuto-reconnect failed after {max} attempts"

---

### RDP 快速连接对话框

#### [MODIFY] [RdpConnectDialog.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpConnectDialog.tsx)

- 引入 `useTranslation`
- 替换: "RDP Connection", "Connect to remote desktop", "Host", "Port", "Username", "Password", "Domain (optional)", "Connect", "Connecting..."

---

### 新建/编辑连接对话框

#### [MODIFY] [NewConnectionDialog.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/NewConnectionDialog.tsx)

- 引入 `useTranslation`
- 替换: "New Connection", "Edit Connection", "Display Name", "Host", "Port", "Username", "Password", "Domain", "Group", "Color Tag", "Cancel", "Save", "Save & Connect", "Select…", "Optional"

---

### RDP 网格视图

#### [MODIFY] [RdpGridView.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpGridView.tsx)

- 引入 `useTranslation`
- `STATUS_LABEL` 文本: "Connected", "Connecting...", "Error", "Ready", "Disconnected"
- 空状态: "No active sessions"

---

### RDP 查看器（旧版，保留兼容）

#### [MODIFY] [RdpViewer.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpViewer.tsx)

- 引入 `useTranslation`
- 替换: "RDP Session", "Connecting to remote desktop..."

---

### RDP 标签栏

#### [MODIFY] [RdpTabBar.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpTabBar.tsx)

- 已使用 `useTranslation`，但有遗漏的硬编码文本
- 替换: "Resolution", "Clipboard Std/Exp", "Files", "Disconnect", "Auto"

## 验证计划

### 手动验证

1. 启动开发服务器（`npx tauri dev` 已在运行）
2. 切换语言为中文，依次检查：
   - ✅ 侧边栏标题、搜索框、右键菜单
   - ✅ 新建连接对话框所有标签和按钮
   - ✅ RDP 连接/断开/重连时的状态提示文本
   - ✅ 网格视图的状态标签
   - ✅ 标签栏右键菜单和 ⋯ 会话控制菜单
3. 切换回英文，确认英文文本不受影响
