#!/usr/bin/env node

/**
 * Generates minimal placeholder icon files for electron-builder.
 *
 * Produces:
 *   assets/icon.icns   - macOS icon (minimal valid ICNS with 32x32 icon)
 *   assets/icon.ico    - Windows icon (minimal valid ICO with 32x32 icon)
 *   assets/icons/256x256.png  - Linux icon (256x256 teal square)
 *   assets/icons/512x512.png  - Linux icon (512x512 teal square)
 *
 * These are solid-color placeholders. Replace with real icons before release.
 * For production icons, use a tool like ImageMagick:
 *   convert icon-1024x1024.png -resize 256x256 assets/icons/256x256.png
 *   png2icns assets/icon.icns icon-1024x1024.png
 *   convert icon-1024x1024.png assets/icon.ico
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const ICONS_DIR = path.join(ASSETS_DIR, 'icons');

fs.mkdirSync(ICONS_DIR, { recursive: true });

// SkyTwin brand color: teal #0d9488
const R = 0x0d, G = 0x94, B = 0x88;

/**
 * Creates a minimal valid PNG file with a solid color.
 */
function createPNG(width, height) {
  // PNG signature
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 2;  // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = makeChunk('IHDR', ihdrData);

  // IDAT chunk - image data
  // Each row: filter byte (0) + RGB pixels
  const rowSize = 1 + width * 3;
  const rawData = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const offset = y * rowSize;
    rawData[offset] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const px = offset + 1 + x * 3;
      rawData[px] = R;
      rawData[px + 1] = G;
      rawData[px + 2] = B;
    }
  }
  const compressed = zlib.deflateSync(rawData);
  const idat = makeChunk('IDAT', compressed);

  // IEND chunk
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buf) {
  // Standard CRC-32 used by PNG
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Creates a minimal valid ICO file containing a single 32x32 PNG entry.
 */
function createICO(pngData) {
  // ICO header: 6 bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);    // reserved
  header.writeUInt16LE(1, 2);    // type: ICO
  header.writeUInt16LE(1, 4);    // number of images

  // ICO directory entry: 16 bytes
  const entry = Buffer.alloc(16);
  entry[0] = 32;   // width (32 = 32px; 0 would mean 256)
  entry[1] = 32;   // height
  entry[2] = 0;    // color palette
  entry[3] = 0;    // reserved
  entry.writeUInt16LE(1, 4);    // color planes
  entry.writeUInt16LE(32, 6);   // bits per pixel
  entry.writeUInt32LE(pngData.length, 8);   // image data size
  entry.writeUInt32LE(6 + 16, 12);          // offset to image data

  return Buffer.concat([header, entry, pngData]);
}

/**
 * Creates a minimal valid ICNS file containing a single icon.
 * Uses 'ic07' type (128x128 PNG).
 */
function createICNS(pngData) {
  // ICNS header
  const magic = Buffer.from('icns', 'ascii');
  // Each icon entry: 4 byte type + 4 byte size + data
  const entrySize = 8 + pngData.length;
  const totalSize = 8 + entrySize;

  const header = Buffer.alloc(8);
  magic.copy(header, 0);
  header.writeUInt32BE(totalSize, 4);

  // Icon entry header
  const entryHeader = Buffer.alloc(8);
  // 'ic07' = 128x128 PNG icon
  Buffer.from('ic07', 'ascii').copy(entryHeader, 0);
  entryHeader.writeUInt32BE(entrySize, 4);

  return Buffer.concat([header, entryHeader, pngData]);
}

// Generate PNGs
const png32 = createPNG(32, 32);
const png128 = createPNG(128, 128);
const png256 = createPNG(256, 256);
const png512 = createPNG(512, 512);

// Write Linux icons
fs.writeFileSync(path.join(ICONS_DIR, '256x256.png'), png256);
fs.writeFileSync(path.join(ICONS_DIR, '512x512.png'), png512);
console.log('Created assets/icons/256x256.png');
console.log('Created assets/icons/512x512.png');

// Write Windows ICO (contains 32x32 PNG)
const ico = createICO(png32);
fs.writeFileSync(path.join(ASSETS_DIR, 'icon.ico'), ico);
console.log('Created assets/icon.ico');

// Write macOS ICNS (contains 128x128 PNG)
const icns = createICNS(png128);
fs.writeFileSync(path.join(ASSETS_DIR, 'icon.icns'), icns);
console.log('Created assets/icon.icns');

console.log('\nPlaceholder icons generated. Replace with real icons before release.');
