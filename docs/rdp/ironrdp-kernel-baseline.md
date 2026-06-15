# IronRDP Kernel Baseline

## Purpose

This document defines the smallest RDP runtime profile that must be stable before NextDesk extension features are enabled. It is the reference baseline for the IronRDP-first migration.

## Stable Profile

Use this profile when testing RDP instability:

```text
RDP engine: official-web
Native engine: disabled unless explicitly experimental
Official-web GFX: off
Official-web audio: off
Official-web file transfer websocket bypass: off
DisplayControl: on
Clash / Tube / Relay: unchanged
```

## Runtime Flags

```text
nextdesk_rdp_engine=official-web
VITE_NEXTDESK_RDP_ENGINE=official-web
nextdesk_experimental_native_rdp=0
VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP=0
nextdesk_official_web_gfx=0
VITE_NEXTDESK_OFFICIAL_WEB_GFX=0
nextdesk_official_web_gfx_force=0
VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=0
nextdesk_official_web_audio=0
VITE_NEXTDESK_OFFICIAL_WEB_AUDIO=0
nextdesk_official_web_file_transfer=0
VITE_NEXTDESK_OFFICIAL_WEB_FILE_TRANSFER=0
nextdesk_official_web_display_control=1
VITE_NEXTDESK_OFFICIAL_WEB_DISPLAY_CONTROL=1
```

## Manual Verification Matrix

Run against the same Windows RDP target before and after each migration task.

| Case | Expected Result | Evidence Required |
| --- | --- | --- |
| Connect 10 times | 10 successful desktop renders | attempt IDs, timestamps, target host, final status |
| 30 minute idle session | No disconnect, no black canvas | start time, end time, RDP status logs |
| Keyboard input | Letters and shortcuts reach remote host | tested keys and target application |
| Mouse input | Move, click, drag, wheel work | tested actions and target application |
| Adaptive resize | Remote desktop resizes or reconnect fallback is explicit | requested size, final canvas size, resize log |
| Text clipboard local to remote | Text pastes into remote Notepad | source text hash or short sample, paste target |
| Text clipboard remote to local | Remote copied text appears locally | source text hash or short sample, local paste target |
| Tab close | Session shuts down without reconnect loop | close timestamp and absence of reconnect log |

## Native Experimental Rule

Native RDP is not a production fallback. It can only be used when both are true:

1. `nextdesk_rdp_engine` or `VITE_NEXTDESK_RDP_ENGINE` is `native`
2. `nextdesk_experimental_native_rdp` or `VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP` is enabled

If either value is missing, NextDesk must use `official-web`.

## Official-Web GFX Stability Guard

`nextdesk_official_web_gfx` / `VITE_NEXTDESK_OFFICIAL_WEB_GFX` records a GFX request, but it must not register the GFX channel by itself. The forced GFX path now includes an upstream-aligned ClearCodec decoder and can render the validated Windows ClearCodec payloads. It remains outside the stable profile until the GFX profile has the same long-running evidence as the default bitmap canvas path.

Actual GFX registration requires the unsafe force flag:

```text
nextdesk_official_web_gfx_force=1
VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=1
```

Forced GFX is experimental and is not part of the stable profile until the ClearCodec/GFX runtime matrix is complete.

## Smoke Evidence

### 2026-06-14 official-web dev smoke

Runtime:

```text
Command: npx tauri dev
Binary: target/debug/nextdesk
Version displayed in UI: v1.0.117
Target: 64.20.10.254:3389
Profile: official-web stable profile
```

Observed evidence:

| Case | Result | Evidence |
| --- | --- | --- |
| official-web proxy path | PASS | `rdp_proxy` accepted a WebSocket client, decoded `dest=64.20.10.254:3389`, completed TLS handshake, and entered relay |
| native path disabled | PASS | Tauri dev output showed no `rdp_native_connect` path during the smoke run |
| desktop render | PASS | Windows desktop rendered in the RDP canvas through `target/debug/nextdesk` |
| keyboard input | PASS | `XYZ789` reached remote Notepad |
| text clipboard local to remote | PASS | macOS clipboard text `NDCLIP-2026-06-14` pasted into remote Notepad via Command+V |
| tab close | PASS | Closing the tab ended relay for `64.20.10.254:3389`; no new client appeared during the following 10 second observation window |

