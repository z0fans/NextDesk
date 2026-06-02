# RDP Debug Log 模块 (Dev-Only)

仅在 `npx tauri dev` 开发模式下启用的结构化 RDP 调试日志，写入固定文件供 AI Agent 实时读取排错。生产构建完全不包含。

## 设计要点

- **开发模式门控** — `import.meta.env.DEV` 为 true 时才记录，生产构建被 tree-shake 掉
- **固定文件路径** — `/tmp/nextdesk_rdp_debug.log`，AI 通过 `tail -100` 或 `cat` 即可读取
- **覆盖全部 RDP 操作** — 9 个模块: connection / clipboard / input / render / audio / file / network / proxy / wasm
- **启动时清空** — 每次 dev 启动重置日志文件，避免历史干扰

## 文件变更

### [NEW] [rdp-logger.ts](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/lib/rdp-logger.ts)

```typescript
// 核心逻辑伪码
if (!import.meta.env.DEV) {
  // 导出空函数，生产构建零开销
  export const rdpLog = { info: noop, warn: noop, error: noop, debug: noop };
} else {
  // 开发模式：console 输出 + 批量写文件（invoke → Rust 追加到 /tmp/nextdesk_rdp_debug.log）
}
```

### [MODIFY] [lib.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/src/lib.rs)
- 重写 `frontend_log` → `rdp_log_batch`，接收 `Vec<{ts, level, module, msg}>` 批量追加到固定日志文件
- 新增 `rdp_log_clear` — 前端启动时调用，清空旧日志

### [MODIFY] [RdpManager.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx)
- 替换 ~30 处 `console.log('[rdp]...')` → `rdpLog.info('connection', ...)`
- 改造 `cblog()` 和 `installRdpConsoleBridge()` → 使用 `rdpLog`

### [MODIFY] [rdp-audio.ts](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/lib/rdp-audio.ts) — 3 处

### [MODIFY] [h264-decoder.ts](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/lib/h264-decoder.ts) — 5 处

### [MODIFY] [RdpViewer.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpViewer.tsx) — 2 处

## AI 读取方式

```bash
# 实时查看最新日志
tail -200 /tmp/nextdesk_rdp_debug.log

# 按模块过滤（如只看连接相关）
grep '"module":"connection"' /tmp/nextdesk_rdp_debug.log | tail -50

# 只看错误
grep '"level":"error"' /tmp/nextdesk_rdp_debug.log
```
