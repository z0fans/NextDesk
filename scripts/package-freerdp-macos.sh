#!/usr/bin/env bash
# Copy the Homebrew FreeRDP SDL client into the app resource layout and rewrite
# its Homebrew dylib references so the packaged .app does not require Homebrew.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$ROOT_DIR/.backend/freerdp/macos/bin"
LIB_DIR="$OUT_DIR/lib"
FREERDP_BIN="${NEXTDESK_FREERDP_BIN:-$(command -v sdl-freerdp || true)}"

if [ -z "$FREERDP_BIN" ] || [ ! -f "$FREERDP_BIN" ]; then
  echo "ERROR: sdl-freerdp not found. Install FreeRDP or set NEXTDESK_FREERDP_BIN." >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) ;;
  *)
    echo "ERROR: macOS packaging must run on macOS." >&2
    exit 1
    ;;
esac

rm -rf "$OUT_DIR"
mkdir -p "$LIB_DIR"

cp -p "$FREERDP_BIN" "$OUT_DIR/sdl-freerdp"
chmod u+rw,go+rx "$OUT_DIR/sdl-freerdp"

is_bundle_dependency() {
  local dep="$1"
  case "$dep" in
    /opt/homebrew/*|/usr/local/*) return 0 ;;
    *) return 1 ;;
  esac
}

dependency_paths() {
  local binary="$1"
  otool -L "$binary" \
    | awk 'NR > 1 { print $1 }' \
    | while read -r dep; do
        if is_bundle_dependency "$dep"; then
          echo "$dep"
        fi
      done
}

contains_line() {
  local needle="$1"
  local file="$2"
  [ -f "$file" ] && grep -Fxq "$needle" "$file"
}

SEEN_FILE="$(mktemp)"
QUEUE_FILE="$(mktemp)"
trap 'rm -f "$SEEN_FILE" "$QUEUE_FILE"' EXIT

dependency_paths "$OUT_DIR/sdl-freerdp" > "$QUEUE_FILE"

while [ -s "$QUEUE_FILE" ]; do
  dep="$(head -n 1 "$QUEUE_FILE")"
  tail -n +2 "$QUEUE_FILE" > "$QUEUE_FILE.next"
  mv "$QUEUE_FILE.next" "$QUEUE_FILE"

  if contains_line "$dep" "$SEEN_FILE"; then
    continue
  fi
  echo "$dep" >> "$SEEN_FILE"

  if [ ! -f "$dep" ]; then
    echo "ERROR: Missing dylib dependency: $dep" >&2
    exit 1
  fi

  dep_name="$(basename "$dep")"
  cp -pL "$dep" "$LIB_DIR/$dep_name"
  chmod u+rw,go+r "$LIB_DIR/$dep_name"

  dependency_paths "$LIB_DIR/$dep_name" | while read -r nested; do
    if ! contains_line "$nested" "$SEEN_FILE"; then
      echo "$nested" >> "$QUEUE_FILE"
    fi
  done
done

rewrite_binary_refs() {
  local binary="$1"
  local prefix="$2"
  dependency_paths "$binary" | while read -r dep; do
    dep_name="$(basename "$dep")"
    if [ -f "$LIB_DIR/$dep_name" ]; then
      install_name_tool -change "$dep" "$prefix/$dep_name" "$binary"
    fi
  done
}

rewrite_binary_refs "$OUT_DIR/sdl-freerdp" "@executable_path/lib"

find "$LIB_DIR" -type f -name '*.dylib' -print | while read -r dylib; do
  dylib_name="$(basename "$dylib")"
  install_name_tool -id "@loader_path/$dylib_name" "$dylib" || true
  rewrite_binary_refs "$dylib" "@loader_path"
done

codesign --force --sign - "$OUT_DIR/sdl-freerdp" >/dev/null 2>&1 || true
find "$LIB_DIR" -type f -name '*.dylib' -print | while read -r dylib; do
  codesign --force --sign - "$dylib" >/dev/null 2>&1 || true
done

chmod -R u+rwX,go+rX "$OUT_DIR"

echo "Packaged FreeRDP for macOS:"
echo "  binary: $OUT_DIR/sdl-freerdp"
echo "  dylibs: $(find "$LIB_DIR" -type f -name '*.dylib' | wc -l | tr -d ' ')"
