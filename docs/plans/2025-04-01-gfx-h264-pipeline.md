# H.264 NAL 转发 GFX 管线实现计划

> **For Antigravity:** REQUIRED WORKFLOW: Use `.agent/workflows/execute-plan.md` to execute this plan in single-flow mode.

**Goal:** 启用 GFX V8.1 H.264 AVC420 编解码，在 Rust 后端提取 NAL 数据，通过 WebSocket 转发到前端 WebCodecs VideoDecoder 做 GPU 硬件解码。

**Architecture:** Rust 后端广告 V8.1 + AVC420_ENABLED → 服务器发送 H.264 帧 → gfx_handler 解析 `Avc420BitmapStream` 提取 NAL → 构建 GFX 消息 `[0x01 + metadata + NAL]` → WebSocket → 前端已有的 `VideoDecoder` GPU 硬解 → WebGL2 纹理渲染。

**Tech Stack:** ironrdp-egfx (Avc420BitmapStream Decode), WebCodecs VideoDecoder, WebGL2

---

### Task 1: 修改 GFX Capabilities 为 V8.1

**Files:**
- Modify: `src-tauri/src/gfx_handler.rs:204-213`

**Step 1: 修改 capabilities() 方法**

将 V8 改为 V8_1 + AVC420_ENABLED：

```rust
fn capabilities(&self) -> Vec<CapabilitySet> {
    vec![
        CapabilitySet::V8_1 {
            flags: CapabilitiesV81Flags::AVC420_ENABLED,
        },
    ]
}
```

需要在 imports 中添加：
```rust
use ironrdp_egfx::pdu::{
    CapabilitiesV8Flags, CapabilitiesV81Flags, CapabilitySet,
    Codec1Type, GfxPdu, QueueDepth,
};
```

**Step 2: 编译验证**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: 编译通过（可能有 unused CapabilitiesV8Flags warning）

**Step 3: Commit**

```bash
git add src-tauri/src/gfx_handler.rs
git commit -m "feat(gfx): upgrade capabilities to V8.1 with AVC420 H.264"
```

---

### Task 2: 实现 H.264 NAL 提取和 GFX 消息构建

**Files:**
- Modify: `src-tauri/src/gfx_handler.rs:418-425`

**Step 1: 添加 ironrdp_pdu Decode import**

在 gfx_handler.rs 顶部 imports 添加：

```rust
use ironrdp_pdu::{Decode, ReadCursor};
use ironrdp_egfx::pdu::Avc420BitmapStream;
```

**Step 2: 实现 H.264 分支的 NAL 提取和转发**

替换现有的 AVC420 stub（行 418-425）：

```rust
Codec1Type::Avc420 => {
    // Parse AVC420 bitmap stream to extract NAL data
    let mut cursor = ReadCursor::new(&w2s.bitmap_data);
    match Avc420BitmapStream::decode(&mut cursor) {
        Ok(avc) => {
            self.send_h264_frame(w2s.surface_id, r, avc.data);
        }
        Err(e) => {
            eprintln!("[gfx] AVC420 decode error: {e:?}");
        }
    }
}
Codec1Type::Avc444 | Codec1Type::Avc444v2 => {
    // AVC444 contains AVC420 substreams
    // For now, forward as raw AVC420 (most servers use 420 with V8.1)
    let mut cursor = ReadCursor::new(&w2s.bitmap_data);
    match Avc420BitmapStream::decode(&mut cursor) {
        Ok(avc) => {
            self.send_h264_frame(w2s.surface_id, r, avc.data);
        }
        Err(e) => {
            eprintln!("[gfx] AVC444 parse error: {e:?}");
        }
    }
}
```

**Step 3: 实现 send_h264_frame 方法**

在 `impl NativeGfxHandler` 块中添加：

