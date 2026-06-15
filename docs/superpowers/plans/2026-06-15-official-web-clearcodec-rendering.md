# Official Web ClearCodec Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the official-web forced GFX path from blind ClearCodec fallback toward a spec-backed ClearCodec rendering path. The first safe slice must parse ClearCodec bitmap data, expose actionable runtime diagnostics, and keep the existing bitmap fallback as the safety net when the server sends ClearCodec layers that are not decoded yet.

**Architecture:** IronRDP currently recognizes `Codec1Type::ClearCodec` but does not provide a ClearCodec client decoder in the local checkout. Add typed ClearCodec protocol parsing in `ironrdp-egfx`, then wire `ironrdp-web` to emit a structured `clearcodec_frame` event with parsed flags, dimensions, sequence number, destination rectangle, and a bounded hex prefix. Frontend fallback remains enabled until the parsed payload can be rendered correctly. Only implement pixel painting after the payload layer is identified from real server data.

**Tech Stack:** IronRDP `ironrdp-egfx`, IronRDP WASM `ironrdp-web`, React/TypeScript, Vitest, wasm-pack.

**References:**
- Microsoft MS-RDPEGFX ClearCodec Bitmap Data: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/23253264-20f7-4a85-b6b4-023ca955cb3f
- Microsoft MS-RDPEGFX ClearCodec Bitmap Stream: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/6fa49bae-192f-4e25-888a-7cacfae303cf
- Microsoft MS-RDPEGFX ClearCodec Compressed Bitmap Data: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/f6c8a114-eaba-489f-9626-f41ad27a19b1

---

### Task 1: Add ClearCodec Bitmap Parser

**Files:**
- Add: `../IronRDP/crates/ironrdp-egfx/src/pdu/clearcodec.rs`
- Modify: `../IronRDP/crates/ironrdp-egfx/src/pdu/mod.rs`

- [x] **Step 1: Write failing tests**

Cover:
- `CLEARCODEC_BITMAP_DATA` width/height decoding
- `CLEARCODEC_BITMAP_STREAM` `ccFlags` and `seqNumber`
- bounded payload passthrough
- invalid short input rejection

- [x] **Step 2: Verify red**

Run:

```bash
cd ../IronRDP
cargo test -p ironrdp-egfx clearcodec
```

Expected: fails because the ClearCodec parser does not exist.

- [x] **Step 3: Implement parser**

Add:
- `ClearCodecFlags`
- `ClearCodecBitmapStream<'a>`
- `ClearCodecBitmapData<'a>`

Keep this parser intentionally protocol-level only. It must not guess the meaning of residual, banding, or subcodec payload bytes.

- [x] **Step 4: Verify green**

Run the same `cargo test -p ironrdp-egfx clearcodec` command.

Verified with:

```text
cargo test -p ironrdp-egfx
test result: ok. 12 passed; 0 failed
```

### Task 2: Add Client ClearCodec Extraction Helper

**Files:**
- Modify: `../IronRDP/crates/ironrdp-egfx/src/client.rs`

- [x] **Step 1: Write failing tests**

Cover:
- extracting ClearCodec metadata from a bitmap stream
- preserving destination rectangle separately from bitmap dimensions

- [x] **Step 2: Implement helper**

Add `extract_clearcodec_frame(bitmap_data: &[u8]) -> DecodeResult<ClearCodecFrame<'_>>` and a `ClearCodecFrame<'a>` struct containing dimensions, flags, sequence number, payload, and decoded layer booleans.

- [x] **Step 3: Verify green**

Run:

```bash
cd ../IronRDP
cargo test -p ironrdp-egfx client::tests::
```

Verified with:

```text
cargo test -p ironrdp-egfx
test result: ok. 12 passed; 0 failed
```

### Task 3: Wire WASM GFX ClearCodec Diagnostics

**Files:**
- Modify: `../IronRDP/crates/ironrdp-web/src/gfx.rs`

- [x] **Step 1: Parse ClearCodec in `WireToSurface1`**

For `Codec1Type::ClearCodec`, call `extract_clearcodec_frame`.

- [x] **Step 2: Emit structured JS event**

Emit `clearcodec_frame` with:
- `surfaceId`
- `width`, `height`
- `flags`, `residual`, `banding`, `subcodec`
- `sequenceNumber`
- `payloadLen`
- `hexPrefix`
- destination rectangle

