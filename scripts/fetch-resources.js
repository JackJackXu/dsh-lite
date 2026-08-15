/**
 * scripts/fetch-resources.js — download bundled runtime resources for stableDSH
 *
 * Result layout (shipped inside the app via electron-builder "resources/**"):
 *   resources/node/   portable Node.js (win-x64) — node.exe + npm
 *   resources/dsh/    @deepseek-ai/dsh full install (node_modules + pnpm)
 *
 * Usage:
 *   node scripts/fetch-resources.js            # node + dsh (default)
 *   node scripts/fetch-resources.js --node-only
 *   node scripts/fetch-resources.js --dsh-only
 *
 * Mirrors (npmmirror) are used by default for speed in CN:
 *   NODE_MIRROR=https://npmmirror.com/mirrors/node
 *   REGISTRY=https://registry.npmmirror.com
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'resources');
const CACHE = path.join(ROOT, '.cache');
const NODE_VERSION = process.env.NODE_RES_VERSION || 'v24.19.0';
const NODE_ZIP = `node-${NODE_VERSION}-win-x64.zip`;
const NODE_MIRROR = process.env.NODE_MIRROR || 'https://npmmirror.com/mirrors/node';
const DSH_PKG = process.env.DSH_RES_PKG || '@deepseek-ai/dsh@0.1.0-rc.6';
const REGISTRY = process.env.REGISTRY || 'https://registry.npmmirror.com';

function log(msg) { console.log('[fetch-resources] ' + msg); }

async function download(url, dest) {
  log('downloading ' + url);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    total += value.length;
  }
  await new Promise((resolve, reject) => {
    out.end(err => (err ? reject(err) : resolve()));
  });
  log('saved ' + dest + ' (' + (total / 1048576).toFixed(1) + ' MB)');
}

function extractZip(zip, dest) {
  log('extracting ' + zip + ' -> ' + dest);
  fs.mkdirSync(dest, { recursive: true });
  const r = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -Path '${zip}' -DestinationPath '${dest}' -Force`,
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('zip extraction failed (exit ' + r.status + ')');
}

function run(cmd, args, opts) {
  log('running: ' + cmd + ' ' + args.join(' '));
  const r = spawnSync(cmd, args, Object.assign({ stdio: 'inherit', env: process.env }, opts));
  if (r.status !== 0) throw new Error('command failed (exit ' + r.status + '): ' + cmd);
}

async function fetchNode() {
  fs.mkdirSync(CACHE, { recursive: true });
  const zip = path.join(CACHE, NODE_ZIP);
  if (!fs.existsSync(zip)) await download(`${NODE_MIRROR}/${NODE_VERSION}/${NODE_ZIP}`, zip);
  else log('using cached ' + zip);
  const tmp = path.join(CACHE, 'node-extract');
  extractZip(zip, tmp);
  const inner = fs.readdirSync(tmp).find(d => d.startsWith('node-') && d.endsWith('-win-x64'));
  if (!inner) throw new Error('unexpected zip layout in ' + tmp);
  const nodeDir = path.join(RES, 'node');
  fs.rmSync(nodeDir, { recursive: true, force: true });
  fs.mkdirSync(RES, { recursive: true });
  fs.renameSync(path.join(tmp, inner), nodeDir);
  log('node ready at ' + nodeDir + ' (node.exe ' + fs.existsSync(path.join(nodeDir, 'node.exe')) + ')');
}

function fetchDsh() {
  const nodeExe = path.join(RES, 'node', 'node.exe');
  if (!fs.existsSync(nodeExe)) throw new Error('resources/node/node.exe missing - run node fetch-resources.js --node-only first');
  const npmCli = path.join(RES, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) throw new Error('npm-cli.js missing inside bundled node');
  const dshDir = path.join(RES, 'dsh');
  fs.mkdirSync(dshDir, { recursive: true });
  // dsh itself with full dependency tree
  run(nodeExe, [npmCli, 'install', '--prefix', dshDir, DSH_PKG, '--registry', REGISTRY, '--no-audit', '--no-fund']);
  const bin = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(bin)) throw new Error('bundled dsh entry missing: ' + bin);
  log('dsh ready at ' + dshDir);
  log('entry: ' + bin);
  // pnpm is NOT bundled: dsh plugin (official design) spawns "pnpm" from PATH.
  checkPnpm();
}

function checkPnpm() {
  const r = spawnSync('pnpm', ['--version'], { stdio: 'ignore' });
  if (r.error || r.status !== 0) {
    log('WARNING: pnpm not found on PATH. dsh plugin needs it (official design).');
    log('  install once:  npm i -g pnpm');
  } else {
    log('pnpm found on PATH (used by "dsh plugin ..." — no bundling needed)');
  }
}

(async () => {
  const args = process.argv.slice(2);
  const nodeOnly = args.includes('--node-only');
  const dshOnly = args.includes('--dsh-only');
  try {
    if (!dshOnly) await fetchNode();
    if (!nodeOnly) fetchDsh();
    log('done.');
    log('tip: run "scripts\\install-plugin.bat <bundle-dir>" later to install a plugin into stableDSH.');
  } catch (e) {
    console.error('[fetch-resources] FAILED: ' + e.message);
    process.exit(1);
  }
})();
