'use strict';

// Generate the DSH DLE app icons from the pixel whale sprite.
// The whale is the SAME 16x16 sprite as the skin plugin (whale.ts) — the old
// 32x32 sprite was a replacement and is gone (the user's original is 16x16).
// Outputs:
//   assets/icon.ico        — multi-size ICO (16/32/48/64/128/256), packaged icon
//   assets/icon.png        — 256px PNG (window/tray icon)
//   assets/whale-pixel.png — 256px PNG source
//
// Pure Node (no sharp): nearest-neighbour scale + built-in PNG/ICO encoders.
// Usage: node scripts/generate-whale-icon.js

const path = require('node:path');
const fs = require('node:fs');
const { encodePng, icoBmpEntry, scaleNearest } = require('./icon-utils.js');

// Same sprite as the skin plugin (whale.ts), typed by the user:
// K=black outline/water, B=bright blue body, L=light belly, W=white mouth,
// '.': solid white background (white tile in both themes, matches the skin).
const SPRITE = [
  '..K...K.........',
  '.K.K.K.K........',
  '....K.....K...K.',
  '.........KBK.KBK',
  '....K....KBBKBBK',
  '..........KBBBK.',
  '..KKKKKK...KBBK.',
  '.KBBBBBBK..KBBK.',
  'KBBBBBBBBKKBBBBK',
  'KBKBBBKBBBBBBBBK',
  'KBKBBBKBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KB.....BBBBKBBK.',
  'KL......LKBBKBK.',
  '.KLLLLLLLKKBBK..',
  '..KKKKKKK..KK...',
]

// Every row must be exactly 16 cells.
for (const row of SPRITE) {
  if (row.length !== 16) throw new Error('sprite row length ' + row.length + ' != 16: "' + row + '"')
}

const PALETTE = {
  K: [0, 0, 0],
  B: [0, 0, 255],
  L: [153, 202, 255],
  W: [255, 255, 255],
  '.': [255, 255, 255], // transparent -> solid white tile
}

const N = SPRITE.length
const raw = Buffer.alloc(N * N * 4)
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const ch = SPRITE[y][x]
    const o = (y * N + x) * 4
    const c = PALETTE[ch]
    if (c) {
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255
    } else {
      raw[o + 3] = 0 // unknown glyph: transparent (should never happen)
    }
  }
}

// Classic ICO with BMP-encoded entries. Layout: ICONDIR + ALL ICONDIRENTRYs
// first, then all image data. NSIS-compatible (no PNG entries).
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: icon
  header.writeUInt16LE(count, 4);  // image count
  let offset = 6 + 16 * count;
  const entryBufs = [];
  const dataBufs = [];
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // width (0 = 256)
    e[1] = size >= 256 ? 0 : size; // height
    e[2] = 0;                      // palette
    e[3] = 0;                      // reserved
    e.writeUInt16LE(1, 4);         // planes
    e.writeUInt16LE(32, 6);        // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entryBufs.push(e);
    dataBufs.push(data);
  }
  return Buffer.concat([header, ...entryBufs, ...dataBufs]);
}

const root = path.resolve(__dirname, '..');
const sizes = [16, 32, 48, 64, 128, 256];
const icoEntries = [];
const pngEntries = [];
for (const s of sizes) {
  const scaled = scaleNearest(raw, N, N, s, s);
  icoEntries.push({ size: s, data: icoBmpEntry(scaled, s, s) });
  pngEntries.push({ size: s, png: encodePng(scaled, s, s) });
}

fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), buildIco(icoEntries));
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), pngEntries[pngEntries.length - 1].png);
fs.writeFileSync(path.join(root, 'assets', 'whale-pixel.png'), pngEntries[pngEntries.length - 1].png);
console.log('icons written: assets/icon.ico (BMP entries, ' + sizes.join('/') + '), assets/icon.png (256), assets/whale-pixel.png');
