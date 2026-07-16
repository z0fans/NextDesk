# NextDesk Tauri 2 Release Guide

NextDesk releases are built by GitHub Actions from tags matching `v*`. The workflow
produces a universal macOS app/DMG and a Windows NSIS installer after the shared quality
gate succeeds.

## Signing Policy

The project owner accepts distribution without Apple Developer ID and Windows
Authenticode certificates. Unsigned packages are buildable and publishable, but users
should expect macOS Gatekeeper and Windows SmartScreen warnings.

Do not confuse OS code signing with Tauri updater signing:

- Apple Developer ID / notarization and Windows Authenticode establish publisher trust.
- Tauri updater `.sig` files authenticate update artifacts to the installed app.
- A Tauri `.sig` does not remove Gatekeeper or SmartScreen warnings.
- Without `TAURI_SIGNING_PRIVATE_KEY`, the release workflow disables updater artifacts.
  The installers still build, but `latest.json` and in-app update delivery are unavailable.

## 1. Choose And Synchronize The Version

Use a semantic version such as `1.0.124`; the Git tag is the same value prefixed with `v`.

Update these files together:

- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.kkterm.toml`

Then refresh and verify the lockfiles through the normal Cargo commands. Do not leave the
application metadata on an older version than the tag.

Verify the synchronized values:

```bash
rg -n '^version = "|"version":' \
  src-tauri/Cargo.toml \
  src-tauri/Cargo.kkterm.toml \
  src-tauri/tauri.conf.json

rg -n -A2 'name = "nextdesk"' \
  src-tauri/Cargo.lock \
  src-tauri/Cargo.kkterm.lock
```

## 2. Run The Release-Candidate Gate

The repository must have the patched `IronRDP` checkout next to `NextDesk`, as documented
in `AGENTS.md`.

```bash
npm ci
npm --prefix frontend ci
npm --prefix frontend run lint
npm --prefix frontend test -- --run
npm --prefix frontend run build

cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
RUSTFLAGS='--cfg nextdesk_kkterm_rdp' \
  cargo test --locked --manifest-path src-tauri/Cargo.toml \
  --lib --features kkterm-rdp -- --nocapture

git diff --check
```

Also review `docs/qa/release-acceptance-gate.md`. Hardware-only rows must remain
`Not Verified` unless they were exercised on the named platform and release candidate.

## 3. Review The Release Diff

Before committing, verify that the release contains only intended work:

```bash
git status --short
git diff --stat
git diff -- .github/workflows RELEASE.md docs/qa src-tauri frontend
```

This repository often contains parallel work. Do not use `git add -A` unless every change
in the worktree belongs to the release.

## 4. Commit, Tag And Push

Example for version `1.0.124`:

```bash
git add <reviewed-files-only>
git commit -m "release: v1.0.124"
git push origin main

git tag -a v1.0.124 -m "v1.0.124"
git push origin v1.0.124
```

The tag push triggers `.github/workflows/build.yml` (`Build & Release`). The workflow:

1. checks out the pinned IronRDP commit and applies the NextDesk patch;
2. installs locked npm dependencies with `npm ci`;
3. runs lint, all frontend tests, the production frontend build, Rust formatting and
   locked Rust library tests;
4. builds macOS first, then Windows for a normal tagged release;
5. publishes artifacts to the matching GitHub Release.

Use `workflow_dispatch` for packaging tests without creating a tag. It can target all
platforms, macOS universal, macOS Intel, or Windows.

## 5. Verify Published Assets

For every published release, confirm:

- the Git tag, `tauri.conf.json`, both Cargo manifests and running application all show
  the same version;
- the macOS DMG/app and Windows NSIS installer are present;
- both packages launch and connect through the default `kkterm-copy` engine;
- no release workflow overrides the tested renderer or keyboard mode unexpectedly;
- when updater signing is enabled, `latest.json` and the expected `.sig` assets exist and
  `latest.json.version` matches the tag;
- when updater signing is disabled, the release notes clearly say that the release uses
  manual download/update only.

## 6. Installation, Update And Rollback Smoke Test

### Fresh install

1. Install on a clean macOS machine and a clean Windows machine.
2. Acknowledge the expected unsigned-app warning without claiming a verified publisher.
3. Launch NextDesk and confirm version, login/device state and saved-session behavior.
4. Connect to a real RDP target and verify first frame, pointer, keyboard, text clipboard,
   Adaptive, one fixed resolution and Local scaling.

### In-app update

Only run this section when `latest.json` and updater `.sig` files were published:

1. Install the previous known-good version.
2. Use **Check for Updates**.
3. Download/install the new release and allow the app to relaunch.
4. Confirm the new version and repeat a basic RDP connection smoke test.

If updater artifacts were intentionally disabled, download the new installer manually and
verify that installing over the prior version preserves expected configuration.

### Rollback

1. Keep the previous known-good installers before publishing.
2. Export or back up any user configuration needed for the test.
3. Install the previous version over the release candidate, or uninstall/reinstall if the
   platform installer requires it.
4. Confirm the old version launches, reads its configuration and connects successfully.
5. If rollback fails, stop the release and document the incompatible state before retrying.

## 7. Failure Handling

- Do not move or recreate a public tag until the cause is understood.
- A green tag alone is not a successful release; inspect the actual assets.
- If macOS succeeds but Windows fails, keep the release incomplete until the Windows job
  and artifact are repaired.
- If `latest.json` reports an older version than the tag, synchronize all version sources
  and cut a new patch release instead of silently replacing an already distributed tag.
- Never print or commit `TAURI_SIGNING_PRIVATE_KEY`.
