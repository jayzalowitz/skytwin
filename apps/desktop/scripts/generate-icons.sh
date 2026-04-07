#!/bin/bash
#
# generate-icons.sh — Generate placeholder icons for electron-builder
#
# Usage: ./scripts/generate-icons.sh
#
# This runs the Node.js icon generator which creates minimal valid
# placeholder icon files (PNG, ICO, ICNS) so electron-builder can
# produce builds for all platforms.
#
# For production-quality icons, replace the generated files with real
# artwork. If you have ImageMagick installed, you can convert from a
# high-res source:
#
#   convert source-1024x1024.png -resize 256x256 assets/icons/256x256.png
#   convert source-1024x1024.png -resize 512x512 assets/icons/512x512.png
#   convert source-1024x1024.png assets/icon.ico
#   png2icns assets/icon.icns source-1024x1024.png
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/generate-icons.js"
