'use strict';

// Shared helpers for the dev-only icon scripts (generate-whale-icon.js,
// make-icon-from-png.js, sprite-to-png.js). These scripts are NOT shipped in
// the installer — they exist to regenerate assets/icon.ico / icon.png from the
// pixel whale sprite.
//
// PNG/ICO encoding is pure Node (node:zlib) — no sharp needed. Only
// make-icon-from-png.js (reading a user-drawn PNG) still uses sharp via
// loadSharp().

const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');

// Resolve the global sharp dynamically instead of hardcoding a developer
// username path: try require.resolve first (works when sharp is reachable),
// then probe the common npm/pnpm global roots.
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

// Load sharp or exit with a clear message (these scripts cannot work without it).
function loadSharp() {
  const sharpPath = resolveSharp();
  if (!sharpPath) {
    console.error('sharp not found — install it globally (npm i -g sharp) or add its dir to PATH');
    process.exit(1);
  }
  try {
    return require(sharpPath);
  } catch (e) {
    console.error('sharp failed to load from ' + sharpPath + ': ' + e.message);
    process.exit(1);
  }
}

// ── pure-Node PNG encoder (RGBA) ───────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode top-down RGBA rows to a PNG buffer (8-bit RGBA, no interlace). */
function encodePng(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * One classic ICO image entry: BITMAPINFOHEADER + 32bpp BGRA pixels
 * (bottom-up rows) + AND mask (all zero = fully opaque). NSIS-compatible —
 * makensis rejects PNG-compressed ICO entries.
 */
function icoBmpEntry(rgba, width, height) {
  const dib = Buffer.alloc(40);
  dib.writeInt32LE(40, 0);           // biSize
  dib.writeInt32LE(width, 4);        // biWidth
  dib.writeInt32LE(height * 2, 8);   // biHeight: XOR rows + AND mask
  dib.writeInt16LE(1, 12);           // biPlanes
  dib.writeInt16LE(32, 14);          // biBitCount
  dib.writeInt32LE(0, 16);           // biCompression: BI_RGB
  const xor = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4; // BMP stores rows bottom-up
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      xor[o] = rgba[src + x * 4 + 2];     // B
      xor[o + 1] = rgba[src + x * 4 + 1]; // G
      xor[o + 2] = rgba[src + x * 4];     // R
      xor[o + 3] = rgba[src + x * 4 + 3]; // A
    }
  }
  const andMask = Buffer.alloc(Math.ceil(width / 8) * height); // zero = opaque
  return Buffer.concat([dib, xor, andMask]);
}

/** Nearest-neighbour scale (pixel-art safe: no blurring). */
function scaleNearest(rgba, w, h, sw, sh) {
  const out = Buffer.alloc(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / sh));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / sw));
      const o = (y * sw + x) * 4;
      const s = (sy * w + sx) * 4;
      out[o] = rgba[s]; out[o + 1] = rgba[s + 1]; out[o + 2] = rgba[s + 2]; out[o + 3] = rgba[s + 3];
    }
  }
  return out;
}

module.exports = { resolveSharp, loadSharp, encodePng, icoBmpEntry, scaleNearest };
