# Official Web AVC420 Negotiation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the official-web GFX experiment advertise AVC420 capability correctly and pass only decoded AVC420 H.264 payload bytes to WebCodecs.

**Architecture:** Keep the existing bitmap fallback as the safety net. Advertise only RDPGFX V8.1 AVC420 support first, not AVC444/V10.x, because the current WebCodecs overlay handles one H.264 stream and does not yet implement AVC444 dual-stream composition. Decode the RDPGFX AVC420 wrapper in Rust and forward its `data` field to JS.

**Tech Stack:** IronRDP `ironrdp-egfx`, IronRDP WASM `ironrdp-web`, React/TypeScript WebCodecs worker, Vitest, wasm-pack.

---

### Task 1: Add Client AVC420 Helpers

**Files:**
- Modify: `../IronRDP/crates/ironrdp-egfx/src/client.rs`

- [x] **Step 1: Write failing tests**

Add tests at the bottom of `client.rs`:

```rust
#[cfg(test)]
mod tests {
    use ironrdp_core::Encode as _;
    use ironrdp_pdu::geometry::InclusiveRectangle;

    use super::*;
    use crate::pdu::{Avc420BitmapStream, QuantQuality};

    #[test]
    fn avc420_capabilities_advertise_v81_before_v8() {
        let caps = avc420_capabilities();

        assert!(matches!(
            caps.as_slice(),
            [
                CapabilitySet::V8_1 { flags: v81 },
                CapabilitySet::V8 { flags: v8 },
            ] if v81.contains(CapabilitiesV81Flags::AVC420_ENABLED)
                && v81.contains(CapabilitiesV81Flags::SMALL_CACHE)
                && v8.contains(CapabilitiesV8Flags::SMALL_CACHE)
        ));
    }

    #[test]
    fn extract_avc420_frame_returns_inner_h264_payload() {
        let h264 = [0, 0, 0, 1, 0x67, 0x42, 0, 0x1f];
        let stream = Avc420BitmapStream {
            rectangles: vec![InclusiveRectangle {
                left: 10,
                top: 20,
                right: 110,
                bottom: 120,
            }],
            quant_qual_vals: vec![QuantQuality {
                quantization_parameter: 22,
                progressive: false,
                quality: 100,
            }],
            data: &h264,
        };

        let mut encoded = vec![0; stream.size()];
        let mut cursor = ironrdp_core::WriteCursor::new(&mut encoded);
        stream.encode(&mut cursor).expect("encode avc420 test stream");

        let frame = extract_avc420_frame(&encoded).expect("decode avc420 frame");

        assert_eq!(frame.data, h264);
        assert_eq!(frame.rectangles.len(), 1);
        assert_eq!(frame.rectangles[0].left, 10);
    }
}
```

- [x] **Step 2: Verify red**

Run:

```bash
cd ../IronRDP
cargo test -p ironrdp-egfx client::tests::
```

Expected: fails because `avc420_capabilities` and `extract_avc420_frame` do not exist.

- [x] **Step 3: Implement helpers**

Add imports:

```rust
use ironrdp_pdu::geometry::InclusiveRectangle;
use ironrdp_pdu::{DecodeResult, decode};

use crate::pdu::{Avc420BitmapStream, CapabilitiesV81Flags};
```

Add helper types/functions near `GraphicsPipelineHandler`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Avc420Frame<'a> {
    pub rectangles: Vec<InclusiveRectangle>,
    pub data: &'a [u8],
}

pub fn avc420_capabilities() -> Vec<CapabilitySet> {
    vec![
        CapabilitySet::V8_1 {
            flags: CapabilitiesV81Flags::AVC420_ENABLED | CapabilitiesV81Flags::SMALL_CACHE,
        },
        CapabilitySet::V8 {
            flags: CapabilitiesV8Flags::SMALL_CACHE,
        },
    ]
}