- [x] **Step 3: Preserve fallback**

Until pixel decoding exists, still emit `unsupported_codec` after `clearcodec_frame`. The fallback reason must stay `unsupported_codec:clearcodec` so forced GFX can reconnect without black screen.

- [x] **Step 4: Verify WASM check**

Run:

```bash
cd ../IronRDP
cargo check -p ironrdp-web --target wasm32-unknown-unknown
```

Verified:

```text
cargo check -p ironrdp-web --target wasm32-unknown-unknown
Finished `dev` profile ... target(s)
```

Note: command still reports pre-existing warnings in `ironrdp-web`; this task did not add new blocking errors.

### Task 4: Surface ClearCodec Evidence in Frontend Logs

**Files:**
- Modify: `frontend/src/components/RdpManager.tsx`

- [x] **Step 1: Handle `clearcodec_frame` callback**

Log the structured ClearCodec data to `/tmp/nextdesk_rdp_debug.log` through the existing RDP debug logger.

- [x] **Step 2: Keep fallback behavior unchanged**

Do not disable the current official-web GFX fallback. This keeps user-facing sessions recoverable while gathering decoder evidence.

- [x] **Step 3: Verify frontend tests/build**

Run:

```bash
cd frontend
npm run test -- rdp-gfx-fallback
npm run build
```

Verified:

```text
npm run test -- rdp-gfx-fallback
Test Files 1 passed; Tests 4 passed

npm run build
✓ built
```

### Task 5: Rebuild WASM and Runtime Capture

**Files:**
- Modify generated WASM files only after Rust checks pass:
  - `frontend/src/wasm/ironrdp_web.js`
  - `frontend/src/wasm/ironrdp_web.d.ts`
  - `frontend/src/wasm/ironrdp_web_bg.js`
  - `frontend/src/wasm/ironrdp_web_bg.wasm`
  - `frontend/src/wasm/ironrdp_web_bg.wasm.d.ts`

- [x] **Step 1: Rebuild WASM**

Run:

```bash
cd ../IronRDP
wasm-pack build --target web crates/ironrdp-web
cp -r crates/ironrdp-web/pkg/* ../NextDesk/frontend/src/wasm/
```

- [x] **Step 2: Restart forced GFX dev server**

Run:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk
VITE_NEXTDESK_OFFICIAL_WEB_GFX=1 VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=1 npx tauri dev
```

- [x] **Step 3: Ask for reconnect and inspect logs**

After reconnect, inspect `/tmp/nextdesk_rdp_debug.log` for:
- `official-web ClearCodec frame`
- parsed flags and sequence number
- bounded `hexPrefix`
- fallback still occurring if pixel decoding is not yet implemented

Verified runtime capture showed:

```text
official-web ClearCodec frame
flags: 0
sequenceNumber: 0/1/2
payloadLen: 33
bitmapHexPrefix: 0000000000000000000015000000000000002800400008000000020100000000ffff09
```

Important correction: `WireToSurface1.bitmap_data` is `CLEARCODEC_BITMAP_STREAM`, not `CLEARCODEC_BITMAP_DATA`.

### Task 6: Decide Pixel Decoder Slice From Real Payload

**Files:**
- Modify: `../IronRDP/crates/ironrdp-egfx/src/pdu/clearcodec.rs`
- Modify: `../IronRDP/crates/ironrdp-egfx/src/client.rs`
- Modify: `../IronRDP/crates/ironrdp-web/src/gfx.rs`
- Modify: `frontend/src/lib/h264-overlay.ts`
- Modify: `frontend/src/components/RdpManager.tsx`
- Modify: `frontend/src/test/rdp-gfx-fallback.test.ts`

- [x] **Step 1: Classify real ClearCodec layer usage**

Use captured `flags`, payload length, and hex prefix to decide whether the server is using residual, banding, subcodec, or a combination.

Result:
- `ccFlags = 0`: no glyph index, no glyph hit, no cache reset.
- Composite payload: `residualByteCount = 0`, `bandsByteCount = 0`, `subcodecByteCount = 21`.
- Subcodec payload: `subCodecId = 0x02` (RLEX), region `40x64`, `64x27`, or `40x27`.
- Captured RLEX bitmap data is a single-palette extended run that fills the whole patch.

- [x] **Step 2: Implement only the verified layer**

Add pixel decoding only for the verified stream shape. If the real server uses RLEX/banding/subcodec, fetch the exact matching MS-RDPEGFX pages and add targeted tests before implementation.

Implemented:
- Official ClearCodec flag names: `GLYPH_INDEX`, `GLYPH_HIT`, `CACHE_RESET`.
- `ClearCodecCompositePayload` parser.
- `ClearCodecSubcodec` parser.
- Narrow `decode_clearcodec_rlex_solid_rgba` decoder for the captured one-color RLEX run shape.
- `clearcodec_rgba_patch` JS event emitted from `ironrdp-web`.
- Frontend overlay draws the decoded RGBA patch without triggering forced-GFX fallback.

- [x] **Step 3: Replace fallback with draw path only when verified**

Remove the ClearCodec `unsupported_codec` branch only after a real session paints correctly and no black screen occurs.

Implemented with safety boundary:
- ClearCodec no longer emits `unsupported_codec` when the verified RLEX solid-patch path decodes successfully.
- Unsupported glyph-cache fields, residual layer, bands layer, or non-RLEX subcodec still produce a decode error and preserve the existing fallback safety path.

Verified:

```text
PATH="$HOME/.cargo/bin:$PATH" cargo test -p ironrdp-egfx
test result: ok. 16 passed; 0 failed

