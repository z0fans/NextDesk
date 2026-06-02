# Native RDP Session 全 Rust 架构升级

**Goal:** WASM→Native Rust，实现 TCP 直连 + cpal 音频直出 + 零 WebSocket 桥接。

## 阶段 1: MVP（本次实施）

### Task 1.1: Cargo.toml 添加 IronRDP native 依赖
- `ironrdp` (path, features: session/connector/input/graphics/rdpsnd/rdpdr/cliprdr/displaycontrol/dvc/svc/echo)
- `ironrdp-core`, `ironrdp-tokio` (features: reqwest), `ironrdp-tls` (native-tls)
- `ironrdp-rdpsnd-native`, `ironrdp-rdcleanpath` (path 替换 crates.io)
- `smallvec`, `x509-cert`, `tokio-tungstenite` (保留), `tokio-util`

### Task 1.2: 创建 `src-tauri/src/rdp_session.rs`
- 参考 `ironrdp-client/src/rdp.rs` 的 `RdpClient` + `active_session` 模式
- `NativeRdpSession`: 封装连接/会话循环/输入/帧输出
- `connect()`: TCP直连 → TLS upgrade → connect_finalize
- `active_session()`: tokio::select 处理服务器帧 + 前端输入
- 帧输出通过 `tauri::Emitter` 推送 `rdp://frame` 事件
- 输入通过 `tokio::mpsc` 接收前端 invoke
- 音频: `ironrdp_rdpsnd_native::cpal::RdpsndBackend`（零 IPC）

### Task 1.3: Tauri 命令注册
- `rdp_native_connect(tab_id, host, port, username, password, domain, width, height)`
- `rdp_native_input(tab_id, input_type, data)` — 键鼠输入
- `rdp_native_disconnect(tab_id)` — 断开
- `rdp_native_resize(tab_id, width, height)` — 分辨率切换
- AppState 新增 `native_sessions: HashMap<String, SessionHandle>`

### Task 1.4: 前端适配
- `RdpManager.tsx` 新增 native 连接路径
- `connectSession()` 调用 `rdp_native_connect` 替代 WASM builder
- 监听 `rdp://frame` 事件渲染 Canvas
- 键鼠 handler 调用 `rdp_native_input`

## 验证
- `cargo check` 编译通过
- `tsc --noEmit` 前端编译通过
