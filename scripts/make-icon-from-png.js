'use strict';

// Generate DSH DLE icons from a user-drawn pixel-art PNG.
//
// The source is a square grid scaled 20x (16x16 = 320x320, 32x32 = 640x640).
// This script:
//   1. downsamples to an NxN grid (majority color per cell),
//   2. turns the outer white background transparent (flood fill from edges;
//      interior whites such as the mouth are kept),
//   3. renders 256px PNG + multi-size ICO.
//
// Usage: node scripts/make-icon-from-png.js <source.png>
// Outputs: assets/icon.ico, assets/icon.png, assets/whale-pixel.png

const path = require('node:path');
const fs = require('node:fs');

// Resolve the global sharp dynamically instead of hardcoding a developer
// username path: try require.resolve first (works when sharp is reachable),
// then probe the common npm/pnpm global roots, then PATH.
function resolveSharp() {
  try {
    return require.resolve('sharp');
  } catch { /* not on this module's resolution path */ }
  const rel = path.join('node_modules', 'sharp');
  const roots = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm') : null,
  ];
  for (const root of roots) {
    if (!root) continue;
    const c = path.join(root, rel);
    if (fs.existsSync(c)) return c;
  }
  return null;
}
const sharpPath = resolveSharp();
let sharp;
if (!sharpPath) {
  console.error('sharp not found — install it globally (npm i -g sharp) or add its dir to PATH');
  process.exit(1);
}
try {
  sharp = require(sharpPath);
} catch (e) {
  console.error('sharp failed to load from ' + sharpPath + ': ' + e.message);
  process.exit(1);
}

// User's palette: K=black outline/water, B=bright blue body, L=light belly,
// W=white (kept for interior whites). 'T' is transparent.
const PALETTE = { K: [0, 0, 0], B: [0, 0, 255], L: [153, 202, 255], W: [255, 255, 255] };

function quantize(r, g, b) {
  if (r > 245 && g > 245 && b > 245) return 'W';
  let best = '?', bestD = 1e9;
  for (const [k, [pr, pg, pb]] of Object.entries(PALETTE)) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD > 12000 ? '?' : best;
}

async function extractGrid(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  // Grid size: prefer the user's 16x16 source; fall back to 32x32 for the
  // older 640px sources. 320px is only 16x16 (16*20), 640px is 32x32.
  const N = W === 320 ? 16 : 32;
  const CELL = Math.round(W / N);
  if (W % N !== 0) console.warn('width ' + W + ' not a multiple of ' + N + '; cell=' + CELL);
  const grid = [];
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const counts = new Map();
      for (let y = gy * CELL; y < Math.min((gy + 1) * CELL, H); y++) {
        for (let x = gx * CELL; x < Math.min((gx + 1) * CELL, W); x++) {
          const i = (y * W + x) * 4;
          const a = info.channels > 3 ? data[i + 3] : 255;
          if (a < 128) { counts.set('T', (counts.get('T') || 0) + 1); continue; }
          const k = quantize(data[i], data[i + 1], data[i + 2]);
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
      let best = '?', bestN = 0;
      for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
      grid.push(best);
    }
  }
  return grid;
}

// Flood fill from the border: any 'W' reachable from the edge becomes
// transparent background ('T'); interior whites (mouth) stay 'W'.
function transparentizeBackground(grid, N) {
  const out = grid.slice();
  const isBg = new Array(N * N).fill(false);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    const i = y * N + x;
    if (isBg[i] || out[i] !== 'W') return;
    isBg[i] = true;
    stack.push(i);
  };
  for (let x = 0; x < N; x++) { push(x, 0); push(x, N - 1); }
  for (let y = 0; y < N; y++) { push(0, y); push(N - 1, y); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % N, y = Math.floor(i / N);
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  for (let i = 0; i < N * N; i++) if (isBg[i]) out[i] = 'T';
  return out;
}

function gridToRaw(grid, N) {
  const raw = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const ch = grid[y * N + x];
      const o = (y * N + x) * 4;
      const c = PALETTE[ch];
      if (c) {
        raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
      } else {
        raw[o + 3] = 0;
      }
    }
  }
  return raw;
}

