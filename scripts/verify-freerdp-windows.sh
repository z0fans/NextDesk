#!/usr/bin/env bash
# Verify that the Windows FreeRDP resource directory is ready for Tauri bundling.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="${NEXTDESK_FREERDP_WINDOWS_BIN_DIR:-$ROOT_DIR/.backend/freerdp/windows/bin}"

freerdp_exe=""
for candidate in wfreerdp.exe sdl3-freerdp.exe sdl2-freerdp.exe sdl-freerdp.exe; do
  if [ -f "$BIN_DIR/$candidate" ]; then
    freerdp_exe="$BIN_DIR/$candidate"
    break
  fi
done

if [ -z "$freerdp_exe" ]; then
  echo "ERROR: Missing FreeRDP Windows executable in $BIN_DIR" >&2
  echo "Expected one of: wfreerdp.exe, sdl3-freerdp.exe, sdl2-freerdp.exe, sdl-freerdp.exe." >&2
  exit 1
fi

dll_count="$(find "$BIN_DIR" -maxdepth 1 -type f -iname '*.dll' | wc -l | tr -d ' ')"
if [ "$dll_count" -lt 5 ]; then
  echo "ERROR: Only found $dll_count DLL files in $BIN_DIR." >&2
  echo "FreeRDP on Windows requires its runtime DLL dependencies beside the client executable." >&2
  exit 1
fi

echo "Windows FreeRDP resources look present:"
echo "  binary: $freerdp_exe"
echo "  dlls: $dll_count"
