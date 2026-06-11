# Windows Node Delay Package Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify the node delay fix from a Windows CI package without exposing it to normal users.

**Architecture:** Use a temporary Git branch with a dedicated GitHub Actions workflow that builds Windows artifacts only and uploads them as workflow artifacts. Keep release/tag/updater distribution paths untouched until manual Windows verification passes. The Windows build runs on an x64 runner like the official workflow, but it must bundle both amd64 and arm64 Mihomo cores so Windows ARM64 can select `nextdesk-core-arm64.exe` at runtime.

**Tech Stack:** Tauri 2, React/Vite, Rust/Cargo, GitHub Actions, Windows NSIS bundle, patched IronRDP checkout.

---

### Task 1: Carry the local node delay fixes on the verification branch

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Verify backend status fix is present**

Check that `get_status` calls `internal_engine_running(app_state.inner())` instead of only checking `child.id().is_some()`.

Run:

```bash
rg -n "fn get_status|internal_engine_running\\(app_state.inner\\(\\)\\)" src-tauri/src/lib.rs
```

Expected: output includes both `fn get_status` and `internal_engine_running(app_state.inner())`.

- [ ] **Step 2: Verify UI layout fix is present**

Check that the main content uses `min-w-0` without duplicate sidebar margin and the delay button is fixed in the viewport.

Run:

```bash
rg -n "min-w-0 h-screen|fixed top-20 right-4" frontend/src/App.tsx
```

Expected: both patterns are found.

### Task 2: Mark the verification package as the next version

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Set Cargo package version to `1.0.117`**

Update:

```toml
version = "1.0.117"
```

- [ ] **Step 2: Set Tauri app version to `1.0.117`**

Update:

```json
"version": "1.0.117"
```

- [ ] **Step 3: Verify version markers**

Run:

```bash
rg -n 'version = "1.0.117"|"version": "1.0.117"' src-tauri/Cargo.toml src-tauri/tauri.conf.json
```

Expected: both files show version `1.0.117`.

### Task 3: Add Windows verification artifact workflow

**Files:**
- Create: `.github/workflows/windows-verify-artifact.yml`

- [ ] **Step 1: Create the workflow**

Create a workflow named `Windows Verify Artifact` that triggers only on the temporary branch or manual dispatch. It must not call `tauri-apps/tauri-action` release upload.

Workflow content:

```yaml
name: Windows Verify Artifact

on:
  push:
    branches:
      - codex/verify-node-delay-windows
  workflow_dispatch:

env:
  MIHOMO_VERSION: v1.19.27
  VITE_NEXTDESK_RDP_ENGINE: official-web

jobs:
  windows-verify:
    runs-on: windows-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4

      - name: Checkout patched IronRDP
        shell: bash
        run: |
          git clone --no-tags https://github.com/Devolutions/IronRDP.git ../IronRDP
          git -C ../IronRDP checkout bf694c8a239d4cf53e7dd8edbe26f2aeb07bcf26
          git -C ../IronRDP apply "$PWD/patches/ironrdp-nextdesk.patch"

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Install dependencies
        run: npm install && cd frontend && npm install

      - name: Download Windows mihomo and geodata
        shell: bash
        run: bash scripts/download-deps.sh x86_64-pc-windows-msvc

      - name: Verify bundled Windows engines
        shell: pwsh
        run: |
          Get-ChildItem .backend\bin\nextdesk-core*.exe | Select-Object Name,Length
          if (!(Test-Path .backend\bin\nextdesk-core-amd64.exe)) { throw "missing amd64 core" }
          if (!(Test-Path .backend\bin\nextdesk-core-arm64.exe)) { throw "missing arm64 core" }
          if (!(Test-Path .backend\bin\nextdesk-core.exe)) { throw "missing legacy core" }

      - name: Sanitize signing key
        shell: bash
        run: |
          KEY=$(echo "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}" | tr -d '\n\r')
          echo "TAURI_SIGNING_PRIVATE_KEY=$KEY" >> "$GITHUB_ENV"

      - name: Run Rust regression tests
        shell: bash
        working-directory: src-tauri
        run: |
          cargo test exited_internal_engine_is_not_reported_running -- --nocapture
          cargo test node_delay_test_starts_engine_when_proxy_api_is_unavailable -- --nocapture
          cargo test windows_arm64_hosts_prefer_arm64_engine -- --nocapture
          cargo test windows_amd64_hosts_prefer_amd64_engine -- --nocapture

      - name: Build Windows verification package
        shell: pwsh
        run: |
          npm run tauri build -- --config src-tauri/tauri.windows.conf.json

      - name: List Windows bundle output
        shell: pwsh
        run: |
          Get-ChildItem -Recurse src-tauri\target\release\bundle | Select-Object FullName,Length

      - name: Upload Windows verification artifact
        uses: actions/upload-artifact@v4
        with:
          name: nextdesk-windows-verify-1.0.117
          path: |
            src-tauri/target/release/bundle/nsis/**
            src-tauri/target/release/bundle/msi/**
          if-no-files-found: error
```

