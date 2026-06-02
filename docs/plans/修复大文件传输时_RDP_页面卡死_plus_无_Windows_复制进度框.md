# 修复大文件传输时 RDP 页面卡死 + 无 Windows 复制进度框

## 问题描述

从 macOS 复制文件到 RDP 远程 Windows 时，如果文件较大：
1. **Windows 端不弹出复制进度对话框**
2. **RDP 页面卡住不动**

## 根因分析

通过分析代码流和终端日志，确认了三个相互关联的根因：

### 根因 1: 剪贴板轮询过于密集（900ms 间隔 × osascript 进程）

[RdpManager.tsx L1483-1485](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx#L1483-L1485) 中，`setInterval` 每 **900ms** 调用 `syncClipboard('Poll')`。每次都要：
- 调用 `clipboard_read_file_paths` → 启动 **osascript 进程**（~300ms）
- 如果检测到文件路径，再调用 `clipboard_read_files_data` → 再次启动 osascript + 读文件
- 终端日志中可看到同一个文件被反复检测数十次

### 根因 2: 文件内容被重复读取，大文件阻塞 IPC

`clipboard_read_files_data`（[rdpdr_backend.rs L602-641](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/src/rdpdr_backend.rs#L602-L641)）每次轮询都从磁盘重新读取所有文件。对于 ≤2MB 的文件会直接加载全量 data，但即使 >2MB 返回空 data，该函数调用本身也需要遍历所有文件获取 metadata，配合 osascript 解析路径，累计耗时显著。

大文件（>2MB）虽然 data 为空，但 IPC 传递 `Vec<ClipboardFileInfo>` 仍会通过 JSON 序列化，造成不必要的主线程阻塞。

### 根因 3: FormatList PDU 反复发送导致 RDP 状态混乱

轮询每次检测到文件变化就调用 `sess.onClipboardPaste(cd)` 发送 **FormatList PDU**。即使文件路径相同（`fileKey` 对比已做），但当多个文件快速切换时，或者 osascript 返回不稳定结果（终端日志显示 osascript[1] 有时返回垃圾数据），会导致：
- FormatList PDU 频繁发送
- Windows 服务端的 CLIPRDR 状态机被打乱
- 服务端回复 FileContentsRequest 但客户端尚未准备好 → deadlock → 页面卡住

## Proposed Changes

### Frontend 剪贴板轮询优化

#### [MODIFY] [RdpManager.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx)

**变更 1：增大轮询间隔 + 增加文件传输锁**

- 将剪贴板轮询间隔从 `900ms` → `3000ms`（3秒），减少 osascript 进程频率
- 新增 `fileTransferInProgressRef` 锁，在文件传输进行中完全跳过轮询
- 在 `fileContentsRequestCallback` 和 `fileContentsResponseCallback` 中管理锁状态

**变更 2：防止轮询期间发送重复 FormatList**

- 新增 `clipboardPollInFlightRef` 标记，防止前一次 poll 尚未完成时启动新一轮
- 在 `syncClipboard('Poll')` 入口处检查并跳过

**变更 3：osascript 探测结果缓存**

- 当 RDPDR 启用时，Poll 模式下只调用 `clipboard_read_file_paths`（轻量探测），不再每次都调用 `clipboard_read_files_data`
- 使用 `lastSyncedFileKey` 缓存已同步的文件路径 key，仅在 key 变化时才读取文件数据并发送 FormatList

**变更 4：文件传输过程中禁止轮询和 Format 发送**

- `fileContentsRequestCallback` 被触发时，设置 `fileTransferInProgressRef = true`
- `fileContentsResponseCallback` 完成时，延迟 2 秒后解锁
- 传输进行中的 poll 直接 `return`，避免打断 CLIPRDR 状态机

---

### Rust 后端优化

#### [MODIFY] [rdpdr_backend.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/src/rdpdr_backend.rs)

**变更 5：clipboard_read_file_paths_macos 降低日志噪音**

- 将 `eprintln!("[DEBUG-CLIPRDR] osascript...")` 改为 `log::debug!`（仅在 RUST_LOG=debug 时输出）
- 避免终端被刷屏

## Verification Plan

### Manual Verification

由于该问题涉及 macOS ↔ Windows RDP 实际文件传输，需要手动测试：

1. **启动开发模式**: `npx tauri dev`
2. **连接到 Windows RDP 服务器**
3. **测试小文件（<2MB）**:
   - 在 macOS Finder 中复制一个小文件，切回 RDP 窗口，按 Ctrl+V
   - 预期：文件正常粘贴到 Windows
4. **测试大文件（>10MB）**:
   - 在 macOS Finder 中复制一个 >10MB 的文件（如 zip 包）
   - 切回 RDP 窗口，按 Ctrl+V
   - **预期：Windows 端应弹出复制进度对话框，且 RDP 页面不卡住**
5. **观察终端日志**:
   - 预期：不再有大量重复的 `[DEBUG-CLIPRDR] osascript` 输出
   - 轮询间隔应明显变长
6. **文本剪贴板仍正常工作**:
   - 在 macOS 复制文本 → RDP 中粘贴 → 预期正常
   - 在 RDP 中复制文本 → macOS 粘贴 → 预期正常
