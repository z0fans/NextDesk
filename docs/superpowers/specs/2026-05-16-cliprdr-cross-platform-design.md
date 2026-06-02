# CLIPRDR 跨平台双向剪贴板 — 完整设计 Spec

> 对齐 mstsc / Microsoft Remote Desktop 的剪贴板功能。
> 目标平台：macOS + Windows 客户端。Linux 留 trait 接口，本期不实现。

## 1. 范围

| 格式 | Mac→Win | Win→Mac | Mac 客户端 | Win 客户端 |
|:---|:---:|:---:|:---:|:---:|
| 纯文本 (CF_UNICODETEXT) | ✅ | ✅ | ✅ | ✅ |
| HTML (CF_HTML + text/html) | ✅ | ✅ | ✅ | ✅ |
| 图片 (PNG + CF_DIBV5 + CF_DIB) | ✅ | ✅ | ✅ | ✅ |
| 文件 (FileGroupDescriptorW) | ✅ | ✅ | ✅ | ✅ |

### 未实现部分（明确排除）

- ❌ Linux 客户端（trait 留口子）
- ❌ RTF 格式
- ❌ HTML 内嵌 base64 图片展开
- ❌ 文件夹/目录递归传输（只支持平铺文件）
- ❌ 智能粘贴（Excel 表格→Numbers）
- ❌ 文件传输 SHA-256 校验
- ❌ Windows 客户端 `AddClipboardFormatListener` 事件优化（本期用 poll）
- ❌ FileVault 暂存性能优化

## 2. 架构

### 2.1 模块结构

```
src-tauri/src/cliprdr/
├── mod.rs              — Public API: build_factory() + Tauri 命令注册
├── backend.rs          — NextDeskCliprdrFactory + impl CliprdrBackend（IronRDP 回调）
├── watcher.rs          — ClipboardWatcher（poll + focus + 节流状态机）
├── formats.rs          — 跨格式编解码（纯函数，调 IronRDP 工具）
├── file_transfer.rs    — FileTransferManager（async 下载、暂存、进度、超时）
└── os/
    ├── mod.rs          — trait OsClipboard + create_os_clipboard()
    ├── macos.rs        — #[cfg(target_os="macos")] NSPasteboard 实现
    └── windows.rs      — #[cfg(target_os="windows")] Win32 Clipboard 实现
```

### 2.2 数据流

**本地→远程（Mac/Win Cmd+C → Win Ctrl+V）**
```
[OS clipboard 变化] → changeCount/SequenceNumber 变化
    ↓
[ClipboardWatcher] → 节流检查（≥5s 间隔，10s 初始冷却）
    ↓
[backend.rs] → 读 OS clipboard → 转 RDP ClipboardFormat[]
    ↓
[CliprdrAction::InitiateCopy] → IronRDP 发 FormatList PDU
    ↓
[Remote Server] → FormatDataRequest
    ↓
[on_format_data_request] → os.read() → formats.rs 转换 → SubmitFormatData
```

**远程→本地（Win Ctrl+C → Mac/Win Cmd+V）**
```
[Remote 复制] → Server 发 FormatList
    ↓
[on_remote_copy] → 选最优格式 → InitiatePaste
    ↓
[on_format_data_response]
    ├─ 文本/HTML/图片 → formats.rs 转换 → os.write_multi()
    └─ 文件 → FileTransferManager.start_transfer()
         ↓ 循环 FileContentsRequest/Response
         ↓ 写暂存目录 → 进度 event
         ↓ 完成 → os.write_files(staged_paths)
```

## 3. trait OsClipboard

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClipFormat {
    PlainText,
    Html,
    Png,
    Tiff,     // mac only
    Bitmap,   // win only (CF_DIBV5/CF_DIB)
    FileList,
}

#[derive(Debug, thiserror::Error)]
pub enum ClipError {
    #[error("clipboard format not available")]
    FormatUnavailable,
    #[error("os clipboard access failed: {0}")]
    AccessFailed(String),
    #[error("data conversion failed: {0}")]
    ConversionFailed(String),
}

pub type ClipResult<T> = Result<T, ClipError>;

