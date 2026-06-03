# FreeRDP Sidecar Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FreeRDP sidecar renderer shippable through local Tauri build and GitHub Actions packaging.

**Architecture:** Keep the current FreeRDP sidecar renderer as the default production rendering path. Package FreeRDP as app resources, resolve it from Tauri resources first, and keep Homebrew/PATH lookup as development fallback. CI must prepare or verify platform-specific FreeRDP resources before Tauri bundles the app.

**Tech Stack:** Tauri 2, React/Vite, Rust, GitHub Actions, FreeRDP `sdl-freerdp`, macOS app resources, Windows NSIS resources.

---

### Task 1: Map FreeRDP Resources Into Tauri Bundles

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/tauri.macos.conf.json`
- Modify: `src-tauri/tauri.windows.conf.json`
- Verify: `src-tauri/src/freerdp_sidecar.rs`

- [x] **Step 1: Inspect current resources**

Run:

```bash
rg -n '"resources"|freerdp|sdl-freerdp|bin/' src-tauri/tauri.conf.json src-tauri/tauri.macos.conf.json src-tauri/tauri.windows.conf.json src-tauri/src/freerdp_sidecar.rs
```

Expected: config resources include geodata/core resources; FreeRDP directory is missing or incomplete.

- [x] **Step 2: Add FreeRDP resource mappings**

Add these resource mappings to the shared or platform configs, preserving existing geodata resources:

```json
"../.backend/freerdp/macos/bin": "bin/freerdp",
"../.backend/freerdp/windows/bin": "bin/freerdp"
```

If Tauri rejects non-existing platform resources during a platform build, move the mappings into platform-specific config files instead:

```json
"../.backend/freerdp/macos/bin": "bin/freerdp"
```

for macOS config, and:

```json
"../.backend/freerdp/windows/bin": "bin/freerdp"
```

for Windows config.

- [x] **Step 3: Verify FreeRDP resolver matches bundled path**

Confirm `freerdp_sidecar.rs` searches:

```rust
resource_dir.join("bin").join("freerdp").join(exe)
```

Expected: bundled path resolves to `Resources/bin/freerdp/sdl-freerdp` on macOS and equivalent resource path on Windows.

- [x] **Step 4: Run config/package preflight**

Run:

```bash
npx tauri info
```

Expected: command completes and does not report invalid Tauri config.

### Task 2: Make macOS CI Prepare Bundled FreeRDP

**Files:**
- Modify: `.github/workflows/build.yml`
- Verify: `scripts/before-build.sh`
- Verify: `scripts/package-freerdp-macos.sh`

- [x] **Step 1: Add macOS FreeRDP dependency install**

In `build-macos`, before `Build & Release`, add:

```yaml
      - name: Install FreeRDP
        run: brew install freerdp
```

- [x] **Step 2: Verify macOS packaging script locally**

Run:

```bash
bash scripts/package-freerdp-macos.sh
```

Expected: output prints packaged binary path and dylib count; `.backend/freerdp/macos/bin/sdl-freerdp` exists.

- [x] **Step 3: Verify binary dependency rewrite**

Run:

```bash
otool -L .backend/freerdp/macos/bin/sdl-freerdp | sed -n '1,80p'
```

Expected: Homebrew FreeRDP/SDL dylib references used by the copied binary have been rewritten to `@executable_path/lib/...` where applicable.

### Task 3: Make Windows CI Prepare Or Verify FreeRDP

**Files:**
- Modify: `.github/workflows/build.yml`
- Modify: `scripts/verify-freerdp-windows.sh`
- Optional create: `scripts/package-freerdp-windows.ps1`

- [x] **Step 1: Choose Windows source**

Use one of these concrete approaches:

```powershell
choco install freerdp -y
```

or commit/download a known `sdl-freerdp.exe` runtime bundle into `.backend/freerdp/windows/bin`.

- [x] **Step 2: Add CI setup step before Windows build**

If using Chocolatey, add:

```yaml
      - name: Install FreeRDP
        shell: pwsh
        run: choco install freerdp -y