PATH="$HOME/.cargo/bin:$PATH" cargo check -p ironrdp-web --target wasm32-unknown-unknown
Finished `dev` profile ... target(s)

npm run test -- rdp-gfx-fallback
Test Files 1 passed; Tests 5 passed

npm run build
✓ built

PATH="$HOME/.cargo/bin:$PATH" wasm-pack build --target web crates/ironrdp-web
Done; pkg copied to frontend/src/wasm/
```

### Task 7: Runtime Validate ClearCodec Patch Rendering

**Files:** runtime-only unless logs reveal a new payload shape.

- [x] **Step 1: Restart forced GFX dev server with rebuilt WASM**

Run:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk
VITE_NEXTDESK_OFFICIAL_WEB_GFX=1 VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=1 npx tauri dev
```

- [x] **Step 2: Ask user to reconnect and inspect logs**

Confirm:
- `official-web ClearCodec frame`
- `official-web ClearCodec RGBA patch`
- no `official-web GFX fallback: reconnecting without GFX` after successful ClearCodec patch decode
- no black screen

- [x] **Step 3: Decide next decoder slice**

If logs show new ClearCodec shapes, add tests first and implement the next smallest official path. Candidate gaps:
- glyph cache fields
- residual layer
- bands layer
- broader RLEX run segments beyond the single-color captured case

Verified after Task 8 official decoder port:

```text
Forced GFX dev server restarted with rebuilt WASM:
VITE_NEXTDESK_OFFICIAL_WEB_GFX=1 VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=1 npx tauri dev

Runtime log window:
2026-06-15T03:01:*

ClearCodec frames:
rg -c "2026-06-15T03:01:.*official-web ClearCodec frame" /tmp/nextdesk_rdp_debug.log
161

ClearCodec RGBA patch logs:
rg -c "2026-06-15T03:01:.*official-web ClearCodec RGBA patch" /tmp/nextdesk_rdp_debug.log
7

Fallback/error check:
rg -n "2026-06-15T03:01:.*(official-web GFX fallback|decode error|official-web GFX disabled|unsupported_codec|clearcodec decode error)" /tmp/nextdesk_rdp_debug.log
<no matches>
```

Decision:
- The official ClearCodec decoder path is no longer blocked by the captured residual/bands/subcodec payloads.
- No additional ClearCodec slice is required for the current validation target.
- Continue IronRDP alignment with the next protocol/runtime gap instead of adding another temporary decoder.

### Task 8: Replace Temporary ClearCodec Slice With Official IronRDP Decoder