async function renderPng(raw, N, size) {
  return sharp(raw, { raw: { width: N, height: N, channels: 4 } })
    .resize(size, size, { kernel: 'nearest' })
    .png()
    .toBuffer();
}

// Render one size as a classic BMP-encoded ICO entry (NSIS-compatible; PNG
// entries inside ICO are rejected by makensis with "invalid icon file size").
// sharp has no BMP output, so the DIB is written by hand from raw RGBA.
async function renderIcoEntry(raw, N, size) {
  const rgba = await sharp(raw, { raw: { width: N, height: N, channels: 4 } })
    .resize(size, size, { kernel: 'nearest' })
    .raw()
    .toBuffer();
  return dibFromRgba(rgba, size);
}

function dibFromRgba(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);      // biSize
  header.writeInt32LE(size, 4);     // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR + AND mask)
  header.writeUInt16LE(1, 12);      // biPlanes
  header.writeUInt16LE(32, 14);     // biBitCount
  // Pixel rows: bottom-up, BGRA, 32bpp (size*4 per row is already aligned).
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const si = (srcY * size + x) * 4;
      const di = (y * size + x) * 4;
      pixels[di] = rgba[si + 2];     // B
      pixels[di + 1] = rgba[si + 1]; // G
      pixels[di + 2] = rgba[si];     // R
      pixels[di + 3] = rgba[si + 3]; // A
    }
  }
  // AND mask: 1-bit transparent for fully-transparent pixels (MSB first).
  const andRowBytes = Math.ceil(size / 8);
  const andMask = Buffer.alloc(andRowBytes * size);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      if (rgba[(srcY * size + x) * 4 + 3] === 0) {
        andMask[y * andRowBytes + Math.floor(x / 8)] |= (0x80 >> (x % 8));
      }
    }
  }
  return Buffer.concat([header, pixels, andMask]);
}

// Classic ICO container with BMP-encoded entries. Layout: ICONDIR + ALL
// ICONDIRENTRYs first, then all image data (each entry's offset points here).
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = 6 + 16 * count;
  const entryBufs = [];
  const dataBufs = [];
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entryBufs.push(e);
    dataBufs.push(data);
  }
  return Buffer.concat([header, ...entryBufs, ...dataBufs]);
}

(async () => {
  const src = process.argv[2];
  if (!src) { console.error('usage: node make-icon-from-png.js <source.png>'); process.exit(1); }
  let grid = await extractGrid(src);
  const N = Math.round(Math.sqrt(grid.length));
  grid = transparentizeBackground(grid, N);

  // ASCII preview of the result (T=transparent)
  const map = { K: '#', B: 'O', L: '.', W: 'w', '?': '?', T: ' ' };
  console.log('--- extracted ' + N + 'x' + N + ' grid (after background removal) ---');
  for (let y = 0; y < N; y++) {
    console.log(grid.slice(y * N, (y + 1) * N).map(c => map[c] || '?').join(''));
  }

  const raw = gridToRaw(grid, N);
  const root = path.resolve(__dirname, '..');
  const sizes = [16, 32, 48, 64, 128, 256];
  const icoEntries = [];
  const pngEntries = [];
  for (const s of sizes) {
    icoEntries.push({ size: s, data: await renderIcoEntry(raw, N, s) });
    pngEntries.push({ size: s, png: await renderPng(raw, N, s) });
  }
  fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), buildIco(icoEntries));
  fs.writeFileSync(path.join(root, 'assets', 'icon.png'), pngEntries[pngEntries.length - 1].png);
  fs.writeFileSync(path.join(root, 'assets', 'whale-pixel.png'), pngEntries[pngEntries.length - 1].png);
  console.log('icons written: assets/icon.ico (BMP entries, ' + sizes.join('/') + '), assets/icon.png (256), assets/whale-pixel.png');
})().catch(e => { console.error('failed: ' + e.message); process.exit(1); });
