# CLIPRDR 原生文件传输实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标:** 将 CLIPRDR 大文件传输从 WASM→JS→Rust 多层跨越改为 WASM→WebSocket→Rust 直推，消除 JS 中转瓶颈，实现与 Jump Desktop 同等的大文件复制粘贴体验。

**架构:** WASM CLIPRDR 收到 FileContentsResponse 数据后，通过专用 WebSocket 把原始字节直接推给 Rust 后端写磁盘。Rust 端完成文件写入后注册到 macOS pasteboard / Windows clipboard。渲染层不动。

**技术栈:** Rust (tokio + tokio-tungstenite), IronRDP WASM (wasm-bindgen + web-sys WebSocket), Tauri 2 IPC

---

## 文件结构

| 文件 | 操作 | 职责 |
|:---|:---|:---|
| `src-tauri/src/file_transfer_ws.rs` | 新建 | WebSocket server + 文件接收 + pasteboard 注册 |
| `src-tauri/src/lib.rs` | 修改 | 注册模块 + 启动 server + 暴露端口命令 |
| `src-tauri/src/state.rs` | 修改 | 新增 file_transfer_port 字段 |
| `IronRDP/crates/ironrdp-web/src/clipboard.rs` | 修改 | 大文件 FileContentsResponse 转发到 WS |
| `IronRDP/crates/ironrdp-web/src/session.rs` | 修改 | 新增 file_transfer_port extension 解析 |
| `frontend/src/components/RdpManager.tsx` | 修改 | 传递 file_transfer_port extension + 简化大文件 JS 路径 |

---

## 协议格式

```text
WASM → Rust (二进制 WebSocket 消息):

cmd=0x01 FILE_BEGIN:
  [1B cmd=0x01][2B name_len LE][N name_utf8][8B file_size LE][32B session_id_utf8 零填充]

cmd=0x02 FILE_CHUNK:
  [1B cmd=0x02][32B session_id_utf8][4B chunk_len LE][N data]

cmd=0x03 FILE_COMPLETE:
  [1B cmd=0x03][32B session_id_utf8][1B file_index][1B total_files]

cmd=0x04 TRANSFER_DONE:
  [1B cmd=0x04][32B session_id_utf8]

Rust → WASM (文本 WebSocket 消息, JSON):
  {"type":"ack","session_id":"..."}
  {"type":"error","session_id":"...","message":"..."}
  {"type":"committed","session_id":"...","paths":["..."]}
```

---

## Task 1: Rust 端 — file_transfer_ws.rs 完整实现

**Files:**
- Create: `src-tauri/src/file_transfer_ws.rs`
- Modify: `src-tauri/src/lib.rs` (添加 `mod file_transfer_ws;`)

- [ ] **Step 1: 创建 file_transfer_ws.rs（完整代码在 Memora id=50 设计中）**

核心逻辑：启动本地 WS server → 解析二进制消息 → 流式写磁盘 → TRANSFER_DONE 时注册 pasteboard → emit 事件通知前端。

- [ ] **Step 2: lib.rs 添加 `mod file_transfer_ws;`**

- [ ] **Step 3: `cargo check` 验证**

- [ ] **Step 4: 提交 `feat(cliprdr): add file_transfer_ws server`**

---

## Task 2: Rust 端 — 启动 server + 暴露端口

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: state.rs 添加 `file_transfer_ws_port: Arc<Mutex<u16>>`**

- [ ] **Step 2: lib.rs setup 中启动 server 并存储端口**

- [ ] **Step 3: 新增 `get_file_transfer_ws_port` Tauri 命令**

- [ ] **Step 4: `cargo check` 验证**

- [ ] **Step 5: 提交 `feat(cliprdr): start file_transfer_ws on setup`**

---

## Task 3: IronRDP WASM — clipboard 大文件 WS 转发

**Files:**
- Modify: `IronRDP/crates/ironrdp-web/src/clipboard.rs`
- Modify: `IronRDP/crates/ironrdp-web/src/session.rs`

- [ ] **Step 1: session.rs 解析 `file_transfer_port` extension**

- [ ] **Step 2: clipboard.rs 建立 WebSocket 连接（web_sys::WebSocket）**

- [ ] **Step 3: FileContentsResponse ≥2MB 时走 WS 直推（FILE_BEGIN + FILE_CHUNK + FILE_COMPLETE + TRANSFER_DONE）**

- [ ] **Step 4: `wasm-pack build --target web crates/ironrdp-web`**

- [ ] **Step 5: 复制产物到 `NextDesk/frontend/src/wasm/`**

- [ ] **Step 6: 提交 `feat(cliprdr): WASM bypass JS for large file transfer`**

---

## Task 4: 前端集成

**Files:**
- Modify: `frontend/src/components/RdpManager.tsx`

- [ ] **Step 1: connectSession 中获取端口并传 extension**

```typescript
const ftPort = await invoke<number>('get_file_transfer_ws_port');
if (ftPort > 0) {
  builder.extension(new wasm.Extension('file_transfer_port', ftPort));
}
```

- [ ] **Step 2: 监听 `file-transfer://committed` 事件释放传输锁**

- [ ] **Step 3: `npx tsc --noEmit` 验证**

- [ ] **Step 4: 提交 `feat(cliprdr): frontend file_transfer_ws integration`**

---

## Task 5: 端到端验证

- [ ] **Step 1: `npx tauri dev` 确认 "File transfer WS port: XXXXX" 日志**
- [ ] **Step 2: 远程复制 5MB 文件 → 本地 Cmd+V → 文件出现**
- [ ] **Step 3: 远程复制 100MB+ 文件 → 不卡死，传输完成**
- [ ] **Step 4: 远程复制 <2MB 小文件 → 仍走 JS callback**
- [ ] **Step 5: 本地→远程文件传输不受影响**

---

## 回退方案

- `file_transfer_port` extension 未传 → WASM 走原有 JS callback
- 所有现有功能不受影响

## 日后演进到全原生

- `USE_NATIVE_RDP = true` 时 `cliprdr_backend.rs` 直接处理
- 复用 `file_transfer_ws.rs` 的写磁盘 + pasteboard 逻辑
- 删除 WS server 启动代码
