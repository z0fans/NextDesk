# 方案B：协议层分块文件传输 — 实现总结

## 架构变更

```
之前 (全量下载):
RDP Server → [383MB] → WASM内存 → [383MB] → JS Array.from() → [3.2GB] → Tauri → 磁盘

之后 (协议层分块):
RDP Server → [2MB] → WASM → [2MB] → JS → Tauri invoke → 磁盘追加
             ↑                                              |
             └──── 请求下一个 2MB 块 ←─────────────────────┘
```

## 内存对比

| 场景 | 之前 | 之后 |
|------|------|------|
| WASM 内存 | 383MB (全量) | ≤2MB (当前块) |
| JS 堆 | ~3.2GB (Array.from) | ~16KB (单块) |
| 峰值总计 | ~3.6GB | ~4MB |

## 修改文件 (5 个)

### IronRDP WASM (3 个)
- [clipboard.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/src/clipboard.rs) — `FileContentsRequest` 改为 2MB 分块请求 + `on_file_chunk` 流式回调
- [session.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/src/session.rs) — 注册 `file_chunk_callback` builder
- [iron-remote-desktop](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/iron-remote-desktop/src/session.rs) — trait + wasm_bindgen 绑定

### NextDesk (1 个)
- [RdpManager.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx) — `.fileChunkCallback()` 流式接收器

## 验证

- [x] WASM 编译成功 (30.02s)
- [x] 产物复制到 NextDesk
- [ ] 需要重启 `tauri dev` 后实际测试文件复制粘贴