**Files:**
- Add: `../IronRDP/crates/ironrdp-pdu/src/codecs/clearcodec/*`
- Add: `../IronRDP/crates/ironrdp-graphics/src/clearcodec/*`
- Modify: `../IronRDP/crates/ironrdp-pdu/src/codecs/mod.rs`
- Modify: `../IronRDP/crates/ironrdp-graphics/src/lib.rs`
- Modify: `../IronRDP/crates/ironrdp-egfx/src/client.rs`
- Modify: `../IronRDP/crates/ironrdp-egfx/src/pdu/mod.rs`
- Delete: `../IronRDP/crates/ironrdp-egfx/src/pdu/clearcodec.rs`
- Modify: `../IronRDP/crates/ironrdp-web/src/gfx.rs`

- [x] **Step 1: Port official ClearCodec protocol module**

Added the upstream-shaped `ironrdp_pdu::codecs::clearcodec` module with:
- `ClearCodecBitmapStream`
- `CompositePayload`
- residual layer parser/encoder
- bands/VBar parser
- subcodec parser
- RLEX parser

Compatibility note:
- The captured single-palette RLEX stream includes a segment header byte before the run length. The port keeps the official structure but fixes that parser edge so the real Windows payload decodes.
- Runtime validation also exposed a `SHORT_VBAR_CACHE_MISS` bitfield mismatch on bands payloads. The parser now follows MS-RDPEGFX field order: `shortVBarYOn(8) + shortVBarYOff(6) + x(2)`.

- [x] **Step 2: Port official ClearCodec graphics decoder/cache**

Added `ironrdp_graphics::clearcodec` with:
- `ClearCodecDecoder`
- `ClearCodecEncoder`
- `GlyphCache`
- `VBarCache`

The decoder keeps persistent glyph/VBar state across frames and outputs BGRA pixels.

- [x] **Step 3: Replace temporary egfx decoder path**

Changed `ironrdp-egfx` to expose `ClearCodecFrameDecoder`, backed by `ironrdp_graphics::clearcodec::ClearCodecDecoder`.

Removed the temporary `ironrdp-egfx/src/pdu/clearcodec.rs` module so the official `ironrdp-pdu` codec module is now the only ClearCodec protocol source.

- [x] **Step 4: Wire official decoder into WASM GFX**

`WasmGfxHandler` now owns one `ClearCodecFrameDecoder` for the session and emits the existing `clearcodec_rgba_patch` event after converting BGRA to RGBA.

- [x] **Step 5: Verify**

Verified with:

```text
PATH="$HOME/.cargo/bin:$PATH" cargo test -p ironrdp-pdu clearcodec
test result: ok. 18 passed; 0 failed

PATH="$HOME/.cargo/bin:$PATH" cargo test -p ironrdp-graphics clearcodec
test result: ok. 11 passed; 0 failed

PATH="$HOME/.cargo/bin:$PATH" cargo test -p ironrdp-egfx
test result: ok. 11 passed; 0 failed

PATH="$HOME/.cargo/bin:$PATH" cargo check -p ironrdp-web --target wasm32-unknown-unknown
Finished `dev` profile ... target(s)

npm run test -- rdp-gfx-fallback
Test Files 1 passed; Tests 5 passed

npm run build
✓ built

PATH="$HOME/.cargo/bin:$PATH" wasm-pack build --target web crates/ironrdp-web
Done; pkg copied to frontend/src/wasm/

npm run build
✓ built
```

Additional verification after the bands bitfield fix:

```text
PATH="$HOME/.cargo/bin:$PATH" cargo test -p ironrdp-pdu clearcodec
test result: ok. 18 passed; 0 failed

PATH="$HOME/.cargo/bin:$PATH" cargo test -p ironrdp-graphics clearcodec
test result: ok. 11 passed; 0 failed

PATH="$HOME/.cargo/bin:$PATH" cargo test -p ironrdp-egfx
test result: ok. 11 passed; 0 failed

PATH="$HOME/.cargo/bin:$PATH" cargo check -p ironrdp-web --target wasm32-unknown-unknown
Finished `dev` profile ... target(s)

PATH="$HOME/.cargo/bin:$PATH" wasm-pack build --target web crates/ironrdp-web
Done; pkg copied to frontend/src/wasm/

npm run test -- rdp-gfx-fallback
Test Files 1 passed; Tests 5 passed

npm run build
✓ built
```

Next runtime gate:
- Restart forced GFX dev server.
- Ask user to reconnect.
- Confirm logs show `official-web ClearCodec RGBA patch` without fallback.
