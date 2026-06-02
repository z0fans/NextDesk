# 修复侧边栏折叠/展开时 RDP 连接断开的问题

## 问题分析

在 RDP 页面内，点击 SERVERS 侧边栏的折叠/展开按钮（`PanelLeftClose`/`PanelLeftOpen` 图标）时，侧边栏宽度从 `w-60` (240px) 变为 `w-12` (48px)，导致 canvas 包裹区域宽度改变约 192px。

`RdpManager.tsx` 中的 `ResizeObserver`（第 1608-1652 行）监测到此变化超过 20px 阈值后，调用 `reconnectWithSize()` → 断开当前 RDP 连接并重新连接。

**根本原因**: `doResize` 函数无法区分「窗口大小真正改变」和「侧边栏折叠/展开导致的布局变化」。

## 修复方案

在侧边栏折叠/展开时，临时激活 `resizeCooldownRef`（已有的冷却机制），抑制 `ResizeObserver` 触发的自适应重连。

### [MODIFY] [RdpManager.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx)

利用现有的 `resizeCooldownRef` 机制：当 `store.sidebarOpen` 状态变化时，激活冷却期，让侧边栏动画完成后更新 `lastSizeRef` 但**不触发重连**。

1. 添加一个 `useEffect` 监听 `store.sidebarOpen` 变化：
   - 当侧边栏折叠/展开时，设置 `resizeCooldownRef.current = true`
   - 等待侧边栏过渡动画完成后（约 300ms），更新 `lastSizeRef` 为当前 canvas 大小
   - 设置 `resizeCooldownRef.current = false`
   - 对于当前已连接的 session，调用 `session.resize()` 让 **服务器端** 知道新尺寸（不断开连接）
2. 在 `doResize` 中已有 `if (resizeCooldownRef.current) return;` 的检查，无需修改

## 验证计划

### 手动测试

1. 启动 `npx tauri dev`
2. 在 RDP 页面连接一个远程服务器
3. 连接成功后，点击 SERVERS 面板右上角的折叠图标（`PanelLeftClose`）
4. **预期**: 侧边栏折叠，RDP 画面保持不变，连接状态保持 `connected`，不出现重连
5. 再次点击展开图标（`PanelLeftOpen`）
6. **预期**: 侧边栏展开，RDP 画面保持不变，连接状态保持 `connected`，不出现重连
7. 拖拽 Tauri 窗口改变大小（非侧边栏导致的 resize）
8. **预期**: 自适应 resize 仍然正常触发重连（确认没有破坏原有逻辑）