```

Then add a packaging/copy step that places `sdl-freerdp.exe` and required DLLs into:

```text
.backend/freerdp/windows/bin
```

- [ ] **Step 3: Run Windows resource verifier**

Current status: local YAML and Bash syntax checks passed. This step still requires a Windows runner because it depends on `choco install freerdp` and Windows DLL layout.

Run on Windows CI:

```bash
bash scripts/verify-freerdp-windows.sh
```

Expected: verifier finds `sdl-freerdp.exe` and required runtime DLLs.

### Task 4: Verify Sidecar Startup Arguments And Fallback Behavior

**Files:**
- Verify: `src-tauri/src/freerdp_sidecar.rs`

- [x] **Step 1: Run existing FreeRDP argument tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml freerdp_args -- --nocapture
```

Expected: `2 passed; 0 failed`.

- [ ] **Step 2: Verify local development still resolves Homebrew/PATH FreeRDP**

Current status: not rerun in this pass to avoid interrupting the active development app. Existing dev session remains running.

Run:

```bash
NEXTDESK_FREERDP_BIN=/opt/homebrew/bin/sdl-freerdp npx tauri dev
```

Expected: app launches, a FreeRDP connection can be opened, and logs show the configured executable path.

### Task 5: macOS Package Smoke Test

**Files:**
- Verify: `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/NextDesk.app`

**Current architecture decision:** macOS release packaging is Apple Silicon (`aarch64-apple-darwin`) for now. The app can build as universal, but the bundled Homebrew `sdl-freerdp` sidecar is currently arm64-only; shipping a universal app with an arm64-only sidecar would break FreeRDP rendering on Intel Macs.

- [x] **Step 1: Build macOS app package**

Run:

```bash
npm run tauri build -- --target aarch64-apple-darwin --config src-tauri/tauri.macos.conf.json
```

Expected: build completes and produces `NextDesk.app`.

Current status: local build produced `NextDesk.app`, `NextDesk_1.0.102_aarch64.dmg`, and updater tarball. The local command exits with code 1 after bundle generation because this machine does not have `TAURI_SIGNING_PRIVATE_KEY`; GitHub release build must provide that secret for a fully successful signing/updater pass.

- [x] **Step 2: Verify app bundle contains FreeRDP**

Run:

```bash
find src-tauri/target -path '*NextDesk.app*' -name 'sdl-freerdp' -print
```

Expected: output includes a path under `NextDesk.app/Contents/Resources/bin/freerdp/sdl-freerdp`.

Current status: verified `NextDesk.app/Contents/Resources/bin/freerdp/sdl-freerdp` is executable, includes 37 bundled dylibs, and its primary FreeRDP/SDL dependencies resolve through `@executable_path/lib/...`.

- [ ] **Step 3: Verify app does not require Homebrew FreeRDP**

Run the built `.app` with:

```bash
NEXTDESK_FREERDP_BIN= open src-tauri/target/aarch64-apple-darwin/release/bundle/macos/NextDesk.app
```

Expected: app opens and FreeRDP session launches from bundled resource.

Current status: not run in this pass to avoid interrupting the active development app. This remains a manual runtime acceptance check.

### Task 6: Runtime Acceptance Checklist

**Files:**
- Verify only; no required code changes unless a check fails.

- [ ] **Step 1: Connect one LAN server**

Expected: FreeRDP renderer appears in NextDesk area and input works.

- [ ] **Step 2: Connect one public/proxied server**

Expected: renderer is smooth and proxy route is used when configured.

- [ ] **Step 3: Switch between two RDP tabs**

Expected: only active tab's FreeRDP window is visible.

- [ ] **Step 4: Close each tab**

Run:

```bash
ps -axo pid,ppid,stat,comm,args | rg 'sdl-freerdp'
```

Expected: closed sessions do not leave stale `sdl-freerdp` processes.

- [ ] **Step 5: Resize NextDesk in adaptive mode**

Expected: sidecar reconnects or dynamically adapts to the new viewport size, with usable remote resolution after reconnect.

### Task 7: Final GitHub Readiness Review

**Files:**
- Verify: `.github/workflows/build.yml`
- Verify: `src-tauri/tauri*.conf.json`
- Verify: `scripts/*freerdp*`

- [ ] **Step 1: Check changed files**

Run:

```bash
git status --short
```

Expected: only intended packaging, sidecar, and documentation files are modified.

- [ ] **Step 2: Run final targeted checks**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml freerdp_args -- --nocapture
npx tauri info
```

Expected: FreeRDP tests pass; Tauri config is valid.

- [ ] **Step 3: Confirm push readiness**

Do not push automatically. Report:

```text
macOS local package status:
Windows CI readiness:
Known risks:
Next required manual test:
```

Expected: user explicitly approves before any git commit/push/tag.
