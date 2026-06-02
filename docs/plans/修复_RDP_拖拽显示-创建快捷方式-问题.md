# 修复 RDP 拖拽显示"创建快捷方式"问题

## 问题分析

在 RDP 会话中拖拽图标时，Windows 显示"创建快捷方式"而非正常移动。

### 根因

Windows DragDrop 行为取决于修饰键状态：
- 无修饰键 = 移动
- Ctrl = 复制
- Ctrl+Shift = 创建快捷方式（当前症状）

RDP 协议鼠标事件不携带修饰键。Windows RDP 服务器通过独立键盘事件跟踪 Ctrl/Shift 状态。

> [!IMPORTANT]
> **核心根因**：canvas 失焦时浏览器不再发送 `keyUp` 到 canvas，IronRDP Database 和 RDP 服务器认为 Ctrl/Shift 仍 pressed。`releaseAllInputs()` 已定义但从未被调用。

## Proposed Changes

### Frontend Input Events

#### [MODIFY] [RdpManager.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx)

在 `attachEvents` 中新增 blur 事件处理：

1. canvas blur 时调用 `session.releaseAllInputs()` 释放所有键盘/鼠标状态
2. window blur 时（Cmd+Tab 切应用）同样释放
3. 清空 `pressedButtons` 和 `suppressedShortcutKeyups`

```diff
+      const releaseAllKeys = () => {
+        const session = sessionRefs.current.get(tabId);
+        if (session) {
+          try { session.releaseAllInputs(); } catch {}
+        }
+        pressedButtons.clear();
+        suppressedShortcutKeyups.clear();
+      };
+      const onBlur = () => releaseAllKeys();
+      const onWindowBlur = () => releaseAllKeys();
+      canvas.addEventListener('blur', onBlur);
+      window.addEventListener('blur', onWindowBlur);
       // cleanup:
+      canvas.removeEventListener('blur', onBlur);
+      window.removeEventListener('blur', onWindowBlur);
```

## Verification Plan

### Manual Verification

用户在 RDP 会话中手动测试：
1. 拖拽桌面图标，确认显示"移动到"而非"创建快捷方式"
2. Cmd+Tab 切走再切回后拖拽，确认正常
3. 回归验证 Ctrl+C/V 剪贴板功能