```rust
/// Build and send H.264 NAL frame to frontend via WebSocket.
/// Wire format: [1B type=0x01][2B surface_id][8B rect][1B codec][4B data_len][N data]
fn send_h264_frame(&self, surface_id: u16, rect: &ironrdp_pdu::geometry::InclusiveRectangle, nal_data: &[u8]) {
    // Total: 1 + 2 + 8 + 1 + 4 + N = 16 + N bytes
    let mut buf = Vec::with_capacity(16 + nal_data.len());
    buf.push(0x01u8); // MSG_H264_FRAME
    buf.extend_from_slice(&surface_id.to_le_bytes());  // 2B surface_id
    buf.extend_from_slice(&rect.left.to_le_bytes());   // 2B left
    buf.extend_from_slice(&rect.top.to_le_bytes());    // 2B top
    buf.extend_from_slice(&rect.right.to_le_bytes());  // 2B right
    buf.extend_from_slice(&rect.bottom.to_le_bytes()); // 2B bottom
    buf.push(0x01u8); // codec marker (1=avc420)
    buf.extend_from_slice(&(nal_data.len() as u32).to_le_bytes()); // 4B data_len
    buf.extend_from_slice(nal_data);

    let _ = self.frame_tx.send(buf);
}
```

**Step 4: 编译验证**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: 编译通过

**Step 5: Commit**

```bash
git add src-tauri/src/gfx_handler.rs
git commit -m "feat(gfx): extract H.264 NAL from AVC420 and forward to frontend"
```

---

### Task 3: 发送 GFX 控制消息（Surface 生命周期）

**Files:**
- Modify: `src-tauri/src/gfx_handler.rs:219-240`

前端的 H.264 VideoDecoder 需要知道 surface 尺寸来正确渲染。
当前 CreateSurface/ResetGraphics 只在 Rust 内部处理，没有转发到前端。

**Step 1: 在 CreateSurface PDU 处理中添加 GFX 消息**

在现有的 `eprintln!` 和 `self.surfaces.insert(...)` 之后添加：

```rust
GfxPdu::CreateSurface(cs) => {
    eprintln!("[gfx] CreateSurface {}: {}x{}", cs.surface_id, cs.width, cs.height);
    self.surfaces.insert(cs.surface_id, Surface::new(cs.width, cs.height));
    // Forward to frontend for H.264 surface sizing
    let mut msg = vec![0x02u8]; // MSG_CREATE_SURFACE
    msg.extend_from_slice(&cs.surface_id.to_le_bytes());
    msg.extend_from_slice(&cs.width.to_le_bytes());
    msg.extend_from_slice(&cs.height.to_le_bytes());
    let _ = self.frame_tx.send(msg);
}
```

**Step 2: 在 DeleteSurface 中添加 GFX 消息**

```rust
GfxPdu::DeleteSurface(ds) => {
    eprintln!("[gfx] DeleteSurface {}", ds.surface_id);
    self.surfaces.remove(&ds.surface_id);
    let mut msg = vec![0x03u8]; // MSG_DELETE_SURFACE
    msg.extend_from_slice(&ds.surface_id.to_le_bytes());
    let _ = self.frame_tx.send(msg);
}
```

**Step 3: 在 MapSurfaceToOutput 中添加 GFX 消息**

```rust
GfxPdu::MapSurfaceToOutput(map) => {
    eprintln!("[gfx] MapSurface {} → ({},{})", map.surface_id, map.output_origin_x, map.output_origin_y);
    if let Some(s) = self.surfaces.get_mut(&map.surface_id) {
        s.output_x = map.output_origin_x;
        s.output_y = map.output_origin_y;
    }
    let mut msg = vec![0x04u8]; // MSG_MAP_SURFACE
    msg.extend_from_slice(&map.surface_id.to_le_bytes());
    msg.extend_from_slice(&map.output_origin_x.to_le_bytes());
    msg.extend_from_slice(&map.output_origin_y.to_le_bytes());
    let _ = self.frame_tx.send(msg);
}
```

**Step 4: 在 ResetGraphics 中添加 GFX 消息**

