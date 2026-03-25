# Lazy Paste (延迟下载) Implementation Plan

> **For Antigravity:** REQUIRED WORKFLOW: Use `.agent/workflows/execute-plan.md` to execute this plan in single-flow mode.

**Goal:** RDP→本地文件传输改为按需下载，粘贴时 Finder 显示原生"正在准备拷贝"进度条（对齐 Jump Desktop）。

**Architecture:** 复制时只存元信息写入 NSPasteboardItemDataProvider → 粘贴时 Finder 回调 → Rust 通过 channel 通知 JS → WASM 触发 RDP 分块下载 → 流式写盘 → Finder 收到文件。

**Tech Stack:** Rust (Tauri 2, objc2), TypeScript (React), Rust (WASM, ironrdp-web)

---

## 数据流设计

```
RDP内 CMD+C
  → WASM: 收到 FormatList，存储 FileGroupDescriptorW 元信息（不下载）
  → JS: remoteClipboardChangedCallback 收到文件元信息
  → JS: invoke('clipboard_register_promise', { files: [{name, size}] })
  → Rust: 写入 NSPasteboardItemDataProvider (空数据，只有元信息)

用户 CMD+V in Finder
  → macOS: 调用 provideDataForType: 回调
  → Rust: 通过 Tauri event 通知 JS "请下载 file_index=0"
  → JS: 调用 WASM session.triggerFileDownload(file_index)
  → WASM: 发起 FileContentsRequest DATA 分块请求
  → WASM → JS fileChunkCallback → invoke('clipboard_stage_chunk')
  → 下载完成 → JS invoke('clipboard_promise_fulfill', { path })
  → Rust: provideDataForType 阻塞等待的 channel 收到数据 → 设置到 pasteboard
  → Finder: 显示原生进度条"正在准备拷贝"
```

---

## 影响范围

| 功能 | 是否改动 | 说明 |
|------|---------|------|
| 文本复制粘贴 | ❌ | 不涉及 |
| 本地→RDP 文件 | ❌ | 不涉及 |
| RDP→本地 文件 | ✅ | 核心改动：预取→按需 |
| RDPDR 共享文件夹 | ❌ | 不涉及 |
| macOS pasteboard | ✅ | 扩展现有 promise provider |
| Windows clipboard | ❌ | 不在本次范围 |

---

### Task 1: WASM — 添加"手动触发下载"模式

**Files:**
- Modify: `IronRDP/crates/ironrdp-web/src/clipboard.rs:620-680`
- Modify: `IronRDP/crates/ironrdp-web/src/session.rs` (暴露 JS API)

**Step 1: 修改 clipboard.rs — 不自动下载**

在 `remote_file_descriptors` 有文件时，不再自动发起 DATA 请求。改为只存储描述符并通过 `remoteClipboardChangedCallback` 通知 JS。

```rust
// 原来: if !self.remote_file_descriptors.is_empty() { 自动下载 }
// 改为: 只存储，不自动下载
if !self.remote_file_descriptors.is_empty() {
    // Dedup check remains
    if self.remote_file_descriptors == self.last_committed_descriptors {
        // skip...
    }
    // 不再自动发起 FileContentsRequest
    // JS 收到 remoteClipboardChangedCallback 后决定何时下载
}
```

**Step 2: 添加公开方法 `trigger_file_download(file_index)`**

新增方法让 JS 可以按需触发单个文件的下载。

```rust
pub fn trigger_file_download(&mut self, file_index: usize) -> Result<(), String> {
    if file_index >= self.remote_file_descriptors.len() {
        return Err(format!("file_index {} out of range", file_index));
    }
    self.download_generation += 1;
    let fi = &self.remote_file_descriptors[file_index];
    // ... 发起 FileContentsRequest DATA ...
}
```

**Step 3: 在 session.rs 暴露 JS 绑定**

```rust
#[wasm_bindgen]
pub fn trigger_file_download(&self, file_index: usize) -> Result<(), JsValue> { ... }
```

**Step 4: 编译验证**

```bash
wasm-pack build --target web crates/ironrdp-web
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(wasm): add on-demand file download trigger, remove auto-download"
```

---

### Task 2: Rust — 新增延迟 Promise 剪贴板命令

**Files:**
- Modify: `src-tauri/src/rdpdr_backend.rs`
- Modify: `src-tauri/src/macos_pasteboard_promise.rs`
- Modify: `src-tauri/src/lib.rs` (注册命令)
- Modify: `src-tauri/src/state.rs` (添加 channel 状态)

**Step 1: 添加 Promise 状态管理到 AppState**

```rust
// state.rs
pub struct PendingFilePromise {
    pub file_index: usize,
    pub file_name: String,
    pub total_size: u64,
    pub fulfiller: std::sync::mpsc::Sender<PathBuf>,
}
pub pending_file_promises: Mutex<HashMap<String, Vec<PendingFilePromise>>>,
```

**Step 2: 新增 `clipboard_register_promise` 命令**

