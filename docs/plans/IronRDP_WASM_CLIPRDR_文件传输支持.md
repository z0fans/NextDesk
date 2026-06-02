# IronRDP WASM CLIPRDR 文件传输支持

## 背景

`ironrdp-web/src/clipboard.rs` 已有 `on_file_contents_request`/`on_file_contents_response` 方法骨架，但标注 `// File transfer not implemented yet`。需要 fork ironrdp 并补全 4 处实现。

## 需要修改的文件

### ironrdp-web `clipboard.rs`

#### 1. 声明文件传输能力

```diff
 fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
-    ClipboardGeneralCapabilityFlags::empty()
+    ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
+        | ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
+        | ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS
+        | ClipboardGeneralCapabilityFlags::CAN_LOCK_CLIPDATA
 }
```

#### 2. 处理本地文件 → FormatList

在 `handle_local_clipboard_changed` 中添加文件 MIME 分支：

```rust
// 新增 MIME type 用于标识文件传输
const MIME_FILE: &str = "application/x-rdp-file";

// 在 match 中添加：
MIME_FILE => {
    // 构造 FileGroupDescriptorW 格式
    formats.push(
        ClipboardFormat::new(ClipboardFormatId::new(0xC005))
            .with_name(ClipboardFormatName::new_static(FORMAT_NAME_FILE_LIST))
    );
}
```

#### 3. 实现 `on_file_contents_request` — 服务端请求文件内容

```rust
fn on_file_contents_request(&mut self, request: FileContentsRequest) {
    // 从 local_clipboard 中获取文件数据
    // 根据 request.stream_id 和 request.index 定位文件
    // 构造 FileContentsResponse 并发送
    self.send_event(WasmClipboardBackendMessage::FileContentsRequest(request));
}
```

#### 4. 新增 JS 回调 — 请求文件内容

需要新增 `onFileContentsRequest` JS 回调，允许前端提供文件数据：

```typescript
// 新 API
sessionBuilder.fileContentsCallback((request) => {
    // request: { streamId, index, offset, length }
    // 前端从 Tauri 读取文件块，返回数据
    return invoke('read_file_chunk', { ... });
})
```

---

## User Review Required

> [!IMPORTANT]
> 此方案需要 **fork 并重编译 IronRDP WASM 模块**。工程步骤：
> 1. `git clone` IronRDP 仓库
> 2. 修改 `crates/ironrdp-web/src/clipboard.rs`
> 3. 使用 `wasm-pack build` 重新编译
> 4. 替换项目中的 `.wasm` 和 `.js` 文件
>
> 预计修改 ~200 行 Rust 代码，需要 Rust + wasm-pack 工具链。

> [!WARNING]
> **替代快捷方案**：如果不想重编译 WASM，可以利用已有的 `addBinary("application/x-rdp-file", data)` + 在 `handle_local_clipboard_changed` 中识别这个特殊 MIME type，但仍需修改 Rust 源码。**没有纯前端方案**。

## 验证计划

1. 在 macOS 上复制文件 → RDP 会话内粘贴 → 确认文件出现
2. 在 RDP 内复制文件 → macOS 粘贴 → 确认文件保存到本地
3. 测试大文件 (>10MB)、多文件、子目录
