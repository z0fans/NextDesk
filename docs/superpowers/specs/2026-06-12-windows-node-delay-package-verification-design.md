# Windows Node Delay Package Verification Design

## Goal

Verify the node delay fix in a real Windows package before publishing a release that users can receive.

## Problem

Local development runs current source through Vite/Tauri dev mode, while affected Windows machines run the previously packaged `1.0.116` build. Remote evidence showed that the Windows ARM64 core can return node delay values when started manually, but the packaged app can leave the UI stuck in `...` because the app state can report the core as running after the process has exited. A separate layout issue can also move the server page action button outside the visible area on high-DPI/narrow Windows screens.

## Constraints

- Do not push this verification package to `main`.
- Do not create a `v*` tag.
- Do not create or update a GitHub Release.
- Do not upload updater JSON to a release.
- Do not let normal users receive the verification build.
- The verification build must be produced by GitHub Actions on Windows, not by macOS local build output.
- The Windows package should be close to the eventual release build command and configuration.
- The verification artifact must preserve the official Windows package behavior: the x64 CI runner builds the installer, but the bundle contains both `nextdesk-core-amd64.exe` and `nextdesk-core-arm64.exe` so Windows ARM64 can select the native core at runtime.

## Approach

Create a temporary branch named `codex/verify-node-delay-windows`. On this branch, add a dedicated Windows verification workflow that builds the app with `src-tauri/tauri.windows.conf.json` and uploads the Windows bundle as a GitHub Actions artifact only. The workflow must use `actions/upload-artifact`, not `tauri-action` release upload.

The workflow downloads dependencies through `scripts/download-deps.sh x86_64-pc-windows-msvc`, matching the official Windows package path. That target intentionally downloads both Windows core binaries and maps them into the Tauri Windows resources:

- `nextdesk-core-amd64.exe`
- `nextdesk-core-arm64.exe`
- `nextdesk-core.exe` legacy fallback

The branch also carries the current code fixes:

- Backend status correction: `get_status` uses the same live process probe as `start_engine_inner`, so exited core processes are not reported as running.
- Server page layout correction: remove duplicate main-content left margin and keep the delay-test button inside the visible viewport.

The branch uses version `1.0.117` for verification so the installed app can be distinguished from `1.0.116`. Since the branch has no tag or release, this does not expose the package to normal users.

## Verification Criteria

CI passes when:

- Windows build completes using `npm run tauri build -- --config src-tauri/tauri.windows.conf.json`.
- The bundled resources include both `nextdesk-core-amd64.exe` and `nextdesk-core-arm64.exe`.
- Rust tests verify Windows ARM64 hosts prefer `nextdesk-core-arm64.exe`.
- Artifact upload contains the Windows bundle directory and installer files.

Remote Windows verification passes when:

- Installed app reports version `1.0.117`.
- Clicking node delay starts `nextdesk-core`.
- Runtime controller port listens on `127.0.0.1`.
- `/proxies/*/delay` returns delay values.
- The UI shows millisecond values for real nodes after the delay test.

If remote verification fails, debugging continues on the temporary branch only.
