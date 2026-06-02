# 对齐 Jump Desktop 文件传输方式

## 背景

Jump Desktop 不使用 RDPDR 驱动器挂载（`\\tsclient\`），而是纯 CLIPRDR 剪贴板通道实现文件传输。

## 当前状态

| 功能 | 状态 | 问题 |
|---|---|---|
| CLIPRDR 文本/图片复制 | ✅ 双向可用 | - |
| CLIPRDR 小文件传输 | ✅ 可用 | - |
| CLIPRDR 大文件 Local→Remote | ⚠️ 可能 OOM | 整个文件读入 `Vec<u8>` 内存 |
| CLIPRDR 大文件 Remote→Local | ⚠️ 需验证 | 一次请求全部 DATA |
| RDPDR 驱动器(小文件) | ✅ 可用 | - |
| RDPDR 驱动器(大文件) | ⚠️ 刚改造完 | 方案 A 待验证 |

## 三阶段路线图

### 阶段 1：验证 RDPDR 异步改造 (已完成)

验证方案 A 是否让 `\\tsclient\NextDesk` 支持大文件。这是基础设施。

### 阶段 2：CLIPRDR 大文件优化 (核心工作)

实现 Jump Desktop 的纯剪贴板大文件传输。

#### 2A: Local → Remote 大文件

**当前问题**：`clipboard_read_files_data` 一次性读取整个文件到 `Vec<u8>`，100MB 文件 = 100MB 内存。

**修改方案**：延迟加载 + 按需读取

| 文件 | 改动内容 |
|---|---|
| `clipboard.rs` | `local_files` 从 `Vec<Vec<u8>>` 改为 `Vec<LocalFileEntry>`（存路径+大小，不存数据） |
| `clipboard.rs` | `FileContentsRequest(DATA)` 处理改为异步：通过 deferred channel 发送响应 |
| `RdpManager.tsx` | `forceUpdate` 只发送文件元数据（名称+大小），不发送二进制数据 |
| `src-tauri/` | 新增 `clipboard_read_file_chunk(path, offset, length)` 命令（复用 `rdpdr_read_file_chunk`） |

**流程**：
```
Cmd+C 文件 → 只发 FormatList(文件描述) → 不读取文件内容
       ↓
Windows Ctrl+V → FileContentsRequest(SIZE) → 返回文件大小
       ↓
Windows → FileContentsRequest(DATA, offset=0, len=65536) → Tauri 逐块读取 → 返回
       ↓
Windows → FileContentsRequest(DATA, offset=65536, ...) → 逐块读取 → 返回
       ↓
... 直到传完
```

#### 2B: Remote → Local 大文件

**当前问题**：DATA 请求用 `requested_size: file_size as u32`，一次请求全部数据。>4GB 文件会 u32 溢出；大文件可能超时。

**修改方案**：分块请求

| 文件 | 改动内容 |
|---|---|
| `clipboard.rs` | `FileContentsResponse` DATA 阶段改为循环分块请求（每块 1MB） |
| `clipboard.rs` | 累积收到的块，全部收完后触发 JS 回调写文件 |
| `RdpManager.tsx` | 可选：大文件使用流式下载写入（`invoke` 分块） |

### 阶段 3：用户体验对齐 (可选)

| 项目 | 说明 |
|---|---|
| 隐藏 RDPDR 驱动器 | 如果只用 CLIPRDR，可不配置 RDPDR，远程不显示 `\\tsclient\` |
| 传输进度条 | `FileContentsRequest` 分块时可计算进度 |
| 拖拽文件传输 | 从 Finder 拖文件到 RDP 窗口触发 CLIPRDR |

## 建议实施顺序

1. **先测试阶段 1**（重启 dev，测 RDPDR 大文件）
2. **实施阶段 2A**（CLIPRDR Local→Remote 延迟加载）— 工作量最大
3. **实施阶段 2B**（CLIPRDR Remote→Local 分块）— 相对简单
4. **阶段 3** 按需添加

## 验证方式

- 在远程 Windows 中 Ctrl+V 粘贴 >50MB 文件，验证传输完整性
- 在远程复制文件，本地 Cmd+V 粘贴 >50MB 文件
- 监控内存使用，确认无 OOM