Not covered by this smoke:

```text
Connect 10 times
30 minute idle session
Mouse drag and wheel
Adaptive resize
Text clipboard remote to local
```

### 2026-06-15 Task 9 stable profile log smoke

Runtime:

```text
Command:
VITE_NEXTDESK_RDP_ENGINE=official-web
VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP=0
VITE_NEXTDESK_OFFICIAL_WEB_GFX=0
VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=0
VITE_NEXTDESK_OFFICIAL_WEB_AUDIO=0
VITE_NEXTDESK_OFFICIAL_WEB_FILE_TRANSFER=0
VITE_NEXTDESK_OFFICIAL_WEB_DISPLAY_CONTROL=1
npx tauri dev

Binary: target/debug/nextdesk
Targets: 192.168.3.105:3389 and 64.20.10.254:3389
Profile: official-web stable profile
Log: /tmp/nextdesk_rdp_debug.log
Runtime window: 2026-06-15T03:21:* through 2026-06-15T03:22:*
```

Observed evidence:

| Case | Result | Evidence |
| --- | --- | --- |
| official-web profile flags | PASS | `officialWebFeatures` recorded `audio:false`, `gfx:false`, `gfxRequested:false`, `gfxForce:false`, `fileTransfer:false`, `displayControl:true` |
| official-web connection | PASS | `official ironrdp web connected` appeared twice, once per target |
| official canvas render | PASS | `Official canvas graphics update` appeared 22 times in the sampled runtime window |
| native path disabled | PASS | No `rdp_native_connect`, `frame_ws`, or `native RDP` matches in the sampled runtime window |
| GFX disabled | PASS | No `GFX WireToSurface`, `unsupported_codec`, `official-web GFX fallback`, or `decode error` matches in the sampled runtime window |
| text clipboard local to remote | PASS | User confirmed bidirectional text clipboard; log recorded `paste-shortcut local text injected before remote paste`, `Remote has received format list successfully`, and local clipboard text `5555` in focus sync |
| text clipboard remote to local | PASS | User confirmed bidirectional text clipboard; log recorded `Remote → Local text: 123123213213123213213123123` |
| tab close | PASS | User closed the top RDP tab; log recorded `RDP session terminated disconnect_reason=user initiated disconnect` and `session.ended reason=user initiated disconnect`; no reconnect/connect request appeared after `2026-06-15T03:25:36` |

Still pending:

```text
None for the stable profile items covered in this section.
```

### 2026-06-15 stable profile 30 minute idle coverage

Runtime:

```text
Command:
VITE_NEXTDESK_RDP_ENGINE=official-web
VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP=0
VITE_NEXTDESK_OFFICIAL_WEB_GFX=0
VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=0
VITE_NEXTDESK_OFFICIAL_WEB_AUDIO=0
VITE_NEXTDESK_OFFICIAL_WEB_FILE_TRANSFER=0
VITE_NEXTDESK_OFFICIAL_WEB_DISPLAY_CONTROL=1
npx tauri dev

Binary: target/debug/nextdesk
Target: 64.20.10.254:3389
Profile: official-web stable profile
Log: /tmp/nextdesk_rdp_debug.log
Idle window: 2026-06-15T04:09:42.339Z through 2026-06-15T04:40:35Z
Duration: 1852 seconds
```

Observed evidence:

| Case | Result | Evidence |
| --- | --- | --- |
| no user input during idle window | PASS | parsed log count: `input=0` after the final `mouse UP` at `2026-06-15T04:09:42.338Z` |
| no disconnect/error | PASS | parsed log count: `bad=0` for `session.ended`, `RDP session terminated`, `error`, `failed`, `panic`, `crash`, and `exception` |
| no reconnect | PASS | parsed log count: `reconnect=0` for `connect.start` and `official ironrdp web connected` |
| canvas stayed active | PASS | parsed log count: `Official canvas graphics update=59` during the idle window |

Conclusion:

```text
Stable official-web profile passed the 30 minute idle coverage gate.
Forced GFX remains excluded from this stability result because the same session family produced ClearCodec compositor artifacts under the forced-GFX profile.
```

### 2026-06-14 Task 10 DisplayControl smoke

Runtime:

```text
Command: npx tauri dev
Binary: target/debug/nextdesk
Target: 64.20.10.254:3389
Profile: official-web stable profile
Task: Move DisplayControl extension into IronRDP Web Engine facade
```

Observed evidence:

| Case | Result | Evidence |
| --- | --- | --- |
| official-web proxy path | PASS | `rdp_proxy` accepted a WebSocket client, decoded `dest=64.20.10.254:3389`, completed TLS handshake, and entered relay |
| DisplayControl enabled | PASS | `/tmp/nextdesk_rdp_debug.log` recorded `officialWebFeatures.displayControl=true` and `DisplayControl DVC enabled for dynamic resolution` |
| desktop render | PASS | Windows desktop rendered in the RDP canvas through `target/debug/nextdesk` |
| adaptive resize | PASS | Window resize triggered `adaptive resize (observer, official-web) → dynamic PDU sent: 1036 x 651`; WASM logged resize event and `Official canvas resize applied after DeactivateAll width=1036 height=651` |
| process cleanup | PASS | `tauri dev` was stopped after verification; no `target/debug/nextdesk` process or `127.0.0.1:18765` listener remained |

Notes:

```text
The right-click tab menu click during cleanup triggered a reconnect before the dev process was stopped.
This did not affect the DisplayControl resize result, but tab-close behavior should be retested separately if Task 10 later touches connection lifecycle code.
```

### 2026-06-14 Task 10 clipboard and file-transfer smoke

Runtime:

```text
Command: npx tauri dev
Binary: target/debug/nextdesk
Targets: 192.168.3.105:3389 and 64.20.10.254:3389
Profile: official-web extension validation profile
Flags: native disabled, GFX off, DisplayControl on, file transfer on, audio callback registered
Log: /tmp/nextdesk_rdp_debug.log
```

Observed evidence:

| Case | Result | Evidence |
| --- | --- | --- |
| official-web proxy path | PASS | `rdp_proxy` connected directly to `192.168.3.105:3389` and via SOCKS5 to `64.20.10.254:3389`; X.224 and TLS handshake completed for both targets |
| native path disabled | PASS | Validation logs used `official ironrdp web connected`; no `rdp_native_connect` path was observed |
| desktop render with GFX off | PASS | `officialWebFeatures` recorded `gfx:false`; `Official canvas graphics update` continued during the session |
| text clipboard local to remote | PASS | User verified text paste; log recorded `forceUpdate Local→Remote text delivered` |
| text clipboard remote to local | PASS | User verified bidirectional text clipboard; log recorded remote clipboard change callbacks and successful format list acknowledgements |
| file clipboard local to remote | PASS | User verified file paste; log recorded `Focus sync → FormatList sent for files`, `FileContentsRequest`, and `Remote has received format list successfully` for local file input |
| file clipboard remote to local | PASS | User verified remote file copy back to macOS; log recorded `Remote file list`, `File Ice.zip complete via WS`, `Chunked transfer committed`, and `File NextDesk-main.zip complete via WS` |
| log health | PASS with caveat | No `error`/`failed`/`panic`/`crash` level entries were found. One `Unknown stream_id in FileContentsResponse: 90` warning appeared during repeated file validation, but the same transfer later completed via WS |

Not covered by this smoke:

```text
Connect 10 times
30 minute idle session
RDPDR drive sharing
RDPSND audible playback
GFX/H.264 enabled rendering
```

### 2026-06-14 Task 10 RDPDR settings exposure

Runtime:

```text
Command: cd frontend && npm run test -- src/test/session-store.test.tsx
Command: cd frontend && npm run build
Profile: official-web extension validation profile
Task: expose folder sharing so RDPDR can be manually verified
```

Observed evidence:

| Case | Result | Evidence |
| --- | --- | --- |
| folder sharing state sync | PASS | The new Vitest case first failed because a second mounted `useSessionStore()` instance did not observe the setting change, then passed after `useFolderSharingSetting` added same-window event sync |
| settings UI entry | PASS | Settings -> Remote Desktop now has a folder sharing switch backed by `nextdesk_folder_sharing`; the copy states that reconnect is required |
| frontend build | PASS | `npm run build` completed successfully with the existing wasm-bindgen `eval` warning |

