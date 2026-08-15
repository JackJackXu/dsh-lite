'use strict';

// Generate the stableDSH app icons from the pixel whale sprite
// (mist-blue palette, from the dsh-terminal-skin plugin).
// Outputs:
//   assets/icon.ico        — multi-size ICO (16/32/48/64/128/256), packaged icon
//   assets/icon.png        — 256px PNG (window/tray icon)
//   assets/whale-pixel.png — 256px PNG source
//
// Run with a Node that can load sharp (the bundled dsh tree ships sharp).
// Usage: node scripts/generate-whale-icon.js

const path = require('node:path');
const fs = require('node:fs');

const SHARP = 'C:/Users/XKangA/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sharp';
let sharp;
try {
  sharp = require(SHARP);
} catch (e) {
  console.error('sharp failed to load: ' + e.message);
  process.exit(1);
}

const SPRITE = [
  '..........................',
  '..........................',
  '.........DDDDDD...........',
  '.......DDBBBBBBD..........',
  '......DBBBBBBBBBBD........',
  '.....DBBBBBBBBBBBBD.......',
  '....DBBBBBBBBBBBBBBD......',
  '....DBBBBBBBBBBBBBBD......',
  '...DBBBWWWWWWWWBBBBD......',
  '...DBBWWWWWWWWWWBBBBD.....',
  '...DBWLLLLWWWWWWWBBBDD....',
  '...DBWLLLLLWWWWWWBBBD.....',
  '...DBBLLLLLLLWWWWBBBBD....',
  '...DBBBLLLLLLWWWWBBBD.....',
  '....DBBBLLLLLWWWBBBD......',
  '.....DBBBBBBBBBBBBD.......',
  '......DBBBBBBBBBBBBD......',
  '.......DDBBBBBBBBBBD......',
  '........DBBBBBBBBBBD......',
  '........DBBBBBBBBBBD......',
  '.......DBBBDDDBBBBD.......',
  '......DBBBD...DBBBD.......',
  '.....DBBBD.....DBBBD......',
  '....DBBBD.......DBBD......',
  '....DBBD.........DD.......',
  '..........................',
];

const PALETTE = { D: '#142660', B: '#4E6FFF', L: '#BEE1FF', W: '#FFFFFF' };

const W = SPRITE[0].length;
const H = SPRITE.length;

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

// RGBA raw buffer (40 x 24), transparent background
const raw = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const ch = SPRITE[y][x];
    const o = (y * W + x) * 4;
    if (PALETTE[ch]) {
      const [r, g, b] = hexToRgb(PALETTE[ch]);
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    } else {
      raw[o + 3] = 0;
    }
  }
}

async function renderPng(size) {
  return sharp(raw, { raw: { width: W, height: H, channels: 4 } })
    .resize(size, size, { fit: 'contain', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// ICO container with embedded PNG entries (Vista+ supports PNG-compressed icons).
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: icon
  header.writeUInt16LE(count, 4);  // image count
  let offset = 6 + 16 * count;
  const chunks = [header];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // width (0 = 256)
    e[1] = size >= 256 ? 0 : size; // height
    e[2] = 0;                      // palette
    e[3] = 0;                      // reserved
    e.writeUInt16LE(1, 4);         // planes
    e.writeUInt16LE(32, 6);        // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    chunks.push(e, png);
  }
  return Buffer.concat(chunks);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const sizes = [16, 32, 48, 64, 128, 256];
  const entries = [];
  for (const s of sizes) entries.push({ size: s, png: await renderPng(s) });

  fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), buildIco(entries));
  fs.writeFileSync(path.join(root, 'assets', 'icon.png'), entries[entries.length - 1].png);
  fs.writeFileSync(path.join(root, 'assets', 'whale-pixel.png'), entries[entries.length - 1].png);
  console.log('icons written: assets/icon.ico (' + sizes.join('/') + '), assets/icon.png (256), assets/whale-pixel.png');
})().catch(e => { console.error('icon generation failed: ' + e.message); process.exit(1); });
