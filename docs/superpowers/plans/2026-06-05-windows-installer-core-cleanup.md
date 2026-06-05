# Windows Installer Core Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Windows NSIS installer and uninstaller terminate both fixed and runtime-renamed NextDesk core processes before overwriting or removing files, then publish `v1.0.108`.

**Architecture:** Keep the fix at the installer lifecycle layer by extending the existing NSIS hook file. The RDP official-web renderer, WebSocket protocol, and Rust RDP proxy implementation remain unchanged. Version metadata is bumped consistently across Tauri config, Cargo package metadata, and Cargo lock so GitHub Actions produces a coherent `v1.0.108` package.

**Tech Stack:** Tauri 2, NSIS installer hooks, Rust Cargo metadata, GitHub Actions release tag.

---

## File Structure

- Modify `src-tauri/nsis/hooks.nsi`: add wildcard cleanup for runtime-copied `nextdesk-core-*.exe` processes in both preinstall and preuninstall hooks.
- Modify `src-tauri/tauri.conf.json`: bump app version from `1.0.106` to `1.0.108`.
- Modify `src-tauri/Cargo.toml`: bump Cargo package version from `1.0.106` to `1.0.108`.
- Modify `src-tauri/Cargo.lock`: bump the `[[package]] name = "nextdesk"` version from `1.0.106` to `1.0.108`.
- No frontend rendering files are modified.

### Task 1: Extend NSIS Process Cleanup

**Files:**
- Modify: `src-tauri/nsis/hooks.nsi:1-17`

- [ ] **Step 1: Confirm current hook misses runtime-renamed core processes**

Run:

```bash
nl -ba src-tauri/nsis/hooks.nsi | sed -n '1,40p'
```

Expected: `NSIS_HOOK_PREINSTALL` and `NSIS_HOOK_PREUNINSTALL` only call `taskkill` for `nextdesk-core.exe` and `nextdesk.exe`.

- [ ] **Step 2: Update the hook with wildcard process cleanup**

Replace the two lifecycle macros with:

```nsi
!macro NSIS_HOOK_PREINSTALL
  ; Stop old processes before copying files. Runtime core copies are named
  ; nextdesk-core-<parent-pid>-<timestamp>.exe, so the wildcard is required.
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk-core-*.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk-core.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk.exe'
!macroend
```

and:

```nsi
!macro NSIS_HOOK_PREUNINSTALL
  ; Stop running processes before removing installed files. Runtime core copies
  ; are named nextdesk-core-<parent-pid>-<timestamp>.exe.
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk-core-*.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk-core.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM nextdesk.exe'
!macroend
```

- [ ] **Step 3: Verify both install and uninstall hooks contain the wildcard**

Run:

```bash
rg -n 'nextdesk-core-\\*\\.exe|NSIS_HOOK_PREINSTALL|NSIS_HOOK_PREUNINSTALL' src-tauri/nsis/hooks.nsi
```

Expected: two `nextdesk-core-*.exe` lines, one under `NSIS_HOOK_PREINSTALL` and one under `NSIS_HOOK_PREUNINSTALL`.

### Task 2: Bump Release Version to 1.0.108

**Files:**
- Modify: `src-tauri/tauri.conf.json:3`
- Modify: `src-tauri/Cargo.toml:3`
- Modify: `src-tauri/Cargo.lock:3586-3587`

- [ ] **Step 1: Update Tauri app version**

Set `src-tauri/tauri.conf.json`:

```json
"version": "1.0.108"
```

- [ ] **Step 2: Update Cargo package version**

Set `src-tauri/Cargo.toml`:

```toml
version = "1.0.108"
```

- [ ] **Step 3: Update Cargo lock package version**

Set the `nextdesk` package entry in `src-tauri/Cargo.lock`:

```toml
[[package]]
name = "nextdesk"
version = "1.0.108"
```

- [ ] **Step 4: Verify version metadata is synchronized**

Run:

```bash
rg -n '^  "version":|^version = "|name = "nextdesk"' src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
```

Expected: the Tauri config, Cargo package, and `nextdesk` lock entry all show `1.0.108`.

### Task 3: Validate and Publish

**Files:**
- No extra source files.

- [ ] **Step 1: Run targeted validation**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml config::tests -- --nocapture
```

Expected: all selected config tests pass.

- [ ] **Step 2: Inspect final diff**

Run:

```bash
git diff -- src-tauri/nsis/hooks.nsi src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
```

Expected: only NSIS wildcard cleanup and version bump changes appear.

- [ ] **Step 3: Commit**

Run:

```bash
git add src-tauri/nsis/hooks.nsi src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock docs/superpowers/plans/2026-06-05-windows-installer-core-cleanup.md
git commit -m "fix(windows): 清理覆盖安装残留进程"
```

Expected: commit succeeds on `main`.

- [ ] **Step 4: Tag and push**

Run:

```bash
git tag -a v1.0.108 -m "NextDesk v1.0.108"
git push origin main
git push origin v1.0.108
```

Expected: `main` and tag `v1.0.108` are pushed to GitHub, triggering release packaging.

## Self-Review

- Spec coverage: The plan covers wildcard cleanup for `nextdesk-core-*.exe` during both preinstall and preuninstall, version bump to `1.0.108`, and tag push.
- Placeholder scan: No placeholders remain.
- Type and path consistency: All paths and version strings match the current NextDesk repository layout.
