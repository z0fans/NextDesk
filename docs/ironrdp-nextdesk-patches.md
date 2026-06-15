# NextDesk IronRDP Patch Inventory

## Purpose

NextDesk depends on a local modified IronRDP checkout at `../../IronRDP`. This inventory makes the fork boundary explicit before the RDP kernel is called stable.

## Required Directory Layout

```text
<parent>/
  IronRDP/
  NextDesk/
```

## Patch Inventory

| Crate | Files | Reason | Stability Risk | Verification |
| --- | --- | --- | --- | --- |
| ironrdp-cliprdr | `crates/ironrdp-cliprdr/src/pdu/format_data/file_list.rs` | File list PDU parsing used by CLIPRDR file copy | Clipboard file regressions | Copy file remote to local and local to remote |
| ironrdp-connector | `crates/ironrdp-connector/src/connection.rs`, `crates/ironrdp-connector/src/connection_activation.rs` | NextDesk connection handshake behavior | Authentication or activation failures | Connect to NLA-enabled Windows host 10 times |
| ironrdp-dvc | `crates/ironrdp-dvc/src/client.rs` | Dynamic virtual channel support used by DisplayControl/GFX/audio | Resize or DVC channel failures | Resize and DVC logs |
| ironrdp-rdpsnd-native | `crates/ironrdp-rdpsnd-native/src/cpal.rs` | macOS native audio backend | Audio crackle or device failure | Enable audio flag and play remote sound |
| ironrdp-rdpsnd | `crates/ironrdp-rdpsnd/src/client.rs` | RDPSND client integration | Audio negotiation failures | RDPSND format and wave logs |
| iron-remote-desktop | `crates/iron-remote-desktop/src/lib.rs`, `crates/iron-remote-desktop/src/session.rs` | WASM high level session API | API mismatch with frontend | `frontend/src/wasm/ironrdp_web.d.ts` matches usage |
| ironrdp-pdu | `crates/ironrdp-pdu/src/codecs/clearcodec/*`, `crates/ironrdp-pdu/src/codecs/mod.rs` | Official upstream ClearCodec PDU parser port, with captured Windows compatibility fixes for RLEX segment headers and `SHORT_VBAR_CACHE_MISS` bitfields | ClearCodec decode failures, black canvas under forced GFX | `cargo test -p ironrdp-pdu clearcodec`; forced GFX runtime log has ClearCodec frames and no decode fallback |
| ironrdp-graphics | `crates/ironrdp-graphics/src/clearcodec/*`, `crates/ironrdp-graphics/src/lib.rs` | Official upstream ClearCodec graphics decoder/cache port | Wrong pixels or missing glyph/VBar cache reuse | `cargo test -p ironrdp-graphics clearcodec`; forced GFX visual gate currently fails until web surface compositing is complete |
| ironrdp-egfx | `crates/ironrdp-egfx/src/client.rs`, `crates/ironrdp-egfx/src/pdu/avc.rs` | WASM-facing GFX helpers for AVC420 payload extraction and stateful ClearCodec RGBA patch decoding | GFX/H.264 negotiation regressions or ClearCodec fallback loops | `cargo test -p ironrdp-egfx avc420`; forced GFX log currently selects ClearCodec on tested targets, with `h264_frame=0` |
| ironrdp-web | `crates/ironrdp-web/src/canvas.rs`, `clipboard.rs`, `gfx.rs`, `image.rs`, `lib.rs`, `rdpdr.rs`, `rdpsnd.rs`, `rdpsnd_dvc.rs`, `session.rs` | Main IronRDP Web runtime used by NextDesk, including callbacks for DisplayControl, CLIPRDR, RDPDR, RDPSND, AVC420 diagnostics, and ClearCodec RGBA patches | Highest RDP rendering and extension risk | Stable profile matrix plus forced GFX compositor gate; H.264 visual rendering requires a target that negotiates AVC420 |

## Official ClearCodec Alignment Notes

The ClearCodec implementation is intentionally aligned with upstream IronRDP instead of keeping a NextDesk-only temporary decoder:

- Upstream source: Devolutions IronRDP official ClearCodec modules under `ironrdp-pdu/src/codecs/clearcodec` and `ironrdp-graphics/src/clearcodec`.
- Local compatibility fixes are limited to payload shapes captured from Windows RDPGFX sessions.
- `ironrdp-egfx` owns the WASM-facing adapter only: it preserves decoder state, converts BGRA to RGBA, and exposes patch metadata to `ironrdp-web`.
- `ironrdp-web` owns JavaScript event emission only; it does not duplicate ClearCodec protocol parsing.

## Rules

- Do not replace `../../IronRDP` with upstream master during this migration.
- Do not add new patches without updating this file.
- Every patch must have a manual verification case.
- Upstream sync must happen after the IronRDP-first baseline is stable.
