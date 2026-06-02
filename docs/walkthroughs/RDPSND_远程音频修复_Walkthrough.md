# RDPSND 远程音频修复 Walkthrough

## 问题
1. Win Server 2019 远程音频完全无声
2. 拖动远程音量滑块时卡顿

## 根因
`RdpsndClientHandler::wave()` trait 将服务器的 `format_no`（服务器格式列表索引）传给 handler，但所有 handler 实现都用该索引查**客户端本地**格式列表。Win Server 2019 有 20+ 种格式，选中索引 ≥ 7 时越界 → `return` → 音频数据全部丢弃。

## 修改文件

### IronRDP 仓库

| 文件 | 变更 |
|---|---|
| [client.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-rdpsnd/src/client.rs) | `wave()` trait 签名改为 `&AudioFormat`；`process()` 用 `get_format()` 查服务器格式 |
| [rdpsnd.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/src/rdpsnd.rs) | WASM 后端使用传入格式，删除错误的 fallback lookup |
| [cpal.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-rdpsnd-native/src/cpal.rs) | 原生后端使用传入格式，`format_no` 类型改为 `u32` |

### NextDesk 仓库
- `frontend/src/wasm/` — 更新 WASM 产物（.js, .wasm, .d.ts）

## 验证结果
- ✅ `cargo check -p ironrdp-rdpsnd` — 通过
- ✅ `cargo check -p ironrdp-web --target wasm32-unknown-unknown` — 通过（仅 warnings）
- ✅ `wasm-pack build --target web crates/ironrdp-web` — 成功（19.18s）
- ✅ WASM 产物已复制到 NextDesk

## 待用户测试
运行 `npx tauri dev` 连接 Win Server 2019，验证：
1. 控制台输出 `[rdp-audio] format:` 日志（确认格式协商成功）
2. 远程播放音频时本地能听到声音
3. 拖动音量滑块不再卡顿