在 `rdpdr_backend.rs` 添加命令：接收文件元信息列表 → 调用 `macos_pasteboard_promise.rs` 写入空 Promise → 返回成功。

```rust
#[tauri::command]
pub async fn clipboard_register_promise(
    app: AppHandle,
    app_state: State<'_, AppState>,
    session_id: String,
    files: Vec<FilePromiseInfo>,  // [{name, size}]
) -> Result<(), String> {
    // 1. 在主线程写入 NSPasteboardItemDataProvider (仅元信息，无数据)
    // 2. Provider 的 provideDataForType 回调中:
    //    a. 通过 Tauri event 通知 JS: "请下载 file_index=N"
    //    b. 阻塞等待 fulfiller channel 收到已完成的文件路径
    //    c. 读取文件数据设置到 pasteboard item
}
```

**Step 3: 新增 `clipboard_promise_fulfill` 命令**

JS 下载完成后调用此命令，通过 channel 唤醒阻塞的 provider 回调。

```rust
#[tauri::command]
pub async fn clipboard_promise_fulfill(
    app_state: State<'_, AppState>,
    session_id: String,
    file_index: usize,
    staged_path: String,
) -> Result<(), String> {
    // 通过 channel 发送 staged_path 给阻塞的 provideDataForType
}
```

**Step 4: 修改 `macos_pasteboard_promise.rs`**

改造 `NextDeskPasteboardPromiseProvider`:
- `file_data` 从 `Vec<u8>` 改为 `Option<Vec<u8>>`
- 添加 `fulfiller_rx: Option<mpsc::Receiver<PathBuf>>` 字段
- `provideDataForType` 中：若 data 为空，发 Tauri event + 阻塞等待 rx

**Step 5: 注册新命令到 lib.rs**

**Step 6: Commit**

```bash
git commit -m "feat(tauri): add lazy promise clipboard commands"
```

---

### Task 3: JS — 改造 fileChunkCallback 为按需模式

**Files:**
- Modify: `frontend/src/components/RdpManager.tsx:835-980`

**Step 1: 修改 `remoteClipboardChangedCallback`**

收到文件元信息后不再等待下载完成，立即调用 `clipboard_register_promise`。

```typescript
// 原来: 等 WASM 自动下载完 → stage → commit
// 改为: 立即注册 promise
const fileInfos = files.map(f => ({ name: f.name, size: f.size }));
await invoke('clipboard_register_promise', {
  sessionId: tabId, files: fileInfos
});
cblog('[file-transfer] Promise registered, waiting for paste trigger');
```

**Step 2: 监听 Tauri event "clipboard-download-request"**

```typescript
listen('clipboard-download-request', async (event) => {
  const { session_id, file_index } = event.payload;
  // 1. 调用 WASM: session.triggerFileDownload(file_index)
  // 2. fileChunkCallback 仍然流式写盘
  // 3. 完成后 invoke('clipboard_promise_fulfill', { path })
});
```

**Step 3: fileChunkCallback 逻辑保持不变**

已有的 Promise 链分块写入逻辑完全复用，只是触发时机从"自动"变为"event 驱动"。

**Step 4: 清理旧的预取逻辑**

移除 `remoteClipboardChangedCallback` 中的自动下载等待代码。

**Step 5: Commit**

```bash
git commit -m "feat(frontend): lazy paste - event-driven file download"
```

---

### Task 4: 集成测试与验证

**Step 1: 编译 WASM + 复制产物**

```bash
wasm-pack build --target web crates/ironrdp-web
cp pkg/* NextDesk/frontend/src/wasm/
```

**Step 2: 启动 tauri dev**

```bash
npx tauri dev
```

**Step 3: 测试用例**

| 场景 | 预期 |
|------|------|
| RDP 内复制小文件 (<5MB) → CMD+V | Finder 短暂显示进度 → 文件出现 |
| RDP 内复制大文件 (>100MB) → CMD+V | Finder 显示"正在准备拷贝" + 进度条 |
| RDP 内复制文件 A → 不粘贴 → 复制文件 B → CMD+V | 粘贴出 B（不是 A） |
| RDP 内复制文件 → 直接不粘贴 | 零网络流量（不下载） |
| 文本复制粘贴 | 不受影响 |
| 本地→RDP 文件 | 不受影响 |

**Step 4: Commit**

```bash
git commit -m "test: verify lazy paste end-to-end"
```

---

## 关键风险与缓解

| 风险 | 缓解 |
|------|------|
| `provideDataForType:` 在主线程，阻塞可能导致 UI 卡顿 | 使用 `run_on_main_thread` + channel，实际下载在后台线程 |
| Finder 对 provider 回调有超时限制 | 需测试确认超时阈值，必要时先写 0 字节占位再异步替换 |
| WASM 下载和 provider 回调的线程模型不匹配 | 通过 Tauri event 桥接 JS 单线程和 Rust 多线程 |
| 用户快速连续复制多个文件 | `download_generation` 机制已有，确保只下载最新选中的文件 |
