'use strict';

// Generate a 320x320 (16x16 grid, 20px cells) PNG from the whale SPRITE text,
// so the app icon and the skin whale always come from the same source.
// Usage: node scripts/sprite-to-png.js
// Outputs: assets/whale-source.png (then run make-icon-from-png.js on it)

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

// Same sprite as the skin plugin (whale.ts), typed by the user:
// K=black, B=blue, L=light blue, .=transparent.
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

// Every row must be exactly 16 cells; a stray character here silently shifts
// every following row. Fail loud instead.
for (const row of SPRITE) {
  if (row.length !== 16) throw new Error('sprite row length ' + row.length + ' != 16: "' + row + '"')
}

const PALETTE = {
  K: [0, 0, 0],
  B: [0, 0, 255],
  L: [153, 202, 255],
  W: [255, 255, 255],
}

const N = SPRITE.length
const CELL = 20
const raw = Buffer.alloc(N * N * 4)
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const ch = SPRITE[y][x]
    const o = (y * N + x) * 4
    const c = PALETTE[ch]
    if (c) {
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255
    } else {
      raw[o + 3] = 0
    }
  }
}

async function main() {
  const png = await sharp(raw, { raw: { width: N, height: N, channels: 4 } })
    .resize(N * CELL, N * CELL, { kernel: 'nearest' })
    .png()
    .toBuffer()
  const out = path.join(__dirname, '..', 'assets', 'whale-source.png')
  fs.writeFileSync(out, png)
  console.log('[ok] wrote ' + out + ' (' + (N * CELL) + 'x' + (N * CELL) + ')')
}

main().catch(e => { console.error('failed: ' + e.message); process.exit(1) })