pub trait OsClipboard: Send + Sync {
    fn change_count(&self) -> u64;
    fn available_formats(&self) -> Vec<ClipFormat>;
    fn read(&self, format: ClipFormat) -> ClipResult<Vec<u8>>;
    fn read_files(&self) -> ClipResult<Vec<PathBuf>>;
    fn write_multi(&self, items: &[(ClipFormat, Vec<u8>)]) -> ClipResult<()>;
    fn write_files(&self, paths: &[PathBuf]) -> ClipResult<()>;
}
```

### 平台实现要点

**macOS** (`os/macos.rs`):
- `change_count()`: `[NSPasteboard generalPasteboard].changeCount` via objc2 (~1ms)
- `read(PlainText)`: `stringForType:NSPasteboardTypeString` → UTF-8
- `read(Html)`: `dataForType:public.html`
- `read(Png)`: `dataForType:NSPasteboardTypePNG`（优先）或 TIFF→PNG
- `read_files()`: `readObjectsForClasses:[NSURL]` → file URL → PathBuf
- `write_multi()`: `clearContents` + `setData:forType:` 原子操作
- `write_files()`: `declareTypes` + `setPropertyList` file URL 数组

**Windows** (`os/windows.rs`):
- `change_count()`: `GetClipboardSequenceNumber()`
- `read(PlainText)`: `GetClipboardData(CF_UNICODETEXT)` → UTF-16→UTF-8
- `read(Html)`: `GetClipboardData(RegisterClipboardFormat("HTML Format"))` → CF_HTML→plain
- `read(Bitmap)`: `GetClipboardData(CF_DIBV5)` 或 `CF_DIB`
- `read_files()`: `GetClipboardData(CF_HDROP)` + `DragQueryFile`
- `write_multi()`: `OpenClipboard` + `EmptyClipboard` + `SetClipboardData` × N + `CloseClipboard`
- `write_files()`: `SetClipboardData(CF_HDROP)` 构造 DROPFILES

## 4. ClipboardWatcher

```rust
pub struct ClipboardWatcher {
    os: Arc<dyn OsClipboard>,
    action_tx: mpsc::UnboundedSender<CliprdrAction>,
    last_change_count: AtomicU64,
    last_format_list_sent_at: Mutex<Option<Instant>>,
    connected_at: Instant,
    transfer_in_progress: AtomicBool,
    last_remote_write_count: AtomicU64,
}
```

### 节流规则

1. **初始冷却 10s**：`connected_at` 后 10 秒内不发 FormatList
2. **最小间隔 5s**：距上次 FormatList 发送 ≥5s
3. **传输锁**：`transfer_in_progress=true` 时跳过
4. **反馈循环防护**：远程→本地写入后 changeCount +1，watcher 记录 `last_remote_write_count` 跳过

### 触发方式

- **Poll**：tokio interval 500ms，检查 `os.change_count()` 变化
- **Focus**：Tauri `WindowEvent::Focused(true)` → `force_check()`

## 5. 格式通告策略

### 本地→远程

| 本地内容 | 通告 RDP 格式 |
|:---|:---|
| 纯文本 | CF_UNICODETEXT |
| HTML | CF_HTML + text/html + CF_UNICODETEXT |
| 图片 | PNG + CF_DIBV5 + CF_DIB |
| 文件 | FileGroupDescriptorW |

### 远程→本地优先级

1. FileGroupDescriptorW（文件）
2. PNG > CF_DIBV5 > CF_DIB（图片）
3. CF_HTML > text/html（HTML）
4. CF_UNICODETEXT（文本兜底）

## 6. FileTransferManager

### 配置

```rust
pub struct TransferConfig {
    pub max_file_size: u64,            // 默认 2GB
    pub chunk_timeout: Duration,       // 10s
    pub max_consecutive_timeouts: u32, // 3
    pub chunk_size: u32,               // 256KB
}
```

### 暂存目录

- macOS: `~/Library/Caches/NextDesk/clipboard/<session-uuid>/`
- Windows: `%LOCALAPPDATA%\NextDesk\clipboard\<session-uuid>\`
- 会话结束时清空

### 进度事件

```typescript
interface ClipboardFileProgress {
    session_id: string;
    file_name: string;
    file_index: number;
    total_files: number;
    bytes_received: number;
    total_bytes: number;
}
interface ClipboardFileReady {
    session_id: string;
    file_count: number;
    staged_paths: string[];
}
interface ClipboardFileError {
    session_id: string;
    error: string;
}
```

### 超时策略

- 每 chunk `tokio::time::timeout(10s)`
- 连续 3 次超时 → 取消整个传输 + emit error + cleanup stage_dir

## 7. 错误处理

| 失败点 | 处理 |
|:---|:---|
| OS clipboard 读取失败 | 跳过本次同步，下次 poll 重试 |
| 格式转换失败 | 跳过该格式，保留其他 |
| 文件下载超时 | 取消传输 + emit error + cleanup |
| 文件下载部分成功 | all-or-nothing：任一失败全部丢弃 |
| FormatList 被 rejected | 30s cooldown |
| 暂存目录写入失败 | 取消传输 + 通知用户 |

## 8. 与现有代码的关系

### 替换

- `src-tauri/src/cliprdr_backend.rs` → 整个 `cliprdr/` 模块替代
- `rdp_session.rs` 中 `NextDeskCliprdrFactory` 引用改为 `cliprdr::build_factory()`

### 复用

- `virtual_file_clipboard.rs` 的 `write_file_urls_to_macos_pasteboard` → 迁入 `os/macos.rs`
- `IronRDP ironrdp_cliprdr_format::bitmap` → `formats.rs` 调用
- `IronRDP ironrdp_cliprdr_format::html` → `formats.rs` 调用

### 不动

- `rdpdr_backend.rs`（RDPDR 共享文件夹）
- `file_transfer_ws.rs`（WASM 模式专用）
- `RdpManager.tsx` WASM 剪贴板代码（USE_NATIVE_RDP=false 时仍走旧路径）
- `macos_pasteboard_promise.rs`（drag-and-drop 专用，不用于 paste）

## 9. 测试策略

### 单元测试

- `formats.rs`：6 对 round-trip
- `watcher.rs`：mock OsClipboard 验证节流 + 反馈循环防护
- `file_transfer.rs`：mock action_tx 验证超时取消、cleanup

### 集成测试（手动）

1. mac 复制文本 → Win Notepad 粘贴
2. Win Word 复制 HTML → mac TextEdit 粘贴
3. mac 截图 → Win Paint 粘贴
4. Win 截图 → mac Preview 粘贴
5. mac Finder 复制文件 → Win Explorer 粘贴
6. Win Explorer 复制 100MB 文件 → mac Finder 粘贴
7. Win 复制大文件 → 中途断网 → 验证超时 + cleanup

## 10. 预估

| 模块 | LOC | 复杂度 |
|:---|:---|:---|
| mod.rs | 80 | 低 |
| backend.rs | 250 | 中 |
| watcher.rs | 180 | 中 |
| formats.rs | 220 | 中 |
| file_transfer.rs | 350 | 高 |
| os/mod.rs | 60 | 低 |
| os/macos.rs | 400 | 高 |
| os/windows.rs | 300 | 高 |
| **总计** | **~1840** | |

预计实施时间：3-5 天（含测试）。
