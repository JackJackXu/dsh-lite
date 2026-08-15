'use strict';

// electron-builder afterPack hook for stableDSH.
//
// electron-builder strips nested node_modules directories when copying
// extraResources. Our bundled runtime depends on those node_modules at
// runtime:
//   resources/node   -> portable node.exe + npm CLI (npm has its own deps)
//   resources/dsh    -> @deepseek-ai/dsh full dependency tree (281MB)
// So after packaging, re-copy the whole resources/ dir verbatim into the
// packed app. Runs for both NSIS and portable targets.

const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;
  if (electronPlatformName !== 'win32') return;

  const src = path.resolve(__dirname, '..', 'resources');
  const dest = path.join(appOutDir, 'resources', 'resources');

  if (!fs.existsSync(src)) {
    console.warn('afterPack: resources/ missing — nothing to restore');
    return;
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  const files = countFiles(dest);
  console.log(`afterPack: bundled resources re-copied (${files} files, nested node_modules restored)`);
};

function countFiles(root) {
  let n = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else n++;
    }
  };
  walk(root);
  return n;
}
