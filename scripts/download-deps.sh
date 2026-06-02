#!/usr/bin/env bash
# Download mihomo binaries and geodata for the target platform.
# Usage:
#   ./scripts/download-deps.sh <target>
# Targets:
#   aarch64-apple-darwin      - macOS ARM
#   x86_64-apple-darwin       - macOS Intel
#   universal-apple-darwin    - macOS Universal (both archs)
#   x86_64-pc-windows-msvc    - Windows x64
set -euo pipefail

MIHOMO_VERSION="v1.19.21"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../.backend/bin"
mkdir -p "$BIN_DIR"
BIN_DIR="$(cd "$BIN_DIR" && pwd)"

download_mihomo() {
  local arch="$1"
  local output="$2"
  local url

  case "$arch" in
    darwin-arm64)
      url="https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-darwin-arm64-${MIHOMO_VERSION}.gz"
      echo "Downloading mihomo ${MIHOMO_VERSION} for macOS ARM64..."
      curl -fSL "$url" | gunzip > "$output"
      chmod +x "$output"
      ;;
    darwin-amd64)
      url="https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-darwin-amd64-${MIHOMO_VERSION}.gz"
      echo "Downloading mihomo ${MIHOMO_VERSION} for macOS x64..."
      curl -fSL "$url" | gunzip > "$output"
      chmod +x "$output"
      ;;
    windows-amd64)
      url="https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-windows-amd64-${MIHOMO_VERSION}.zip"
      echo "Downloading mihomo ${MIHOMO_VERSION} for Windows x64..."
      local tmpzip
      tmpzip="$(mktemp).zip"
      curl -fSL "$url" -o "$tmpzip"
      unzip -o "$tmpzip" -d "$(dirname "$tmpzip")"
      mv "$(dirname "$tmpzip")/mihomo-windows-amd64.exe" "$output"
      rm -f "$tmpzip"
      ;;
    *)
      echo "ERROR: Unknown arch: $arch" >&2
      exit 1
      ;;
  esac
  echo "  -> Saved to $output"
}

download_geodata() {
  bash "$SCRIPT_DIR/download-geodata.sh"
}

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "Usage: $0 <target>"
  echo "Targets: aarch64-apple-darwin, x86_64-apple-darwin, universal-apple-darwin, x86_64-pc-windows-msvc"
  exit 1
fi

case "$TARGET" in
  aarch64-apple-darwin)
    download_mihomo "darwin-arm64" "$BIN_DIR/nextdesk-core"
    ;;
  x86_64-apple-darwin)
    download_mihomo "darwin-amd64" "$BIN_DIR/nextdesk-core"
    ;;
  universal-apple-darwin)
    # Download both and create universal binary via lipo
    download_mihomo "darwin-arm64" "$BIN_DIR/nextdesk-core-arm64"
    download_mihomo "darwin-amd64" "$BIN_DIR/nextdesk-core-amd64"
    echo "Creating Universal Binary with lipo..."
    lipo -create "$BIN_DIR/nextdesk-core-arm64" "$BIN_DIR/nextdesk-core-amd64" \
         -output "$BIN_DIR/nextdesk-core"
    chmod +x "$BIN_DIR/nextdesk-core"
    rm -f "$BIN_DIR/nextdesk-core-arm64" "$BIN_DIR/nextdesk-core-amd64"
    echo "  -> Universal Binary saved to $BIN_DIR/nextdesk-core"
    ;;
  x86_64-pc-windows-msvc)
    download_mihomo "windows-amd64" "$BIN_DIR/nextdesk-core.exe"
    ;;
  *)
    echo "ERROR: Unsupported target: $TARGET" >&2
    exit 1
    ;;
esac

download_geodata
echo "All dependencies downloaded successfully!"
