# CLIPRDR 文件传输标准化设计

## 问题背景

当前 NextDesk 的 RDP 剪贴板文件传输是 ad-hoc 实现，存在以下问题：

| 问题 | 现状 | 标准做法 |
|------|------|---------|
| 内存占用 | 全量下载到 WASM 内存 → JS → JSON → Rust | 延迟渲染，按需分块读取 |
| 大文件 | 383MB 导致 OOM（已用分块修复但仍一次全下） | 粘贴时才开始下载 |
| 数据传递 | `Array.from()` 转换 + JSON 序列化 | 直接 WASM↔Rust 通道 |
| 剪贴板锁 | 无 `CB_CAN_LOCK_CLIPDATA` 支持 | clipDataId 锁定 |
| 反馈循环 | 多处 Ref 防环 hack | 统一状态机 |

## 标准化架构：三层分离

```
┌──────────────────────────────────────────────────┐
│  Layer 1: CLIPRDR Protocol  (WASM - clipboard.rs)│
│  • FormatList / FormatData 交换                   │
│  • FileContentsRequest / Response 协议处理         │
│  • CB_CAN_LOCK_CLIPDATA 锁管理                    │
│  → 只处理 RDP 协议，不关心本地文件系统              │
├──────────────────────────────────────────────────┤
│  Layer 2: Transfer Engine  (Rust - Tauri)        │
│  • 文件暂存管理（staging directory）               │
│  • 分块写入磁盘（streaming, 不全量放内存）          │
│  • macOS/Windows 剪贴板原生 API                   │
│  → 跨平台文件 I/O + 剪贴板操作                    │
├──────────────────────────────────────────────────┤
│  Layer 3: UI Coordinator  (JS - RdpManager.tsx)  │
│  • 用户交互（Focus/Paste 事件）                    │
│  • 传输进度显示                                   │
│  • 防重复/防循环的状态管理                         │
│  → 只做 UI 协调，不接触文件数据                    │
└──────────────────────────────────────────────────┘
```

---

## 方案对比

### 方案 A：渐进式优化（推荐 ⭐）

在当前架构上标准化，不改 WASM 层核心逻辑。

**改动范围**：JS + Rust，不重编 IronRDP WASM

**核心改进**：
1. 大文件分块传输已实现（2MB/chunk）
2. 统一状态机替代散落的 Ref 防环逻辑
3. 剪贴板写入标准化（已修复 `declareTypes` 原子操作）
4. 添加传输进度 UI

**优点**：改动小、风险低、立即可用
**缺点**：仍然是"先全量下载到 WASM 内存，再分块传给 Rust"

---

### 方案 B：WASM 直通 Rust 管道

修改 IronRDP WASM 层，文件数据不经过 JS，直接从 WASM 写入 Rust。

**核心改进**：
1. WASM 端收到 FileContentsResponse 后，通过 Tauri IPC 直接写入磁盘
2. JS 只收到元数据通知（文件名、大小、进度百分比）
3. 不再有 `Array.from()` 和 JSON 序列化

**数据流变化**：
```
当前:  WASM → [全量] → JS → Array.from() → JSON → Tauri → 磁盘
方案B: WASM → [分块] → Tauri fetch/XHR → 磁盘
                       → JS [仅元数据通知]
```

**优点**：内存恒定 O(chunk_size)，可传任意大小文件
**缺点**：需要修改 IronRDP WASM crate 并重编译

---

### 方案 C：完全延迟渲染（类 FreeRDP FUSE）

粘贴时才开始下载，使用 macOS `NSFilePromiseProvider`。

**数据流**：
```
1. 服务端复制文件 → FormatList (只有元数据)
2. 客户端写 NSFilePromiseProvider 到剪贴板
3. 用户 CMD+V → macOS 调用 promise → 触发下载
4. WASM 发 FileContentsRequest → 服务端返回数据块 → 写入磁盘
5. Promise resolve → Finder 显示文件
```

**优点**：完全符合 MS-RDPECLIP 标准，零预下载
**缺点**：
- 需要大量 macOS 原生代码（ObjC/Swift bridge）
- `NSFilePromiseProvider` 在 Tauri WebView 中行为未验证
- 可能需要数周开发周期
- Windows 端需要另一套实现（`IDataObject` + `IStream`）

---

## 我的推荐

**方案 A（渐进式优化）** — 当前已完成大部分工作，只需要补充：

1. [ ] 统一状态机（替代 remoteClipboardFileKeyRef 等散落的 Ref）
2. [ ] 传输进度 UI（Toast 通知 + 百分比）
3. [ ] 文件大小限制提示（>2GB 提示用驱动器重定向）

如果未来需要支持超大文件（>500MB）的流畅体验，再升级到 **方案 B**。

## 验证标准

- [ ] 小文件 (<10MB) 复制粘贴 < 2 秒
- [ ] 大文件 (100MB+) 不 OOM，有进度提示
- [ ] 连续快速复制 5 个文件，每次粘贴正确文件
- [ ] Focus 切换不触发反馈循环
- [ ] RDP 内部粘贴无延迟
