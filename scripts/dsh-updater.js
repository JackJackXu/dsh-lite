'use strict';

// dsh kernel updater for stableDSH — overlay model.
//
// The bundled dsh (resources/dsh) is the fallback baseline. Updates are
// installed by the bundled npm into <dataDir>/agent (an "overlay") with an
// atomic staging switch:
//   1. npm install @deepseek-ai/dsh@<new> --prefix <dataDir>/agent-staging
//   2. on success: agent -> agent.old, agent-staging -> agent, delete .old
//   3. on any failure: old agent is kept / restored — zero risk
// findDshEntry() in main.js prefers <dataDir>/agent over the bundled copy.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REGISTRY_URLS = [
  'https://registry.npmjs.org/@deepseek-ai/dsh/latest',
  'https://registry.npmmirror.com/@deepseek-ai/dsh/latest',
];

/** Query npm registries for the latest published version. */
async function fetchLatestVersion() {
  for (const url of REGISTRY_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const json = await res.json();
      if (json && typeof json.version === 'string' && json.version) {
        const registry = url.replace('/@deepseek-ai/dsh/latest', '');
        return { version: json.version, registry };
      }
    } catch { /* try next registry */ }
  }
  return null;
}

/** Read the version of the dsh package whose entry is <...>/@deepseek-ai/dsh/lib/bin.js. */
function installedVersion(dshEntry) {
  try {
    const pkgFile = path.join(path.dirname(path.dirname(dshEntry)), 'package.json');
    return JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;
  } catch { return null; }
}

/** Simple semver compare (numeric dot parts). Returns 1/-1/0. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Install a dsh version into a staging dir with the bundled npm.
 * onExit receives the staging dir on success, null on failure.
 */
function installToStaging({ nodeExe, npmCli, version, registry, stagingDir, onExit }) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(stagingDir), { recursive: true });
  const args = [
    npmCli, 'install', '--prefix', stagingDir,
    '@deepseek-ai/dsh@' + version,
    '--registry', registry,
    '--no-audit', '--no-fund', '--loglevel=error',
  ];
  const proc = spawn(nodeExe, args, { windowsHide: true, stdio: 'ignore' });
  proc.on('exit', code => {
    try {
      const ok = code === 0 && fs.existsSync(path.join(stagingDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
      onExit(ok ? stagingDir : null);
    } catch { onExit(null); }
  });
  return proc;
}

/** Atomically move a successful staging dir into place; rollback on failure. */
function commitOverlay(stagingDir, agentDir) {
  try {
    const old = agentDir + '.old';
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(agentDir)) fs.renameSync(agentDir, old);
    fs.renameSync(stagingDir, agentDir);
    fs.rmSync(old, { recursive: true, force: true });
    return true;
  } catch (e) {
    try {
      if (!fs.existsSync(agentDir) && fs.existsSync(agentDir + '.old')) fs.renameSync(agentDir + '.old', agentDir);
    } catch { /* ignore */ }
    return false;
  }
}

module.exports = { fetchLatestVersion, installedVersion, compareVersions, installToStaging, commitOverlay };
