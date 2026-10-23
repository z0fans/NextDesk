# NextDesk Release Acceptance Gate

Updated: 2026-07-14

This document is the current release gate. Historical runtime transcripts remain in
`kkterm-nextdesk-acceptance-2026-07-11.md`, but later repairs and automated coverage
supersede several earlier verdicts in that file.

## Release Decision

**Windows and macOS packaging capability: Ready, with unsigned-distribution risk accepted by the owner.**

The repository has a tag-triggered Tauri 2 release workflow, locked dependency installs,
frontend and Rust quality gates, and platform packaging jobs. Apple Developer ID and
Windows Authenticode certificates are not required to produce the installers, but their
absence causes Gatekeeper/SmartScreen warnings and reduces user trust.

The following runtime-only rows remain `Not Verified`. They do not invalidate the build
pipeline, but they should be completed before claiming full hardware/input compatibility
in a broad public release.

## Automated Gate

| Area | Windows | macOS | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| Frontend lint | Shared gate | Shared gate | `npm --prefix frontend run lint`, baseline capped at 13 existing Hook warnings | Pass |
| Frontend tests | Shared gate | Shared gate | Full Vitest suite in `Build & Release` and Windows verification workflow | Pass when CI is green |
| Frontend production build | Shared gate | Shared gate | `npm --prefix frontend run build` | Pass when CI is green |
| Rust formatting and library tests | Native Windows job | macOS quality gate | `cargo fmt --check`; locked `kkterm-rdp` library tests | Pass when CI is green |
| Gateway Agent tests | Shared gate | Shared gate | `go -C gateway-agent test ./...`, using the version declared in `go.mod` | Pass when CI is green |
| Packaging configuration | NSIS with embedded WebView2 bootstrapper | Universal Apple app + DMG | `.github/workflows/build.yml`, platform Tauri config files | Pass |
| Patched IronRDP dependency | Same pinned commit and patch | Same pinned commit and patch | CI checks out `bf694c8a23...` and applies `patches/ironrdp-nextdesk.patch` | Pass |
| macOS local scaling | Not applicable | Mode exposed; current remote backing size is frozen and CSS scales the canvas without reconnecting | `resolution-modes.test.ts`, `RdpManager.tsx`, `styles.css` | Automated Pass; visual runtime Not Verified |

## Platform Acceptance

| Capability | Windows | macOS | Release treatment |
| --- | --- | --- | --- |
| Core connection, first frame, single-session rendering | Previously verified on real RDP targets | Previously verified on real RDP targets | Accepted |
| Text clipboard | Previously verified bidirectionally, including Unicode and large text | Previously verified bidirectionally, including Unicode and large text | Accepted |
| Windows file clipboard | Pass after the corrected-shell repair; the earlier failure inspected the wrong remote filesystem boundary | Not applicable | Accepted on Windows |
| macOS file clipboard | Not applicable | End-to-end Finder/Explorer file hashes not verified | Not Verified; do not advertise as fully accepted |
| Fixed/adaptive resolution | Previously verified | Previously verified | Accepted |
| Local scaling | Previously verified with ActiveX SmartSizing | Implemented and unit-tested; physical visual/pointer run still pending | Windows Pass; macOS Not Verified at runtime |
| F1-F12 and navigation keys | Automated mapping/scancode coverage exists; physical independent observation incomplete | Automated mapping/scancode coverage exists; physical keyboard path incomplete | Not Verified on physical hardware |
| Chinese/Japanese/Korean IME | Microsoft Pinyin candidate capture incomplete | Composition-event filtering is tested; physical candidate-window flow incomplete | Not Verified |
| Windows 125%/150%/200% DPI | Scale propagation/fallback unit tests exist; requested physical modes unavailable | Retina path previously exercised | Windows Not Verified on hardware |
| Multi-monitor | ActiveX configuration and persistence pass; true two-monitor layout unavailable | No accepted true multi-monitor run | Not Verified; do not advertise full multi-monitor support |
| Repeated two-session frame isolation | Previously verified on two live targets | No equivalent two-target runtime run | Windows accepted for frame isolation; macOS Not Verified |

## Explicitly Accepted Non-Blocking Limitations

- macOS packages are not Developer ID signed or notarized.
- Windows installers are not Authenticode signed.
- Gatekeeper and SmartScreen warnings are expected for unsigned packages.
- OS code signing is separate from Tauri updater signing. A `.sig` file protects updater
  artifact integrity; it does not remove Gatekeeper or SmartScreen warnings.
- If `TAURI_SIGNING_PRIVATE_KEY` is absent, CI intentionally disables updater artifacts.
  Installers can still be published, but `latest.json` and in-app update delivery are not
  available for that release.

## Manual RC Checklist

Run these checks on the actual release artifacts, not only the dev build:

1. Install the macOS DMG and Windows NSIS package on clean machines.
2. Confirm displayed version equals the Git tag and all three source version files.
3. Connect to one real RDP target and verify first frame, pointer, keyboard and text clipboard.
4. Switch Adaptive -> fixed resolution -> Local scaling -> Adaptive.
5. Disconnect/reconnect and relaunch the app; confirm saved sessions remain usable.
6. If updater artifacts are enabled, update from the previous release and confirm relaunch.
7. Reinstall the previous known-good package to prove rollback before publishing broadly.

Rows that require unavailable hardware remain `Not Verified`; they must not be converted
to `Pass` based only on code inspection or unit tests.