### 2026-06-14 Task 10 RDPDR shared drive visibility

Runtime:

```text
Command: npx tauri dev
Binary: target/debug/nextdesk
Target: 64.20.10.254:3389
Profile: official-web extension validation profile
Log: /tmp/nextdesk_rdp_debug.log
```

Observed evidence:

| Case | Result | Evidence |
| --- | --- | --- |
| shared drive visible | PASS | User screenshot shows redirected drive `NextDesk on NextDesk` in Windows Explorer |
| shared item visible | PASS | User screenshot shows a shared item named `ignored` under the redirected drive |
| RDPDR channel active | PASS | Log recorded `RDPDR active`, Drive capability negotiation, `device announce response`, and repeated `drive_io_request` Create/QueryInformation/Close requests |
| file read callback | PASS | User reported copy normal; log recorded `DeviceReadRequest` plus `deferred read` for `WPA-Dictionary-276M.zip` and `art002e000192.jpg` |
| log health | PASS with caveats | Latest RDPDR validation window had no new `[error]`, panic, crash, or exception entries. Explorer metadata probes logged missing `desktop.ini`, directory change notifications logged `unhandled io request`, and write/create probes for `276M.zip` logged `create: no such path`; the user-visible copy still completed |

Not covered by this smoke:

```text
RDPDR write support into the redirected drive
```

### 2026-06-14 Task 10 RDPSND audio smoke

Runtime:

```text
Command: npx tauri dev
Binary: target/debug/nextdesk
Target: 192.168.3.105:3389
Profile: official-web extension validation profile
Flags: native disabled, GFX off, DisplayControl on, file transfer on, audio on
Log: /tmp/nextdesk_rdp_debug.log
```

Observed evidence:

| Case | Result | Evidence |
| --- | --- | --- |
| audio feature enabled | PASS | Log recorded `officialWebFeatures` with `audio:true` and `gfx:false` |
| audio callback registered | PASS | Log recorded `Audio callback configured` and `RDPSND audio redirection enabled (native cpal backend)` |
| RDPSND channels registered | PASS | Log recorded `RDPSND audio redirection channel registered`, `AUDIO_PLAYBACK_DVC registered`, and `RDPSND DVC: channel opened (AUDIO_PLAYBACK_DVC)` |
| PCM format negotiated | PASS | Playback generated `rdpsnd: format changed - 2 ch, 44100 Hz, 16 bit, tag=pcm` |
| audible playback | PASS | User confirmed remote audio was heard locally |
| log health | PASS | The sampled validation window had no new `[error]`, panic, crash, or exception entries |

Not covered by this smoke:

```text
Long-duration audio playback stability
Audio latency or crackle measurements
```

### 2026-06-14 Task 10 GFX stability guard

Runtime:

```text
Command: cd frontend && npm run test -- src/test/rdp-engine-flags.test.ts src/test/rdp-engine.test.ts src/test/session-store.test.tsx
Command: cd frontend && npm run build
Profile: official-web stable guard validation
```

Observed evidence:

| Case | Result | Evidence |
| --- | --- | --- |
| legacy GFX request guarded | PASS | `resolveOfficialWebFeatureFlags` now reports `gfxRequested:true` but keeps `gfx:false` unless `nextdesk_official_web_gfx_force` / `VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE` is also enabled |
| forced GFX remains possible for experiments | PASS | The explicit force flag can still set `gfx:true` for future isolated H.264 testing |
| frontend regression tests | PASS | 30 tests passed across `rdp-engine-flags`, `rdp-engine`, and `session-store` |
| frontend build | PASS | `npm run build` completed successfully with the existing wasm-bindgen `eval` warning |

Forced rendering evidence:

```text
2026-06-14 23:22 +0800, forced GFX dev round:
VITE_NEXTDESK_OFFICIAL_WEB_GFX=1 VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=1 npx tauri dev

Targets: 64.20.10.254:3389 and 192.168.3.105:3389
Result: BLOCKED, black RDP canvas after connection

Evidence:
- officialWebFeatures recorded gfx:true for both targets.
- WebSocket, X.224, TLS, and IronRDP session connection completed for both targets.
- GFX callback was configured and the graphics pipeline channel was registered.
- The server sent GFX WireToSurface1 frames with codec="clearcodec".
- No h264_frame callback or official canvas graphics update was observed in this forced run.

Conclusion:
The forced GFX path is currently not a valid stable rendering profile for these targets.
It needs ClearCodec or another non-H.264 fallback path before it can replace the guarded stable canvas path.
```

