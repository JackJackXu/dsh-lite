'use strict';

// Generate a 320x320 (16x16 grid, 20px cells) PNG from the whale SPRITE text,
// so the app icon and the skin whale always come from the same source.
// Pure Node (no sharp): nearest-neighbour scale + built-in PNG encoder.
// Usage: node scripts/sprite-to-png.js
// Outputs: assets/whale-source.png (then run make-icon-from-png.js on it)

const path = require('node:path');
const fs = require('node:fs');
const { encodePng, scaleNearest } = require('./icon-utils.js');

// Same sprite as the skin plugin (whale.ts), typed by the user:
// K=black outline/water, B=bright blue body, L=light belly, W=white mouth,
// '.': solid white background (the whale is a white tile in both themes).
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
  '.': [255, 255, 255], // transparent -> solid white tile (matches skin whale.ts)
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
      raw[o + 3] = 0 // unknown glyph: transparent (should never happen)
    }
  }
}

const out = path.join(__dirname, '..', 'assets', 'whale-source.png')
fs.writeFileSync(out, encodePng(scaleNearest(raw, N, N, N * CELL, N * CELL), N * CELL, N * CELL))
console.log('[ok] wrote ' + out + ' (' + (N * CELL) + 'x' + (N * CELL) + ')')