- [ ] **Step 2: Verify workflow does not publish**

Run:

```bash
rg -n "tauri-action|gh release|tagName|releaseName|includeUpdaterJson|releaseDraft|prerelease" .github/workflows/windows-verify-artifact.yml
```

Expected: no matches.

### Task 4: Local verification before pushing the branch

**Files:**
- No new files beyond Tasks 1-3.

- [ ] **Step 1: Format Rust code**

Run:

```bash
cd src-tauri && cargo fmt --check
```

Expected: exit code `0`.

- [ ] **Step 2: Run frontend build**

Run:

```bash
cd frontend && npm run build
```

Expected: exit code `0`.

- [ ] **Step 3: Run Rust library tests**

Run:

```bash
cd src-tauri && cargo test --lib -- --nocapture
```

Expected: all tests pass.

- [ ] **Step 4: Run no-bundle Tauri build**

Run:

```bash
npx tauri build --no-bundle
```

Expected: release binary builds successfully.

- [ ] **Step 5: Check diff hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected: only intended tracked changes plus known untracked diagnostic files.

### Task 5: Commit and push verification branch

**Files:**
- Stage only intended files.

- [ ] **Step 1: Stage intended files**

Run:

```bash
git add frontend/src/App.tsx src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json .github/workflows/windows-verify-artifact.yml docs/superpowers/specs/2026-06-12-windows-node-delay-package-verification-design.md docs/superpowers/plans/2026-06-12-windows-node-delay-package-verification.md
```

- [ ] **Step 2: Confirm staged files**

Run:

```bash
git diff --cached --name-only
```

Expected: only the intended eight files are staged.

- [ ] **Step 3: Commit**

Run:

```bash
git commit -m "fix(proxy): 验证 Windows 节点测速修复"
```

- [ ] **Step 4: Push temporary branch**

Run:

```bash
git push -u origin codex/verify-node-delay-windows
```

Expected: branch push succeeds and triggers `Windows Verify Artifact`.

### Task 6: Validate CI artifact and remote Windows behavior

**Files:**
- No code changes expected unless verification fails.

- [ ] **Step 1: Check GitHub Actions run**

Use GitHub web UI or GitHub API to confirm `Windows Verify Artifact` finishes successfully on branch `codex/verify-node-delay-windows`.

- [ ] **Step 2: Download artifact**

Download artifact `nextdesk-windows-verify-1.0.117`.

- [ ] **Step 3: Install on remote Windows through the CF remote exec workflow**

Install the verification package manually or via PowerShell on the remote Windows machine.

- [ ] **Step 4: Verify runtime state**

Run PowerShell checks for version, core process, runtime ports, and delay API:

```powershell
$exe=(Get-Process nextdesk | Select-Object -First 1).Path
(Get-Item $exe).VersionInfo | Select-Object ProductVersion,FileVersion
$cfg="$env:APPDATA\NextDesk\runtime_clash.yaml"
$api = (Select-String -Path $cfg -Pattern "^external-controller:" | ForEach-Object { ($_ -split ":")[-1].Trim() })
Test-NetConnection 127.0.0.1 -Port $api
Invoke-RestMethod "http://127.0.0.1:$api/proxies"
```

Expected: version is `1.0.117`, core starts after clicking delay test, API port listens, and node delay values are available.
