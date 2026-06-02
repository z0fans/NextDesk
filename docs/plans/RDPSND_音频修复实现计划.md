# RDPSND 音频修复实现计划

> 修复远程音频无声音 + 滑块卡顿

**Goal:** 修复 `format_no` 索引不匹配导致 Win Server 2019 远程音频完全静音的 bug

**Architecture:** 修改 `RdpsndClientHandler::wave()` trait，在 `Rdpsnd::process()` 中查找服务器格式后传给 handler，同时更新 WASM 和 cpal 两个后端实现

**Tech Stack:** Rust (IronRDP WASM), TypeScript (rdp-audio.ts)

---

## 根因

`Wave2` PDU 的 `format_no` 是服务器格式列表索引，但 handler 用它查客户端本地格式列表（仅 2-7 种），Win Server 2019 有 20+ 种，选中索引 ≥ 7 时直接 return，音频数据全部丢弃。

## Proposed Changes

### IronRDP RDPSND Client

#### [MODIFY] [client.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-rdpsnd/src/client.rs)

1. 修改 `RdpsndClientHandler::wave()` 签名，新增 `format: &AudioFormat` 参数
2. 修改 `Rdpsnd::process()` Wave2 分支，用 `self.get_format(format_no)?` 查服务器格式后传入 handler

---

### WASM RDPSND Backend

#### [MODIFY] [rdpsnd.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/src/rdpsnd.rs)

1. `wave()` 方法签名更新，使用传入的 `format` 替代 `self.formats[format_no]` 查找
2. 删除 `formats` 字段（不再需要本地格式列表做 fallback）
3. 保留 `active_format` 用于检测格式变化

---

### Native RDPSND Backend (cpal)

#### [MODIFY] [cpal.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-rdpsnd-native/src/cpal.rs)

1. `wave()` 方法签名更新，使用传入的 `format` 替代 `self.get_formats().get(format_no)` 查找

---

### FFI Noop Backend

#### [MODIFY] [mod.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/ffi/src/connector/mod.rs)

1. `NoopRdpsndBackend::wave()` 签名更新（添加未使用参数）

---

## Verification Plan

### Manual Verification

1. 在 IronRDP 仓库执行 `cargo check -p ironrdp-rdpsnd` 确认编译通过
2. 执行 `cargo check -p ironrdp-web --target wasm32-unknown-unknown` 确认 WASM 编译通过
3. 执行 `wasm-pack build --target web crates/ironrdp-web` 生成新 WASM
4. 复制 WASM 产物到 NextDesk，启动 `npx tauri dev`
5. 连接 Win Server 2019，检查控制台是否打印 `[rdp-audio] format:` 日志
6. 在远程桌面播放音频，确认本地能听到声音
7. 拖动远程音量滑块，确认不再卡顿
