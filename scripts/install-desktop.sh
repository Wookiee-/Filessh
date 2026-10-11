#!/bin/sh
# Installs the dev desktop entry so Wayland/X11 match running dev windows
# (app-id / StartupWMClass `filessh`, announced by both Electron and Tauri)
# to assets/icon.png — the same icon the AppImage ships.
# Writes only to the user's own ~/.local/share/applications.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DST="$HOME/.local/share/applications/filessh.desktop"
mkdir -p "$(dirname "$DST")"
sed "s|__REPO__|$REPO|g" "$REPO/assets/filessh.desktop" > "$DST"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$(dirname "$DST")" >/dev/null 2>&1 || true
fi
echo "installed $DST"
