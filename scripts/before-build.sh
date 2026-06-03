#!/usr/bin/env bash
# Prepare platform resources before Tauri bundles the application.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

bash "$SCRIPT_DIR/download-geodata.sh"

case "$(uname -s)" in
  Darwin)
    bash "$SCRIPT_DIR/package-freerdp-macos.sh"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    bash "$SCRIPT_DIR/verify-freerdp-windows.sh"
    ;;
  *)
    echo "Skipping FreeRDP resource preparation for unsupported build host: $(uname -s)"
    ;;
esac
