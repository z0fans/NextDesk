# CLIPRDR 链路审查报告 — 对齐 Jump Desktop

## Local → Remote 大文件传输链路

```
┌──────────────────────────────────────────────────────────┐
│ Step 1: Tauri clipboard_read_files_data                  │
│ ≤2MB → 返回 {name, path, size, data}                     │
│ >2MB → 返回 {name, path, size, data: []}  ← LAZY        │
│ 文件: rdpdr_backend.rs L566-611                           │
│ ✅ 正确                                                   │
└────────────────────┬─────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────┐
│ Step 2: JS addClipboardFiles                             │
│ data 非空 → addBinary(file.name, data)                   │
│ data 空 + path → addBinary(file.path, Uint8Array(0))     │
│ 同时 addBinary(MIME_FILE, JSON descriptors)               │
│ 文件: RdpManager.tsx L152-176                             │
│ ✅ 正确 — descriptors 包含所有文件 name+size              │
└────────────────────┬─────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────┐
│ Step 3: WASM handle_local_clipboard_changed              │
│ 1) 解析 MIME_FILE JSON → descriptor_sizes[]              │
│ 2) 遍历 non-MIME items:                                  │
│    - data 非空 → local_files[i] = data                   │
│    - data 空   → local_file_paths[i] = path              │
│                  local_file_sizes[i] = descriptor_sizes[i]│
│ 3) file_idx 统一递增，与 descriptor 索引对齐             │
│ 文件: clipboard.rs L235-280                               │
│ ✅ 正确 — 混合 small+large 索引对齐                       │
└────────────────────┬─────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────┐
│ Step 4: Windows Ctrl+V → FileContentsRequest(SIZE)       │
│ → 返回 local_file_sizes[index]（非 data.len()）          │
│ 文件: clipboard.rs L769-775                               │
│ ✅ 正确 — lazy 文件返回实际大小                           │
└────────────────────┬─────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────┐
│ Step 5: Windows → FileContentsRequest(DATA, offset, len) │
│ Case A: data 非空 → 立即返回 data[offset..offset+len]    │
│ Case B: data 空 + callback 存在 →                        │
│   spawn_local {                                          │
│     JsFuture::from(cb.call3(path, offset, len)).await    │
│     → Uint8Array → FileContentsResponse::new_data_response│
│     → proxy.send_cliprdr_message(SendFileContentsResponse)│
│   }                                                      │
│ 文件: clipboard.rs L776-842                               │
│ ✅ 正确 — 异步读取 + 错误处理                             │
└────────────────────┬─────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────┐
│ Step 6: JS cliprdr_read_callback                         │
│ invoke('rdpdr_read_file_chunk', {baseFolder:'', path})   │
│ → Tauri 异步读取文件块 → 返回 Uint8Array                 │
│ 文件: RdpManager.tsx L678-689                             │
│ ✅ 正确 — baseFolder='' + 绝对路径                        │
└────────────────────┬─────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────┐
│ Step 7: Session event loop                               │
│ RdpInputEvent::Cliprdr(SendFileContentsResponse)         │
│ → cliprdr.submit_file_contents(response)                 │
│ → process_svc_processor_messages → 发送到 RDP server     │
│ 文件: session.rs L688-691                                 │
│ ✅ 正确                                                   │
└──────────────────────────────────────────────────────────┘
```

## 对齐 Jump Desktop 分析

| 特性 | Jump Desktop | NextDesk (当前) | 状态 |
|------|-------------|----------------|------|
| 只发元数据 (FormatList) | ✅ | ✅ | 对齐 |
| DATA 按需读取 | ✅ 原生异步IO | ✅ spawn_local + JsFuture | 功能等价 |
| 不预加载大文件 | ✅ | ✅ >2MB lazy | 对齐 |
| SIZE 返回实际大小 | ✅ | ✅ descriptor 解析 | 对齐 |
| 分块传输 | ✅ RDP 协议控制 | ✅ 服务器自行分块请求 | 对齐 |

## 结论

**Local→Remote 链路完整对齐 Jump Desktop 方案。** 请测试验证。
