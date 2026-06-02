#!/usr/bin/env bash
# Refresh geodata files bundled with NextDesk.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../.backend/bin"
BASE_URL="https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download"

mkdir -p "$BIN_DIR"
BIN_DIR="$(cd "$BIN_DIR" && pwd)"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

download_file() {
  local label="$1"
  local url="$2"
  local output="$3"
  local tmp="$TMP_DIR/$label"

  echo "Refreshing $label..."
  curl -fSL --retry 3 --retry-delay 2 "$url" -o "$tmp"
  mv "$tmp" "$output"
  echo "  -> Saved to $output"
}

download_file "Country.mmdb" "$BASE_URL/country-lite.mmdb" "$BIN_DIR/Country.mmdb"
download_file "geoip.metadb" "$BASE_URL/geoip-lite.metadb" "$BIN_DIR/geoip.metadb"
download_file "geosite.dat" "$BASE_URL/geosite.dat" "$BIN_DIR/geosite.dat"

echo "Geodata refreshed successfully."