```rust
GfxPdu::ResetGraphics(rg) => {
    eprintln!("[gfx] ResetGraphics: {}x{}", rg.width, rg.height);
    self.desktop_width = rg.width as u16;
    self.desktop_height = rg.height as u16;
    self.surfaces.clear();
    self.cache.clear();
    let mut msg = vec![0x05u8]; // MSG_RESET_GRAPHICS
    msg.extend_from_slice(&rg.width.to_le_bytes());
    msg.extend_from_slice(&rg.height.to_le_bytes());
    let _ = self.frame_tx.send(msg);
}
```

**Step 5: 编译验证**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: 编译通过

**Step 6: Commit**

```bash
git add src-tauri/src/gfx_handler.rs
git commit -m "feat(gfx): forward surface lifecycle messages to frontend for H.264"
```

---

### Task 4: 验证前端 H.264 接收管线

**Files:**
- Review: `frontend/src/hooks/useNativeRdp.ts:213-255`

**Step 1: 确认前端消息格式匹配**

验证前端 `handleGfxMessage` 中的 `MSG_H264_FRAME` 解析格式：
```typescript
// 前端期望: [1B type][2B sid][2B left][2B top][2B right][2B bottom][1B codec][4B len][N data]
// Rust 发送: [1B type][2B sid][2B left][2B top][2B right][2B bottom][1B codec][4B len][N data]
// 偏移量: type=0, sid=1, left=3, top=5, right=7, bottom=9, codec=11, len=12, data=16
```

前端代码（行 231-255）：
```typescript
case MSG_H264_FRAME: {
    const dataLen = dv.getUint32(12, true);         // offset 12
    const nalData = new Uint8Array(raw, 16, dataLen); // offset 16
    ...
}
```

确认 Rust 端 `send_h264_frame` 构建的 buffer 偏移量：
- byte 0: type (0x01)
- byte 1-2: surface_id (u16 LE)
- byte 3-4: left (u16 LE)
- byte 5-6: top (u16 LE)
- byte 7-8: right (u16 LE)
- byte 9-10: bottom (u16 LE)
- byte 11: codec marker
- byte 12-15: data_len (u32 LE)
- byte 16+: NAL data

✅ 格式完全匹配，无需修改前端。

**Step 2: 检查 VideoDecoder 配置**

前端使用 `avc1.42001f` (Baseline Level 3.1)。这对大多数 RDP 服务器的 AVC420 输出是兼容的。如果遇到高分辨率问题，可能需要改为 `avc1.64001f` (High profile)。

此步骤不需要代码更改，仅确认。

---

### Task 5: 集成测试

**Step 1: 构建并运行**

Run: `cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk && npx tauri dev`

**Step 2: 连接 RDP 服务器并观察日志**

Expected 日志：
```
[gfx] CapabilitiesConfirm: V8_1 { flags: CapabilitiesV81Flags(AVC420_ENABLED) }
[gfx] CreateSurface 0: 1268x554
[gfx] ResetGraphics: 1268x554
[gfx] W2S1 #0 codec=Avc420 fmt=XRgb dest=(0,0)+(1268x554) XXXB
```

**Step 3: 确认前端 H.264 渲染**

打开浏览器 DevTools Console，Expected：
```
[gfx] ⚡ Switched to H.264 GFX mode
[gfx] VideoDecoder initialized (HW accel)
```

**Step 4: 视觉验证**

画面应完整显示远程桌面，无绿屏/花屏/黑屏。

---

### Task 6: 清理与健壮性（Optional）

**Step 1: 如果 V8.1 CapabilitiesConfirm 返回 V8 而非 V8.1**

这意味着服务器不支持 AVC420。需要添加 fallback：
```rust
fn capabilities(&self) -> Vec<CapabilitySet> {
    vec![
        CapabilitySet::V8_1 {
            flags: CapabilitiesV81Flags::AVC420_ENABLED,
        },
        CapabilitySet::V8 {
            flags: CapabilitiesV8Flags::empty(),
        },
    ]
}
```

**Step 2: 移除 unused import warning**

如果 `CapabilitiesV8Flags` 不再单独使用，检查是否需要保留。

**Step 3: Commit**

```bash
git add -A
git commit -m "feat(gfx): complete H.264 NAL forwarding pipeline with V8.1 caps"
```