pub fn extract_avc420_frame(bitmap_data: &[u8]) -> DecodeResult<Avc420Frame<'_>> {
    let stream: Avc420BitmapStream<'_> = decode(bitmap_data)?;
    Ok(Avc420Frame {
        rectangles: stream.rectangles,
        data: stream.data,
    })
}
```

- [x] **Step 4: Verify green**

Run the same `cargo test -p ironrdp-egfx client::tests::` command.

Verified:

```text
cargo test -p ironrdp-egfx client::tests::
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 7 filtered out
```

### Task 2: Use AVC420 Capability and Payload Extraction in WASM GFX

**Files:**
- Modify: `../IronRDP/crates/ironrdp-web/src/gfx.rs`

- [x] **Step 1: Override WASM GFX capabilities**

Import helpers:

```rust
use ironrdp_egfx::client::{GraphicsPipelineHandler, avc420_capabilities, extract_avc420_frame};
use ironrdp_egfx::pdu::{CapabilitySet, Codec1Type, GfxPdu};
```

Add this method in `impl GraphicsPipelineHandler for WasmGfxHandler` before `handle_pdu`:

```rust
fn capabilities(&self) -> Vec<CapabilitySet> {
    avc420_capabilities()
}
```

- [x] **Step 2: Forward AVC420 inner payload only**

Change `WireToSurface1` handling so only `Codec1Type::Avc420` is treated as WebCodecs-ready H.264:

```rust
let is_avc420 = matches!(w2s.codec_id, Codec1Type::Avc420);
```

For `Avc420`, call `extract_avc420_frame(&w2s.bitmap_data)`. Send `frame.data` as the JS `data` field and prefer the first `frame.rectangles` value for `left/top/right/bottom` when present. For `Avc444` and `Avc444v2`, emit `unsupported_codec` until a separate AVC444 compositor exists.

- [x] **Step 3: Preserve fallback diagnostics**

Keep `gfx_codec` for every `WireToSurface1`. Keep `unsupported_codec` for ClearCodec, AVC444, AVC444v2, and decode failures.

Verified:

```text
export PATH="$HOME/.cargo/bin:$PATH"; cargo check -p ironrdp-web --target wasm32-unknown-unknown
Finished `dev` profile ... target(s)
```

Note: the command still reports pre-existing warnings in `clipboard.rs`, `session.rs`, `rdpsnd*.rs`, and `image.rs`; `gfx.rs` has no remaining warning from this task.

### Task 3: Preserve H.264 Rect Metadata Through Worker

**Files:**
- Modify: `frontend/src/lib/decode-worker.ts`

- [x] **Step 1: Queue rect metadata**

Add:

```ts
type PendingRect = { left: number; top: number; right: number; bottom: number } | undefined;
const pendingRects: PendingRect[] = [];
```

In `output`, shift the rect and include it:

```ts
const rect = pendingRects.shift();
self.postMessage({ type: 'frame', frame, rect }, [frame] as any);
```

Before `decoder!.decode(chunk)`, push `msg.rect`; if `decode()` throws, pop it back.

- [x] **Step 2: Verify TypeScript build**

Run:

```bash
cd frontend && npm run build
```

Expected: build passes.

Verified:

```text
npm run build
✓ built in 2.61s
```

### Task 4: Rebuild and Runtime Validate

**Files:**
- Generated: `frontend/src/wasm/*`
- Runtime log: `/tmp/nextdesk_rdp_debug.log`

- [x] **Step 1: Format and test Rust**

```bash
cd ../IronRDP
cargo fmt --package ironrdp-egfx --package ironrdp-web -- --check
cargo test -p ironrdp-egfx client::tests::
```

Verified:

```text
cargo fmt --package ironrdp-egfx --package ironrdp-web -- --check
exit 0

cargo test -p ironrdp-egfx client::tests::
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 7 filtered out
```

- [x] **Step 2: Rebuild WASM**

```bash
cd ../IronRDP
wasm-pack build --target web crates/ironrdp-web
cp -r crates/ironrdp-web/pkg/* ../NextDesk/frontend/src/wasm/
```

Verified:

```text
wasm-pack build --target web crates/ironrdp-web
Your wasm pkg is ready to publish at crates/ironrdp-web/pkg.
```

- [x] **Step 3: Verify frontend**

```bash
cd frontend
npm test -- src/test/rdp-gfx-fallback.test.ts src/test/rdp-engine-flags.test.ts
npm run build
```

Verified:

```text
npm test -- src/test/rdp-gfx-fallback.test.ts src/test/rdp-engine-flags.test.ts
Test Files 2 passed (2); Tests 13 passed (13)

npm run build
✓ built in 2.23s
```

- [x] **Step 4: Manual validation**

Start:

```bash
VITE_NEXTDESK_OFFICIAL_WEB_GFX=1 VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=1 npx tauri dev
```

Reconnect. Acceptable outcomes:

```text
official-web GFX codec {"codec":"h264","h264":true,...}
official-web H.264 frame ...
```

or:

```text
official-web GFX codec {"codec":"clearcodec","h264":false,...}
official-web GFX fallback: reconnecting without GFX
```

The first means AVC420 is active. The second means the server still declines AVC420 and fallback remains safe.

Verified:

```text
officialWebFeatures {"gfx":true,"gfxRequested":true,"gfxForce":true,"gfxDisabledByFallback":false}
official-web GFX codec {"codec":"clearcodec","h264":false,...}
official-web GFX fallback: reconnecting without GFX {"reason":"unsupported_codec:clearcodec"}
official-web GFX disabled by fallback for this tab
Official canvas graphics update graphics_update_count=600 ...
```

Outcome: both tested Windows targets selected ClearCodec instead of AVC420/H.264. The fallback path remained stable and produced visible bitmap updates.

Follow-up validation on 2026-06-15:

```text
Runtime:
VITE_NEXTDESK_RDP_ENGINE=official-web
VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP=0
VITE_NEXTDESK_OFFICIAL_WEB_GFX=1
VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=1
VITE_NEXTDESK_OFFICIAL_WEB_AUDIO=0
VITE_NEXTDESK_OFFICIAL_WEB_FILE_TRANSFER=0
VITE_NEXTDESK_OFFICIAL_WEB_DISPLAY_CONTROL=1
npx tauri dev

Targets: 192.168.3.105:3389 and 64.20.10.254:3389
Runtime window: 2026-06-15T06:45:* and later
```

Parsed `/tmp/nextdesk_rdp_debug.log` returned:

```text
connect_request=2
connected=2
gfx_channel=2
h264_pipeline_enabled=2
h264_frame=0
h264_true_codec=0
clearcodec_codec_lines=158
clearcodec_frame_lines=158
clearcodec_rgba_patch_lines=8
error_or_fallback_lines=0
```

Current outcome: the AVC420/H.264 code path and WebCodecs pipeline initialize, but neither tested target negotiated AVC420/H.264 in this live run. Both selected ClearCodec, and the current ClearCodec path emits RGBA patches instead of taking the older fallback path. H.264 visual rendering therefore remains unvalidated until a target actually selects AVC420 or server-side policy is adjusted to prefer AVC420.
