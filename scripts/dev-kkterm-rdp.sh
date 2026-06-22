#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"

if [[ ! -f "$TAURI_DIR/Cargo.kkterm.toml" ]]; then
  echo "Missing $TAURI_DIR/Cargo.kkterm.toml" >&2
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
  cp "$backup_toml" "$TAURI_DIR/Cargo.toml"
  cp "$backup_lock" "$TAURI_DIR/Cargo.lock"
  rm -f "$backup_toml" "$backup_lock"
}

cp "$TAURI_DIR/Cargo.toml" "$backup_toml"
cp "$TAURI_DIR/Cargo.lock" "$backup_lock"
trap restore_manifest EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp "$TAURI_DIR/Cargo.kkterm.toml" "$TAURI_DIR/Cargo.toml"

export VITE_NEXTDESK_RDP_ENGINE="${VITE_NEXTDESK_RDP_ENGINE:-kkterm-copy}"
export VITE_NEXTDESK_KKTERM_KEYBOARD_MODE="${VITE_NEXTDESK_KKTERM_KEYBOARD_MODE:-remote-scancode}"
export RUSTFLAGS="${RUSTFLAGS:-} --cfg nextdesk_kkterm_rdp"

cd "$ROOT_DIR"
npx tauri dev --features kkterm-rdp
