#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="RalphMenuBar"
BUILD_DIR="$SCRIPT_DIR/build"
APP_DIR="$BUILD_DIR/${APP_NAME}.app"
MACOS_DIR="$APP_DIR/Contents/MacOS"
RESOURCES_DIR="$APP_DIR/Contents/Resources"
ICON_SOURCE="$SCRIPT_DIR/branding/ralph-app-icon-concept-v3.png"
STATUS_GLYPH_SOURCE="$SCRIPT_DIR/branding/ralph-menubar-glyph-v1.png"
ICONSET_DIR="$BUILD_DIR/${APP_NAME}.iconset"
ICNS_PATH="$RESOURCES_DIR/${APP_NAME}.icns"

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

if [[ -f "$ICON_SOURCE" ]]; then
  rm -rf "$ICONSET_DIR"
  mkdir -p "$ICONSET_DIR"

  write_icon() {
    local points="$1"
    local scale="$2"
    local pixels=$((points * scale))
    local suffix=""
    if [[ "$scale" -eq 2 ]]; then
      suffix="@2x"
    fi

    sips -z "$pixels" "$pixels" "$ICON_SOURCE" \
      --out "$ICONSET_DIR/icon_${points}x${points}${suffix}.png" >/dev/null
  }

  for point_size in 16 32 128 256 512; do
    write_icon "$point_size" 1
    write_icon "$point_size" 2
  done

  iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH"
fi

if [[ -f "$STATUS_GLYPH_SOURCE" ]]; then
  cp "$STATUS_GLYPH_SOURCE" "$RESOURCES_DIR/"
fi

swiftc \
  -O \
  -framework AppKit \
  -framework SwiftUI \
  "$SCRIPT_DIR"/Sources/$APP_NAME/*.swift \
  -o "$MACOS_DIR/$APP_NAME"

cp "$SCRIPT_DIR/Info.plist" "$APP_DIR/Contents/Info.plist"

codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || true

echo "Built app: $APP_DIR"
