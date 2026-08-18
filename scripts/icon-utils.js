'use strict';

// Shared helpers for the dev-only icon scripts (generate-whale-icon.js,
// make-icon-from-png.js, sprite-to-png.js). These scripts are NOT shipped in
// the installer — they exist to regenerate assets/icon.ico / icon.png from the
// pixel whale sprite.

const path = require('node:path');
const fs = require('node:fs');

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

module.exports = { resolveSharp, loadSharp };
