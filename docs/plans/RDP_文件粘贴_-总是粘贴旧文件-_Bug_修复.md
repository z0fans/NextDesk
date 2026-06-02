# RDP 文件粘贴 "总是粘贴旧文件" Bug 修复

## 根因分析

### 症状
本地复制新文件 → 切到 RDP 窗口 → Ctrl+V 粘贴 → RDP 内粘贴的是**上一个**复制的文件，不是当前的。

### 数据流追踪

文件粘贴涉及 3 个路径协同工作：

```
Ctrl+V 按下
  ├─ [路径1] syncLocalClipboardForPasteShortcut() → 读取当前文件 → onClipboardPaste (FormatList)
  ├─ sendCtrlShortcut(0x2F) → RDP 服务器收到 Ctrl+V
  │
  RDP 服务器执行粘贴 → 需要文件数据 → 触发:
  └─ [路径2] forceClipboardUpdateCallback() → 应该把文件数据交给服务器
```

### 根因

在 [forceClipboardUpdateCallback](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx#L681-L785) 中，
当 RDPDR 启用时（L685-712），代码**直接跳过了 `advertisedClipboardRef` 缓存检查**：

```typescript
// L685-712: RDPDR-active 分支
if (rdpdrEnabledRef.current.has(tabId)) {
  // ❌ 直接执行 text-only 处理，跳过了缓存的文件 snapshot
  void invoke('clipboard_read_file_paths')
    .then(filePaths => {
      if (filePaths.length > 0) {
        return null;  // ← 发现有文件就放弃，什么都不发送！
      }
      return tauriReadClipboard();
    })
    ...
  return; // ← 在 L714 的缓存检查之前就 return 了
}

// L714: 缓存检查（永远不会被执行到）
const cachedSnapshot = advertisedClipboardRef.current.get(tabId);
if (cachedSnapshot) { ... } // ← 有缓存的文件 snapshot 应该在这里重放
```

**结果**：`syncLocalClipboardForPasteShortcut` 在 Ctrl+V 前正确发送了 FormatList（包含新文件信息），
但当服务器请求实际数据时，`forceClipboardUpdateCallback` 在 RDPDR 分支中返回 null，
服务器收不到文件数据，回退到旧缓存 → 粘贴了上一个文件。

---

## 修复方案

### [MODIFY] [RdpManager.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx)

**修改 `forceClipboardUpdateCallback` 的 RDPDR 分支（L685-712）**：在进入 text-only 逻辑之前，先检查 `advertisedClipboardRef` 缓存。如果有已缓存的 snapshot（无论是文件还是文本），直接重放它。

```diff
 if (rdpdrEnabledRef.current.has(tabId)) {
   cblog('[clipboard] forceUpdate: RDPDR active, ...');
+  // Check cached snapshot first — paste-shortcut may have already prepared it
+  const cachedSnapshot = advertisedClipboardRef.current.get(tabId);
+  if (cachedSnapshot) {
+    cblog('[clipboard] forceUpdate: replay cached snapshot (RDPDR mode)', ...);
+    const clipboardData = buildClipboardDataFromSnapshot(wasm, cachedSnapshot);
+    void sess.onClipboardPaste(clipboardData)
+      .then(() => cblog('[clipboard] ✅ forceUpdate replayed cached snapshot (RDPDR)'))
+      .catch(e => cblog('[clipboard] forceUpdate replay error:', e));
+    return;
+  }
   void invoke('clipboard_read_file_paths')
```

逻辑：`syncLocalClipboardForPasteShortcut` 执行后已经将正确的文件 snapshot 存入 `advertisedClipboardRef`，所以 `forceClipboardUpdateCallback` 只需重放即可。

---

## 验证计划

### 手动测试

1. 启动应用 `npx tauri dev`，连接到一台 RDP 服务器
2. 在本地 Finder 中复制文件 A（Cmd+C）
3. 切到 RDP 窗口，按 Cmd+V — 确认粘贴的是文件 A ✓
4. 再在本地 Finder 中复制**不同的**文件 B（Cmd+C）
5. 切到 RDP 窗口，按 Cmd+V — **确认粘贴的是文件 B**（之前会是文件 A）✓
6. 重复测试文本粘贴确保不受影响：本地复制文本 → RDP 内 Ctrl+V → 确认文本正确

### 日志验证

在 DevTools Console 中观察以下日志序列：
```
[clipboard] paste-shortcut: read N file(s) from current clipboard
[clipboard] ✅ paste-shortcut local files injected before remote paste
[clipboard] ▶ forceClipboardUpdateCallback FIRED
[clipboard] forceUpdate: replay cached snapshot (RDPDR mode) N file(s)  ← 新增
[clipboard] ✅ forceUpdate replayed cached snapshot (RDPDR)             ← 新增
```
