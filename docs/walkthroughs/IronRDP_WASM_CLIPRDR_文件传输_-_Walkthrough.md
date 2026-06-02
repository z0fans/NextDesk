# IronRDP WASM CLIPRDR 文件传输 — Walkthrough

## 修改概览

在 IronRDP WASM 模块中实现了 CLIPRDR 文件传输协议支持，共修改 **6 个文件**。

## 修改的文件

### 1. [clipboard.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/src/clipboard.rs) — 核心修改

| 修改点 | 说明 |
|--------|------|
| `client_capabilities()` | 启用 `STREAM_FILECLIP_ENABLED` + `FILECLIP_NO_FILE_PATHS` + `CAN_LOCK_CLIPDATA` |
| `handle_local_clipboard_changed()` | 新增 `MIME_FILE` → `FileGroupDescriptorW` 格式映射 |
| `process_remote_data_request()` | 新增 `FORMAT_FILE_LIST_ID` 分支，JSON → `PackedFileList` 编码 |
| `on_file_contents_request/response()` | 转发至 JS 回调（通过 `serde_wasm_bindgen` 序列化） |
| `process_event()` | 新增 `FileContentsRequest/Response` 消息处理分支 |
| 新增结构体 | `FileInfo`（JS→Rust 文件元数据）、`FileContentsRequestJs`（Rust→JS 请求序列化）|

### 2. [Cargo.toml](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/Cargo.toml) — 新增依赖

```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde-wasm-bindgen = "0.6"
```

### 3. [iron-remote-desktop/session.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/iron-remote-desktop/src/session.rs) — Trait 扩展

新增 `file_contents_request_callback()` 和 `file_contents_response_callback()` 方法。

### 4. [iron-remote-desktop/lib.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/iron-remote-desktop/src/lib.rs) — WASM Macro 绑定

在 `make_bridge!` 宏中暴露 `fileContentsRequestCallback` 和 `fileContentsResponseCallback`。

### 5. [ironrdp-web/session.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/src/session.rs) — 集成

- `SessionBuilderInner` 新增 2 个回调字段
- 实现 trait 方法
- `JsClipboardCallbacks` 构造时传递回调

## 验证结果

```
✅ cargo check -p ironrdp-web --target wasm32-unknown-unknown — PASS
   0 errors, 0 新增 warnings
```

## 后续步骤

1. **`wasm-pack build`** 编译 release WASM 模块
2. **替换** 项目中 `.wasm` / `.js` 文件
3. **前端适配** — 注册回调 + 实现 Tauri Command
4. **端到端测试**
