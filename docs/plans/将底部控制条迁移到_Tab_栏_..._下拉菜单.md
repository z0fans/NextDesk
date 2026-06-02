# 将底部控制条迁移到 Tab 栏 ⋯ 下拉菜单

## 目标
移除底部 auto-hide 控制条（遮挡 RDP 画布底部），将所有控件迁移到 Tab 栏右侧的 ⋯ 图标下拉菜单中，确保 Canvas 获得 100% 高度。

## Proposed Changes

### RdpTabBar 组件

#### [MODIFY] [RdpTabBar.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpTabBar.tsx)

**新增 Props**（仅在有活动连接时传入）:
- `sessionControls?`: 包含分辨率/FPS/操作的控制数据对象

**新增 UI**：在视图切换按钮左侧添加 `⋯` (MoreHorizontal) 图标按钮
- 点击弹出下拉菜单，包含：
  - 分辨率选择（子菜单，带当前值标记 ✓）
  - FPS 实时显示
  - 剪贴板策略切换
  - 打开文件夹
  - 断开连接

---

### RdpManager 组件

#### [MODIFY] [RdpManager.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx)

1. **删除底部控制条**：移除 1901-1956 行的整个 bottom status bar 代码块
2. **传递控制数据给 RdpTabBar**：将 `sessionControls` prop 传入，包含：
   - `resMode`, `rdpStats`, `RESOLUTION_PRESETS`
   - `applyResolution`, `toggleMacClipboardStrategy`, `openClipboardFolder`, `handleCloseTab`
   - `macClipboardStrategy`, `hasClipboardFolder`, `activeTabId`

## Verification Plan

### Manual Verification
1. 运行 `npx tauri dev`，连接一个 RDP 服务器
2. 确认底部不再有 auto-hide 控制条
3. 确认 Tab 栏右侧出现 ⋯ 按钮（仅在 connected 状态时）
4. 点击 ⋯ 按钮，确认下拉菜单正确显示所有控件
5. 测试分辨率切换、FPS 显示是否正常
6. 确认 RDP 画布底部可以正常点击（远程桌面任务栏等）
7. 打开 10+ 个 tab，确认 ⋯ 按钮不被遮挡
