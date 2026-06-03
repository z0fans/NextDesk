#!/usr/bin/env bash
# Verify that the Windows FreeRDP resource directory is ready for Tauri bundling.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="${NEXTDESK_FREERDP_WINDOWS_BIN_DIR:-$ROOT_DIR/.backend/freerdp/windows/bin}"

if [ ! -f "$BIN_DIR/sdl-freerdp.exe" ]; then
  echo "ERROR: Missing $BIN_DIR/sdl-freerdp.exe" >&2
  echo "Put the FreeRDP SDL Windows binary and its DLL dependencies in this directory." >&2
  exit 1
fi

dll_count="$(find "$BIN_DIR" -maxdepth 1 -type f -iname '*.dll' | wc -l | tr -d ' ')"
if [ "$dll_count" -lt 5 ]; then
  echo "ERROR: Only found $dll_count DLL files in $BIN_DIR." >&2
  echo "FreeRDP on Windows requires its runtime DLL dependencies beside sdl-freerdp.exe." >&2
  exit 1
fi

echo "Windows FreeRDP resources look present:"
echo "  binary: $BIN_DIR/sdl-freerdp.exe"
echo "  dlls: $dll_count"
