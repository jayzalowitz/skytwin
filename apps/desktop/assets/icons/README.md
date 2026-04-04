# App Icons

Place platform-specific icons here:

- `icon.icns` — macOS (1024x1024)
- `icon.ico` — Windows (256x256)
- `256x256.png` — Linux (also used as fallback)
- `512x512.png` — Linux HiDPI

electron-builder will use these automatically based on the platform config in package.json.

To generate all sizes from a single 1024x1024 PNG source:
```bash
# macOS
iconutil -c icns icon.iconset  # requires icon.iconset directory with all sizes

# Windows (via ImageMagick)
convert icon-1024.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico

# Linux
cp icon-1024.png 512x512.png
convert icon-1024.png -resize 256x256 256x256.png
```
