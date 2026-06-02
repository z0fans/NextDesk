# Phase 2-4 渲染优化实施计划

## Phase 2 — 零拷贝 + rAF 帧合并（~80行改动）

### 目标
消除 `extract_partial_image` 的 `Vec<u8>` 分配，用 `UNPACK_ROW_LENGTH` 直接引用 `DecodedImage` 切片。合并多次 `GraphicsUpdate` 为单次 `drawArrays` 调用。

---

### [MODIFY] [image.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/src/image.rs)

新增 `extract_partial_image_ref` 返回 `&[u8]` 切片 + stride 信息，避免 Vec 分配：
- 返回 `(region, &[u8], stride)` — 直接引用 `DecodedImage::data()`
- 保留旧函数作为回退，新函数零拷贝

### [MODIFY] [canvas.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/src/canvas.rs)

新增 `draw_strided()` 方法，用 WebGL2 `UNPACK_ROW_LENGTH` 上传非连续内存：
- 设置 `gl.pixel_storei(GL::UNPACK_ROW_LENGTH, image_width)`
- 设置 `gl.pixel_storei(GL::UNPACK_SKIP_PIXELS, region.left)`
- 设置 `gl.pixel_storei(GL::UNPACK_SKIP_ROWS, region.top)`
- 调用 `texSubImage2D` 上传
- 恢复 pixel store 状态

新增 `flush()` — 单独执行 `drawArrays`（与纹理上传分离）

### [MODIFY] [session.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/src/session.rs) L667-670

批量处理 `GraphicsUpdate`：
- 在 output 循环中，多个 `GraphicsUpdate` 只调 `draw_strided` 上传纹理
- 循环结束后单次 `gui.flush()` 执行渲染

---

## Phase 3 — H.264 硬件解码（~500行新增）

### 目标
注册 GFX 动态通道，接收 H.264 NAL 单元，通过 JS callback 传递给前端 WebCodecs `VideoDecoder` 进行 GPU 硬解码。

> [!IMPORTANT]
> Phase 3 需要 RDP 服务端支持 GFX Pipeline + AVC 编码。Windows 10+ RDP 服务端默认支持。

---

### [MODIFY] [Cargo.toml](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/Cargo.toml)

添加依赖：`ironrdp-egfx`

### [NEW] [gfx.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/src/gfx.rs)

实现 `GraphicsPipelineHandler` trait：
- `WasmGfxHandler` 结构体，持有 JS callback 引用
- `handle_pdu()` — 解析 `GfxPdu::WireToSurface` 提取 H.264 NAL 数据
- 通过 callback 将 NAL 数据传递给前端 JS

### [MODIFY] [session.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/src/session.rs)

- `ConnectParams` 增加 `gfx_callback: Option<js_sys::Function>`
- 在 `connect()` 中注册 GFX 动态通道：
```rust
let gfx_handler = WasmGfxHandler::new(callback);
let gfx_client = GraphicsPipelineClient::new(Box::new(gfx_handler));
connector.attach_static_channel(
    DrdynvcClient::new()
        .with_dynamic_channel(gfx_client)
        .with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new())))
);
```

### [MODIFY] [lib.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/src/lib.rs)

注册 `mod gfx`

### 前端侧 (NextDesk)

在 `RdpManager.tsx` 中接收 NAL 数据，用 `VideoDecoder` 解码：
```typescript
const decoder = new VideoDecoder({
  output: (frame) => {
    // texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE, frame)
    frame.close();
  },
  error: console.error,
});
decoder.configure({ codec: 'avc1.42E01E', optimizeForLatency: true });
```

---

## Phase 4 — OffscreenCanvas Worker 分流（~300行新增）

### 目标
将渲染和解码移入 Web Worker，主线程仅处理输入事件，实现零卡顿。

---

### [NEW] `render_worker.ts`

独立 Worker：
- 接收 OffscreenCanvas
- 创建 WebGL2 context
- 处理纹理上传和 VideoDecoder
- 帧同步使用 `requestAnimationFrame`

### [MODIFY] `RdpManager.tsx`

- `canvas.transferControlToOffscreen()` → 传递给 Worker
- 输入事件留在主线程
- Worker 通过 `postMessage` 接收位图/NAL 数据

---

## 验证方案

| 阶段 | 验证方法 |
|------|----------|
| P2 | `wasm-pack build` 编译通过 + RDP 连接画面正常 + console 无 Vec 分配日志 |
| P3 | 连接 Windows 10+ 主机 → console 显示 GFX 通道激活 → H.264 帧解码 |
| P4 | Chrome DevTools Performance → 主线程占用 < 5ms/帧 |

## 实施顺序

**Phase 2 → Phase 3 → Phase 4**，每阶段完成后编译验证再进入下一阶段。