### 2026-06-15 forced GFX ClearCodec runtime gate

Runtime:

```text
Command: VITE_NEXTDESK_OFFICIAL_WEB_GFX=1 VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=1 npx tauri dev
Binary: target/debug/nextdesk
Profile: official-web forced GFX validation
Log: /tmp/nextdesk_rdp_debug.log
Runtime window: 2026-06-15T03:01:*
```

Observed evidence:

| Case | Result | Evidence |
| --- | --- | --- |
| GFX channel registered | PASS | Log recorded `GFX graphics pipeline channel registered` |
| ClearCodec frames decoded | PASS | `rg -c "2026-06-15T03:01:.*official-web ClearCodec frame" /tmp/nextdesk_rdp_debug.log` returned `161` |
| RGBA patches emitted | PASS | `rg -c "2026-06-15T03:01:.*official-web ClearCodec RGBA patch" /tmp/nextdesk_rdp_debug.log` returned `7`; frontend patch logs are intentionally throttled |
| fallback/error health | PASS | `rg -n "2026-06-15T03:01:.*(official-web GFX fallback|decode error|official-web GFX disabled|unsupported_codec|clearcodec decode error)" /tmp/nextdesk_rdp_debug.log` returned no matches |
| manual visual compositor | FAIL | 2026-06-15 forced-GFX retest at `2026-06-15T03:39:*` rendered visible block artifacts/flower screen while logs continued to show ClearCodec decode success and no decode error |

Conclusion:

```text
The previous forced-GFX black-screen root cause is only partially addressed: ClearCodec payloads decode and emit RGBA patches, but the web GFX compositor is not complete enough for stable visual output.
The forced-GFX profile is failed for manual visual validation until surface compositing covers the required EGFX operations, including ClearCodec updates plus non-bitmap surface commands.
```

### 2026-06-15 forced GFX AVC420/H.264 negotiation check

Runtime:

```text
Command:
VITE_NEXTDESK_RDP_ENGINE=official-web
VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP=0
VITE_NEXTDESK_OFFICIAL_WEB_GFX=1
VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=1
VITE_NEXTDESK_OFFICIAL_WEB_AUDIO=0
VITE_NEXTDESK_OFFICIAL_WEB_FILE_TRANSFER=0
VITE_NEXTDESK_OFFICIAL_WEB_DISPLAY_CONTROL=1
npx tauri dev

Binary: target/debug/nextdesk
Profile: official-web forced GFX AVC420 negotiation validation
Log: /tmp/nextdesk_rdp_debug.log
Runtime window: 2026-06-15T06:45:* and later
Targets: 192.168.3.105:3389 and 64.20.10.254:3389
```

Observed evidence:

| Case | Result | Evidence |
| --- | --- | --- |
| forced GFX connection requests | PASS | Parsed log returned `connect_request=2` and `connected=2` |
| GFX channel registered | PASS | Parsed log returned `gfx_channel=2` |
| WebCodecs H.264 pipeline initialized | PASS | Parsed log returned `h264_pipeline_enabled=2` |
| AVC420/H.264 runtime frames | FAIL | Parsed log returned `h264_frame=0` and `h264_true_codec=0` |
| ClearCodec selected by server | PASS | Parsed log returned `clearcodec_codec_lines=158`, `clearcodec_frame_lines=158`, and `clearcodec_rgba_patch_lines=8` |
| fallback/error health | PASS | Parsed log returned `error_or_fallback_lines=0` for `unsupported_codec`, decode errors, GFX fallback, panic, crash, exception, and `[error]` |

Conclusion:

```text
The official-web AVC420/H.264 code path is present and the browser-side H.264 pipeline starts, but the tested Windows targets did not negotiate AVC420/H.264 in this live run.
Both targets selected ClearCodec, so this run does not validate IronRDP native H.264 visual rendering.
Forced GFX remains outside the stable profile until either AVC420 is negotiated on a suitable target or the ClearCodec EGFX surface compositor passes manual visual validation.
```
