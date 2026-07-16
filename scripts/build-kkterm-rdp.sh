#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"
KKTERM_TOML="$TAURI_DIR/Cargo.kkterm.toml"
KKTERM_LOCK="$TAURI_DIR/Cargo.kkterm.lock"

if [[ ! -f "$KKTERM_TOML" ]]; then
  echo "Missing $KKTERM_TOML" >&2
  exit 1
fi

backup_toml="$(mktemp /tmp/nextdesk-cargo.toml.XXXXXX)"
backup_lock="$(mktemp /tmp/nextdesk-cargo.lock.XXXXXX)"
restored=0

restore_manifest() {
  if [[ "$restored" -eq 1 ]]; then
    return
  fi
  restored=1
  if [[ -f "$TAURI_DIR/Cargo.lock" ]]; then
    cp "$TAURI_DIR/Cargo.lock" "$KKTERM_LOCK"
  fi
  cp "$backup_toml" "$TAURI_DIR/Cargo.toml"
  cp "$backup_lock" "$TAURI_DIR/Cargo.lock"
  rm -f "$backup_toml" "$backup_lock"
}

cp "$TAURI_DIR/Cargo.toml" "$backup_toml"
cp "$TAURI_DIR/Cargo.lock" "$backup_lock"
trap restore_manifest EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp "$KKTERM_TOML" "$TAURI_DIR/Cargo.toml"
if [[ -f "$KKTERM_LOCK" ]]; then
  cp "$KKTERM_LOCK" "$TAURI_DIR/Cargo.lock"
fi

cd "$ROOT_DIR"
node scripts/build-kkterm-rdp.mjs "$@"
