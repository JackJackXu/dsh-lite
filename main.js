/**
 * main.js — DSH DLE (DeepSeek Harness Desktop Lite Edition)
 *
 * Design:
 *  - Thin Electron shell: uses the SYSTEM node + dsh (the same environment as
 *    the dev web profile) — no bundled runtime, no update overlay.
 *  - Shared data: DSH_HOME is NOT overridden, so the app shares ~/.dsh with
 *    the dev profile (same API key, sessions, plugins, skins).
 *  - Port: last-used port is reused when free (stable web origin), otherwise
 *    the OS assigns a free one (parsed from stdout).
 *  - Single instance: a second launch focuses the existing window.
 *  - QQ-style tray: close hides to tray; tray menu drives everything.
 *  - Logs to <dataDir>\logs\dsh-dle.log for plugin/service debugging.
 */
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog, Notification, session, powerMonitor } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

// Full product name (window title, tray tooltip, About). The short name is
// used where space is tight (notifications, log lines).
const PRODUCT_NAME = 'DeepSeek Harness Desktop - Lite Edition';
// Short name (acronym of the full name) shown in notifications and logs;
// window/tray/about use the full name.
const APP_NAME = 'DSH DLE';
// The service is started with --port 0 so the OS assigns a free port (never
// conflicts). The real URL is parsed from dsh's stdout line:
//   "dsh web: http://127.0.0.1:<port>"
// FALLBACK_PORT is used only if that line never arrives.
const FALLBACK_PORT = Number(process.env.DSH_DLE_PORT || 3081);
let dshUrl = 'http://127.0.0.1:' + FALLBACK_PORT;
const POLL_INTERVAL = 800;
const POLL_TIMEOUT = 40000;

// Shell state dir (logs, port persistence, settings). NOT used as DSH_HOME:
// the app deliberately shares ~/.dsh with the dev web profile.
const DATA_DIR = process.env.DSH_DLE_HOME || path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || '.', 'DSH DLE');
// The shared DeepSeek Harness home — never overridden, so API key, sessions,
// plugins and skins are the same ones the dev web profile uses.
const DSH_HOME = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'dsh-dle.log');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// User settings (persisted). Only notifications toggle for now.
let notificationsEnabled = true;

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (typeof s.notifications === 'boolean') notificationsEnabled = s.notifications;
  } catch (e) {
    // First run (no file) is normal; a corrupt file should not silently reset
    // the user's choices, so note it instead of swallowing it.
    if (e && e.code !== 'ENOENT') log('settings file unreadable: ' + e.message);
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ notifications: notificationsEnabled }, null, 2));
  } catch (e) { log('settings save failed: ' + (e && e.message || e)); }
}

// Bundled scripts dir (session-watcher.js, mux-watcher.js).
// Packaged builds put them OUTSIDE app.asar via extraResources so the spawned
// system node.exe can execute them as real files:
//   dev:      <project>/scripts
//   packaged: <installDir>/resources/scripts
function scriptsDir() {
  const inApp = path.join(__dirname, 'scripts');
  if (fs.existsSync(inApp)) return inApp;
  return path.join(path.dirname(__dirname), 'scripts');
}

let mainWindow = null;
let tray = null;
let dshProc = null;
// Does this shell own the running dsh process? false = reusing an external
// dsh (dev webui, another shell). Guards Restart: we must not spawn a second
// dsh writing the same ~/.dsh when we don't own the current one.
let ownsDsh = false;
let watcherProc = null;
let lastCwd = null;
let muxProc = null;
let muxUrl = '';
// Mux notification dedup: reconnect replays pending items; key -> last-seen ms.
const muxSeen = new Map();
let isQuitting = false;
let isRestarting = false;
// Live Notification handles: kept referenced so the OS never GCs a toast
// before it shows (see showNotification).
let notifications = [];

/* ---------------- logging ---------------- */
// UTF-8 BOM (0xEF 0xBB 0xBF): Windows PowerShell and Notepad decode files
// without a BOM using the legacy ANSI codepage (GBK on zh-CN systems), which
// turns UTF-8 Chinese into mojibake. Stamp the BOM on file creation so every
// reader auto-detects UTF-8; re-stamp it after the web-log truncation rewrite
// (the kept tail starts at an arbitrary byte offset, so the BOM would be lost).
const UTF8_BOM = '\uFEFF';

// Reads exactly the first 3 bytes via openSync+readSync. fs.readFileSync does
// NOT honor a {length} option (it returns the whole file), so the naive
// `fs.readFileSync(file, {length:3})` would re-read a multi-MB log on every
// write — O(n²) once the log grows. This helper is the cheap path.
function readFileHead3(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(3);
    const n = fs.readSync(fd, buf, 0, 3, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// Files already verified to carry a BOM: skip re-checking on every log write
// (a stat + 3-byte read per line is fine, but unnecessary once confirmed).
const bomVerified = new Set();

function ensureUtf8Bom(file) {
  if (bomVerified.has(file)) return;
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, UTF8_BOM);
      bomVerified.add(file);
      return;
    }
    if (fs.statSync(file).size === 0) {
      fs.writeFileSync(file, UTF8_BOM);
      bomVerified.add(file);
      return;
    }
    const head = readFileHead3(file);
    if (head.length < 3 || head[0] !== 0xef || head[1] !== 0xbb || head[2] !== 0xbf) {
      fs.writeFileSync(file, UTF8_BOM + fs.readFileSync(file).toString());
    }
    bomVerified.add(file);
  } catch { /* log dir unavailable */ }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    truncateIfLarge(LOG_FILE);
    ensureUtf8Bom(LOG_FILE);
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* log dir unavailable */ }
}

/* ---------------- system environment lookup ---------------- */
// DSH DLE uses the system Node.js and dsh installation (the same environment
// the dev web profile runs on), so data/plugins/skins are shared automatically.
function findNodeExe() {
  const candidates = [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // Fallback: search PATH for node.exe (nvm/scoop/chocolatey installs).
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const c = path.join(dir, 'node.exe');
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// The session watcher needs node:zlib zstd decompression and the mux watcher
// needs a global WebSocket. Version numbers are unreliable (zstd landed in
// 22.15, not 22.0), so probe the actual features once at boot instead of
// comparing a major version, and surface a clear warning when they're missing.
function checkNodeVersion(nodeExe) {
  return new Promise(resolve => {
    try {
      // Prints "ok" only when BOTH features exist; anything else means missing.
      const probe = "process.stdout.write(typeof require('node:zlib').zstdDecompressSync === 'function' && typeof WebSocket === 'function' ? 'ok' : 'missing')";
      const proc = spawn(nodeExe, ['-e', probe], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let done = false;
      const finish = result => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
      proc.stdout.on('data', buf => { out += buf.toString(); });
      proc.on('error', () => finish(false));
      proc.on('exit', () => finish(out.trim() === 'ok'));
      // Safety net: a hung node must not block startup forever.
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } finish(false); }, 3000);
    } catch { resolve(false); }
  });
}

// Locate the global @deepseek-ai/dsh entry across the common Node installers
// (npm, pnpm, Volta, Scoop, nvm-windows) plus a PATH fallback. The shell only
// needs the one bin.js file — the same environment the dev web profile uses.
function findDshEntry() {
  const rel = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const roots = [
    // npm default (per-user) global root: %APPDATA%\npm
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
    // pnpm global (pnpm setup): %LOCALAPPDATA%\pnpm (Windows)
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm') : null,
    // Volta global shims: %LOCALAPPDATA%\Volta\bin (Windows)
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Volta', 'bin') : null,
    // nvm-windows: %NVM_HOME%\nodejs  (the active version's install root)
    process.env.NVM_HOME ? path.join(process.env.NVM_HOME, 'nodejs') : null,
  ];
  for (const root of roots) {
    if (!root) continue;
    const c = path.join(root, rel);
    if (fs.existsSync(c)) return c;
  }
  // PATH fallback (Scoop/Chocolatey/manual installs): any dir carrying
  // node_modules/@deepseek-ai/dsh/lib/bin.js.
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const c = path.join(dir, rel);
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/* ---------------- DSH service probe (health check) ---------------- */
// Probe one URL: is a dsh web UI answering here? Timeout counts as "no".
// No byte cap: the "id="root"" marker can legally sit past 2KB in a large
// initial HTML, and truncating would mis-detect a LIVE dsh as absent (then
// spawn a duplicate). Match incrementally and finish on the first hit.
function probeUrl(url, cb) {
  let done = false;
  const once = result => {
    if (done) return;
    done = true;
    req.destroy();
    cb(result);
  };
  let body = '';
  const req = http.get(url, res => {
    res.on('data', c => {
      body += c;
      if (body.includes('id="root"') || body.includes('DeepSeek Harness')) once(true);
    });
    res.on('end', () => once(res.statusCode === 200 && (body.includes('id="root"') || body.includes('DeepSeek Harness'))));
    res.on('error', () => once(false));
  });
  req.on('error', () => once(false));
  req.setTimeout(1500, () => { req.destroy(); once(false); });
}

function probeDsh(cb) { probeUrl(dshUrl, cb); }

// Scan the ports a dsh web UI could be running on — the dev webui's default
// (3080), this shell's fallback (3081), and the port we last used — so an
// already-running dsh is REUSED instead of starting a second instance that
// writes the same ~/.dsh concurrently (corruption risk).
function findExistingDsh(cb) {
  const ports = [...new Set([
    Number(process.env.DSH_DLE_PORT) || 0,
    FALLBACK_PORT,
    readLastPort(),
    3080, // dev webui default
  ].filter(p => p > 0))];
  let i = 0;
  const tryNext = () => {
    if (i >= ports.length) { cb(null); return; }
    const url = 'http://127.0.0.1:' + ports[i];
    probeUrl(url, ok => {
      if (ok) { cb(url); return; }
      i += 1;
      tryNext();
    });
  };
  tryNext();
}

function waitForDsh(cb) {
  const start = Date.now();
  let done = false;
  const once = result => {
    if (done) return;
    done = true;
    clearInterval(timer);
    cb(result);
  };
  const timer = setInterval(() => {
    probeDsh(ok => {
      if (ok) once(true);
      else if (Date.now() - start > POLL_TIMEOUT) once(false);
    });
  }, POLL_INTERVAL);
}

/* ---------------- service lifecycle ---------------- */
// Cap logs at ~5MB (shell log and dsh-web.log): they can grow unboundedly
// over long sessions. On overflow, keep the recent half. Truncate at a
// newline boundary so no partial UTF-8 sequence or line is cut mid-way.
const WEB_LOG_LIMIT = 5 * 1024 * 1024;

function truncateIfLarge(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size <= WEB_LOG_LIMIT) return;
  const buf = fs.readFileSync(file);
  const mid = buf.length / 2;
  let start = buf.indexOf(0x0a, mid); // next newline after the midpoint
  if (start < 0) start = mid;
  fs.writeFileSync(file, UTF8_BOM + buf.subarray(start + 1).toString());
  bomVerified.add(file); // rewrite already stamped the BOM
}

function dshWebLog(data) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, 'dsh-web.log');
    truncateIfLarge(file);
    ensureUtf8Bom(file);
    fs.appendFileSync(file, data);
  } catch { /* ignore */ }
}

// Port persistence: reuse the last used port so the web origin stays stable
// (localStorage preferences like session grouping survive restarts).
const PORT_FILE = path.join(DATA_DIR, 'port.txt');

function readLastPort() {
  try { return Number(fs.readFileSync(PORT_FILE, 'utf8').trim()); } catch { return 0; }
}

function savePort(port) {
  try { fs.writeFileSync(PORT_FILE, String(port)); } catch { /* ignore */ }
}

// Port probe with an explicit three-way result:
//   false -> busy (something answered on the port)
//   true  -> free (connection refused / no listener)
//   null  -> unknown (timeout) — retry before trusting it, a firewall or a
//            half-open connection can make connect hang and "free" is wrong.
function portFree(port) {
  return new Promise(resolve => {
    let settled = false;
    const finish = v => { if (!settled) { settled = true; socket.destroy(); resolve(v); } };
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.on('connect', () => finish(false));
    socket.on('error', () => finish(true));
    socket.setTimeout(800, () => finish(null));
  });
}

// Decide the port argument: reuse lastPort when free, else let the OS pick.
async function resolvePortArg() {
  const lastPort = readLastPort();
  if (lastPort > 0) {
    // Unknown (timeout) → retry once before giving up on the last port; the
    // timeout case is rare and usually transient.
    let state = await portFree(lastPort);
    if (state === null) state = await portFree(lastPort);
    if (state === true) {
      log('reusing port ' + lastPort);
      return String(lastPort);
    }
    log('port ' + lastPort + (state === false ? ' busy' : ' unknown') + ' — falling back to random port');
  }
  return '0';
}

function startDsh(portArg) {
  const entry = findDshEntry();
  if (!entry) { log('dsh entry not found (system)'); return null; }
  const nodeExe = findNodeExe();
  if (!nodeExe) { log('node.exe not found'); return null; }
  log('starting dsh web via system node: ' + nodeExe + ' (--port ' + portArg + ')');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  // Pin DSH_HOME to the shared ~/.dsh: the shell's watchers read that exact
  // directory, so the spawned dsh must use it too. If the user's environment
  // set DSH_HOME elsewhere, the child would inherit it and diverge — pinning
  // keeps shell and service on the same data (API key, sessions, skins).
  env.DSH_HOME = DSH_HOME;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Capture stdout to parse the announced port and to persist dsh-web.log.
  const proc = spawn(nodeExe, [entry, 'web', '--port', portArg], {
    cwd: DATA_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  dshProc = proc;
  ownsDsh = true;
  proc.on('error', err => { log('dsh spawn error: ' + err.message); if (dshProc === proc) { dshProc = null; ownsDsh = false; } });
  // Line-buffered URL parsing: pipe chunks do not align to newlines, so the
  // "dsh web: http://…" line could be split across two chunks; parsing each
  // chunk alone would miss the URL (no port saved, no mux watcher, and a
  // spurious 40s startup timeout). Accumulate until the newline, then match.
  let outBuf = '';
  proc.stdout.on('data', buf => {
    const text = buf.toString();
    dshWebLog(text);
    outBuf += text;
    let nl;
    while ((nl = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, nl);
      outBuf = outBuf.slice(nl + 1);
      const m = /dsh web: (https?:\/\/127\.0\.0\.1:\d+)/.exec(line);
      if (m) {
        dshUrl = m[1];
        try {
          const port = Number(new URL(dshUrl).port);
          if (port > 0) savePort(port);
        } catch { /* ignore */ }
        log('resolved dsh url: ' + dshUrl);
        if (tray) tray.setToolTip(PRODUCT_NAME + ' — 本壳启动 dsh');
        startMuxWatcher(dshUrl.replace(/^http/, 'ws') + '/api/events.mux'); // approval/question notifications
      }
    }
  });
  proc.stderr.on('data', buf => dshWebLog(buf.toString()));
  proc.on('exit', code => {
    // Stale-exit guard: a restart kills the old process and spawns a new one;
    // the old process's async exit event must not null out the CURRENT
    // reference (or the new process would escape quitApp's tree kill).
    if (dshProc === proc) { dshProc = null; ownsDsh = false; }
    log('dsh service exited, code=' + code);
    if (!isQuitting && !isRestarting && tray) {
      tray.displayBalloon({
        title: APP_NAME,
        content: 'DSH service stopped unexpectedly (code ' + code + '). Use "Restart Service" from the tray.',
      });
    }
  });
  return proc;
}

// Kill the whole process tree: dsh spawns pwsh/agent children that would
// otherwise linger after exit. taskkill /T /F is the reliable Windows way;
// wait for it (with a kill() fallback and a timeout) so a quit never leaves
// a half-dead tree behind.
function killTree(proc, cb) {
  if (!proc || !proc.pid) { if (cb) cb(); return; }
  const pid = proc.pid;
  let done = false;
  let safetyTimer = null;
  const finish = () => {
    if (done) return;
    done = true;
    if (safetyTimer) clearTimeout(safetyTimer);
    if (cb) cb();
  };
  try {
    const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    // taskkill spawn error (unlikely) → fall back to a plain kill.
    tk.on('error', () => { try { proc.kill(); } catch { /* already dead */ } finish(); });
    tk.on('exit', () => finish());
    // Safety net: taskkill exit can be missed if the process tree is weird.
    safetyTimer = setTimeout(finish, 3000);
  } catch {
    try { proc.kill(); } catch { /* already dead */ }
    finish();
  }
}

function stopDsh(cb) {
  if (dshProc && dshProc.pid) killTree(dshProc, cb);
  else if (cb) cb();
}

function restartDsh() {
  if (isRestarting) return;
  if (!ownsDsh) {
    // Reusing an external dsh (dev webui / another shell): we must NOT spawn
    // a second instance writing the same ~/.dsh. Just reload the page and
    // tell the user the external service needs its own restart.
    log('restart requested but dsh is external — reloading window only');
    if (tray) tray.displayBalloon({
      title: APP_NAME,
      content: '当前正在使用外部 dsh 服务（非本壳启动）。已重新加载窗口；如需重启服务请在启动它的那个窗口操作。',
    });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(dshUrl);
    return;
  }
  isRestarting = true;
  if (tray) tray.setToolTip(PRODUCT_NAME + ' - restarting...');
  stopDsh(() => {
    setTimeout(async () => {
      const portArg = await resolvePortArg();
      startDsh(portArg);
      waitForDsh(ok => {
        isRestarting = false;
        if (tray) tray.setToolTip(PRODUCT_NAME);
        if (mainWindow) {
          if (ok) mainWindow.loadURL(dshUrl);
          else log('service restart timed out');
        }
      });
    }, 800);
  });
}

/* ---------------- watcher supervision ---------------- */
// Notifications are the shell's core feature; if a watcher dies (crash, dsh
// API change, transient OS error) it must come back on its own instead of
// silently killing the notifications. A generic supervisor wraps any
// restartable child: exponential backoff up to a cap, NO restart when the
// shell is quitting or the watcher was killed on purpose.
const WATCHER_MAX_RESTARTS = 5;
const watcherRestarts = new Map(); // label -> count

// Heartbeat: a watcher that is alive but hung (never exits, never emits)
// would otherwise slip past the exit-based supervision forever. Each watcher
// prints {"event":"heartbeat"} every HEARTBEAT_INTERVAL; if the main process
// sees nothing for HEARTBEAT_TIMEOUT it force-kills and restarts.
const HEARTBEAT_INTERVAL = 30 * 1000;
const HEARTBEAT_TIMEOUT = 90 * 1000;
const watcherHeartbeats = new Map(); // label -> last-heard ms
const watcherTimers = new Map(); // label -> heartbeat watchdog timer

function watchHeartbeat(label, proc) {
  watcherHeartbeats.set(label, Date.now());
  const arm = () => {
    const t = setTimeout(() => {
      const last = watcherHeartbeats.get(label) || 0;
      if (Date.now() - last > HEARTBEAT_TIMEOUT) {
        log(label + ' watcher heartbeat timeout — force restarting');
        try { proc.kill(); } catch { /* already dead */ }
        // The exit handler drives the supervised restart.
      } else {
        arm();
      }
    }, HEARTBEAT_TIMEOUT);
    watcherTimers.set(label, t);
  };
  arm();
  return () => { const t = watcherTimers.get(label); if (t) clearTimeout(t); };
}

// Call on ANY valid JSON line from a watcher: counts as liveness (resets the
// restart budget) and refreshes the heartbeat.
function watcherHealthy(label) {
  watcherHeartbeats.set(label, Date.now());
  watcherRestarts.delete(label);
}

function superviseWatcher(proc, label, restartFn) {
  const stopHeartbeat = watchHeartbeat(label, proc);
  proc.on('exit', code => {
    stopHeartbeat();
    // Stale-exit guard (the process may have been replaced already).
    if (label === 'session' && watcherProc !== proc) return;
    if (label === 'mux' && muxProc !== proc) return;
    if (label === 'session') watcherProc = null;
    if (label === 'mux') muxProc = null;
    if (isQuitting) return;
    const restarts = watcherRestarts.get(label) || 0;
    if (restarts >= WATCHER_MAX_RESTARTS) {
      log(label + ' watcher gave up after ' + restarts + ' restarts');
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, restarts), 8000);
    watcherRestarts.set(label, restarts + 1);
    log(label + ' watcher exited (code=' + code + ') — restarting in ' + delay + 'ms (#' + (restarts + 1) + ')');
    setTimeout(restartFn, delay);
  });
}

/* ---------------- session watcher (notifications + terminal dir) ---------------- */
// Runs as a standalone node process (the system node has zstd support; the
// Electron main process node does not). Prints JSON lines:
//   {"event":"turnEnd",...}  -> Windows notification
//   {"event":"session",cwd}  -> remember the latest working directory
function startSessionWatcher() {
  const nodeExe = findNodeExe();
  const watcherJs = path.join(scriptsDir(), 'session-watcher.js');
  if (!nodeExe || !fs.existsSync(watcherJs)) { log('session watcher unavailable'); return; }
  // Sessions live in the shared DSH home (~/.dsh), same as the dev web profile.
  const sessionsDir = path.join(DSH_HOME, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const proc = spawn(nodeExe, [watcherJs, '--sessions', sessionsDir], {
    cwd: DATA_DIR,
    env: Object.assign({}, process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.on('error', err => log('session watcher spawn error: ' + err.message));
  watcherProc = proc;
  // stderr: wire into the shell log so watcher-internal errors are diagnosable
  // instead of vanishing (a watcher printing to stderr without a consumer can
  // also hit backpressure and stall).
  proc.stderr.on('data', buf => log('session-watcher stderr: ' + buf.toString().trim()));
  // Line-buffered stdout parsing: pipe chunks do NOT align to newlines, so a
  // JSON line split across two chunks would otherwise be dropped (a lost
  // notification). Accumulate until the newline, then parse whole lines.
  let outBuf = '';
  proc.stdout.on('data', buf => {
    outBuf += buf.toString();
    let nl;
    while ((nl = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, nl).trim();
      outBuf = outBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event === 'heartbeat') { watcherHealthy('session'); continue; }
        watcherHealthy('session');
        if (msg.event === 'turnEnd') {
          const body = msg.title ? '任务完成：「' + msg.title + '」' : '任务完成，点击查看详情';
          showNotification(APP_NAME, body);
        } else if (msg.event === 'session' && typeof msg.cwd === 'string') {
          lastCwd = msg.cwd;
          log('session cwd: ' + lastCwd);
        }
      } catch { /* partial/corrupt line */ }
    }
  });
  superviseWatcher(proc, 'session', startSessionWatcher);
}

// One notification path for every event (task finished / approval / question).
// Windows toasts do not steal focus; falls back to a tray balloon when toasts
// are unsupported. Only notify when the user is NOT actively watching the
// window: minimized, hidden to tray, or unfocused. When the window is front
// and focused the page itself shows the result — a toast would just be noise.
function showNotification(title, body) {
  if (!notificationsEnabled) return;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    log('notify suppressed (window focused): ' + body);
    return;
  }
  log('notify: ' + body);
  if (Notification.isSupported()) {
    // Keep a reference until close: an unreferenced Notification can be GC'd
    // on some platforms before it is shown.
    const n = new Notification({ title, body });
    n.on('click', () => showWindow());
    n.on('close', () => {
      const i = notifications.indexOf(n);
      if (i >= 0) notifications.splice(i, 1);
    });
    notifications.push(n);
    n.show();
  } else if (tray) {
    tray.displayBalloon({ title, content: body });
  }
}

// Open Windows Terminal (or PowerShell fallback) in the latest session's
// working directory — modern look, not classic cmd.
function openTerminal() {
  const dir = lastCwd || DSH_HOME;
  const wt = spawn('wt.exe', ['-d', dir], { windowsHide: true, stdio: 'ignore' });
  wt.on('error', () => {
    // wt.exe missing -> PowerShell window fallback. Encode the command as
    // UTF-16LE Base64 (-EncodedCommand) so a directory containing quotes or
    // PowerShell metacharacters can never break out of the -LiteralPath arg.
    try {
      const ps = "Set-Location -LiteralPath '" + dir.replace(/'/g, "''") + "'";
      const encoded = Buffer.from(ps, 'utf16le').toString('base64');
      spawn('powershell.exe', ['-NoExit', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore' });
    } catch (e) { log('open terminal failed: ' + e.message); }
  });
}

/* ---------------- mux watcher: approval & question notifications ---------------- */
// The dsh web app exposes its mux stream over WebSocket (/api/events.mux);
// every pending approval / user question arrives there (including a replay of
// still-pending entries on connect). A standalone node process (the system
// node has global WebSocket; the Electron main process node does not) connects
// and reports attention events over stdout:
//   {"event":"attention","kind":"approval"|"question",...}
function startMuxWatcher(wsUrl) {
  // Idempotence: the URL can be announced both from stdout parsing (when this
  // shell spawns dsh) and from the reuse branch (when an external dsh is
  // already running). Only (re)start when the watcher is dead or the URL
  // changed — otherwise a duplicate spawn would pile up mux processes.
  if (muxProc && !muxProc.killed && muxUrl === wsUrl) return;
  if (muxProc && !muxProc.killed) {
    try { muxProc.kill(); } catch (e) { /* ignore */ }
  }
  muxUrl = wsUrl;
  const nodeExe = findNodeExe();
  const muxJs = path.join(scriptsDir(), 'mux-watcher.js');
  if (!nodeExe || !fs.existsSync(muxJs)) { log('mux watcher unavailable'); return; }
  const proc = spawn(nodeExe, [muxJs, '--url', wsUrl], {
    cwd: DATA_DIR,
    env: Object.assign({}, process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  muxProc = proc;
  proc.stderr.on('data', buf => log('mux: ' + buf.toString().trim()));
  // Line-buffered stdout parsing, same as the session watcher: pipe chunks do
  // not align to newlines, so accumulate until the newline before parsing.
  let outBuf = '';
  proc.stdout.on('data', buf => {
    outBuf += buf.toString();
    let nl;
    while ((nl = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, nl).trim();
      outBuf = outBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event === 'heartbeat') { watcherHealthy('mux'); continue; }
        watcherHealthy('mux');
        if (msg.event !== 'attention') continue;
        // Dedup: a mux reconnect replays still-pending approvals/questions,
        // so the same item can arrive repeatedly. Within a 10-minute window,
        // identical content only notifies once.
        const key = msg.kind === 'approval'
          ? 'a:' + (msg.toolName || '') + ':' + (msg.reason || '')
          : 'q:' + (msg.header || '') + ':' + (msg.question || '');
        const now = Date.now();
        // Prune keys older than the dedup window (10 min) so the map does not
        // grow unboundedly over months of uptime.
        if (muxSeen.size > 200) {
          for (const [k, t] of muxSeen) {
            if (now - t > 10 * 60 * 1000) muxSeen.delete(k);
          }
        }
        if (muxSeen.has(key) && now - muxSeen.get(key) < 10 * 60 * 1000) continue;
        muxSeen.set(key, now);
        if (msg.kind === 'approval') {
          const reason = msg.reason ? '（' + msg.reason + '）' : '';
          showNotification(APP_NAME, '需要你的审批：' + msg.toolName + reason);
        } else if (msg.kind === 'question') {
          const head = msg.header ? '「' + msg.header + '」' : '';
          showNotification(APP_NAME, '需要你回答' + head + '：' + (msg.question || '有一个问题等待你回答'));
        }
      } catch { /* partial/corrupt line */ }
    }
  });
  proc.on('error', err => log('mux watcher spawn error: ' + err.message));
  superviseWatcher(proc, 'mux', () => {
    if (muxUrl) startMuxWatcher(muxUrl);
  });
}

/* ---------------- paths ---------------- */
function openDataDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); shell.openPath(DATA_DIR); }
function openLogDir() { fs.mkdirSync(LOG_DIR, { recursive: true }); shell.openPath(LOG_DIR); }
function openPluginDir() {
  // Shared with the dev web profile: the plugin home is ~/.dsh\profiles\web.
  const candidates = [
    path.join(DSH_HOME, 'profiles', 'web', 'node_modules'),
    path.join(DSH_HOME, 'profiles', 'node_modules'),
    DSH_HOME,
  ];
  for (const c of candidates) if (fs.existsSync(c)) return shell.openPath(c);
  shell.openPath(DSH_HOME);
}

/* ---------------- tray ---------------- */
function loadTrayIcon() {
  const png = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(png)) {
    const img = nativeImage.createFromPath(png);
    if (!img.isEmpty()) return img;
  }
  return null;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open ' + APP_NAME, click: () => showWindow() },
    { label: 'Open Data Directory', click: openDataDir },
    { label: 'Open Log Directory', click: openLogDir },
    { type: 'separator' },
    {
      label: notificationsEnabled ? 'Notifications: On' : 'Notifications: Off',
      type: 'checkbox',
      checked: notificationsEnabled,
      click: (item) => {
        notificationsEnabled = item.checked;
        saveSettings();
        if (tray) tray.setContextMenu(buildTrayMenu());
        log('notifications ' + (notificationsEnabled ? 'enabled' : 'disabled'));
      },
    },
    { label: 'Open Terminal (session dir)', click: openTerminal },
    { label: 'Reload UI', click: () => { if (mainWindow) mainWindow.loadURL(dshUrl); } },
    { label: 'Restart DSH Service', click: restartDsh },
    { label: 'Open Plugin Directory', click: openPluginDir },
    { type: 'separator' },
    { label: 'About ' + APP_NAME, click: showAbout },
    { label: 'Quit', click: quitApp },
  ]);
}

function createTray() {
  const img = loadTrayIcon();
  tray = new Tray(img || nativeImage.createEmpty());
  tray.setToolTip(PRODUCT_NAME);
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showWindow());
}

function showAbout() {
  let version = '?';
  try {
    version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '?';
  } catch (e) { log('about: package.json unreadable: ' + (e && e.message || e)); }
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About ' + PRODUCT_NAME,
    message: PRODUCT_NAME + '\nv' + version,
    detail: 'DeepSeek Harness Desktop Lite Edition (thin Electron shell)\n\n' +
      'Shell data: ' + DATA_DIR + '\n' +
      'DSH home (shared with dev web profile): ' + DSH_HOME + '\n' +
      'URL: ' + dshUrl + '\n' +
      'Runtime: system node + dsh (no bundled runtime)\n\n' +
      'Notifications (task finished / approval / question) via built-in watchers.',
  });
}

/* ---------------- window ---------------- */
// Renderer crash self-recovery: exponential backoff reload, rebuild the
// window after too many consecutive failures, auto-reload on hang.
let crashCount = 0;
const CRASH_LIMIT = 4;

function setupCrashRecovery(win) {
  // Page load failure (service slow to answer, transient network blip): retry
  // with backoff instead of leaving a blank window; give up after a few tries.
  let loadFailCount = 0;
  const LOAD_FAIL_LIMIT = 5;
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || win.isDestroyed() || isQuitting) return;
    // code -3 (ERR_ABORTED) is a normal navigation cancellation, not a failure.
    if (code === -3) return;
    loadFailCount += 1;
    log('page load failed (' + code + ' ' + desc + ') attempt #' + loadFailCount);
    if (loadFailCount >= LOAD_FAIL_LIMIT) {
      log('page load giving up after ' + LOAD_FAIL_LIMIT + ' attempts');
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, loadFailCount - 1), 8000);
    setTimeout(() => {
      if (win.isDestroyed() || isQuitting) return;
      win.loadURL(dshUrl);
    }, delay);
  });
  // A successful load means the retry counter is stale; reset it so a later
  // transient failure still gets the full retry budget.
  win.webContents.on('did-finish-load', () => { loadFailCount = 0; crashCount = 0; });
  win.webContents.on('render-process-gone', (_e, details) => {
    log('renderer gone: ' + details.reason + ' (crash #' + (crashCount + 1) + ')');
    crashCount += 1;
    const delay = Math.min(1000 * Math.pow(2, crashCount - 1), 8000);
    setTimeout(() => {
      if (win.isDestroyed() || isQuitting) return;
      if (crashCount >= CRASH_LIMIT) {
        log('renderer crash limit reached — rebuilding window');
        crashCount = 0;
        win.destroy();
        createWindow();
      } else {
        win.loadURL(dshUrl);
      }
    }, delay);
  });
  let unresponsiveTimer = null;
  win.webContents.on('unresponsive', () => {
    // One scheduled reload at a time: repeated 'unresponsive' events would
    // otherwise pile up 5s timers.
    if (unresponsiveTimer !== null) return;
    log('renderer unresponsive — scheduling reload');
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      if (win.isDestroyed() || isQuitting) return;
      if (win.webContents.isCrashed && win.webContents.isCrashed()) return;
      win.webContents.reload();
    }, 5000);
  });
  win.webContents.on('responsive', () => {
    if (unresponsiveTimer !== null) { clearTimeout(unresponsiveTimer); unresponsiveTimer = null; }
  });
}

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: PRODUCT_NAME,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,        // renderer process sandbox (like anywhere desktop)
      webSecurity: true,    // explicit same-origin policy (default, made visible)
    },
  });

  const win = mainWindow;

  win.loadURL(dshUrl);
  setupCrashRecovery(win);

  win.on('close', e => {
    // Tray app: closing hides instead of quitting (unless actually quitting).
    // Hide the closing window itself, not the module-level mainWindow — a
    // crash rebuild may have replaced it by the time a stale close fires.
    if (!isQuitting) { e.preventDefault(); win.hide(); }
  });
  // Stale-close guard (same pattern as the subprocess exit handlers): a crash
  // rebuild destroys the old window and creates a new one; the old window's
  // async 'closed' event must not null out the NEW mainWindow reference.
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  // Keep the window title stable: dsh pages rewrite document.title on load,
  // which would overwrite the product name in the title bar.
  win.on('page-title-updated', e => e.preventDefault());
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitApp() {
  isQuitting = true;
  // Kill all children and wait for the tree kill to finish before quitting —
  // otherwise taskkill (async) races app.quit() and node.exe processes linger.
  const children = [dshProc, watcherProc, muxProc].filter(Boolean);
  if (children.length === 0) { app.quit(); return; }
  let remaining = children.length;
  const done = () => {
    remaining -= 1;
    if (remaining === 0) app.quit();
  };
  for (const p of children) killTree(p, done);
}

/* ---------------- security hardening & window health ---------------- */
// Least-privilege permissions (borrowed from bruc3van/dsh-desktop): the web UI
// only needs clipboard write + fullscreen; cameras/mics/devices are denied.
// 'notifications' is allowed so future web-side notification plugins can work
// (the shell's own notifications use Electron Notification, not this).
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'notifications']);

function installSecurityHooks() {
  try {
    session.defaultSession.setPermissionRequestHandler((_c, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_c, permission) => ALLOWED_PERMISSIONS.has(permission));
    session.defaultSession.setDevicePermissionHandler(() => false);
  } catch (e) { log('permission handler setup failed: ' + e.message); }
  // Every webContents: deny popup windows, send http(s) links to the system
  // browser, block navigation away from the dsh origin (including iframes and
  // redirects), and forbid <webview> tags (sandbox escape vector).
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const p = new URL(url);
        if (p.protocol === 'http:' || p.protocol === 'https:' || p.protocol === 'mailto:') shell.openExternal(url);
      } catch { /* malformed url */ }
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => { event.preventDefault(); });
    const guardNavigation = (event, url) => {
      // Exact origin comparison: startsWith would mis-match ports sharing a
      // prefix (127.0.0.1:6935 vs 127.0.0.1:69350).
      let actual = '';
      try { actual = new URL(url).origin; } catch { /* malformed url — deny below */ }
      const expected = (() => { try { return new URL(dshUrl).origin; } catch { return ''; } })();
      if (expected === '' || actual !== expected) event.preventDefault();
    };
    contents.on('will-frame-navigate', guardNavigation); // covers iframes
    contents.on('will-navigate', guardNavigation);       // main frame
    contents.on('will-redirect', guardNavigation);       // redirects
  });
}

// System resume / long-idle: re-check that the service is alive and the window
// shows the right URL (a blank page after sleep is a known Electron gap).
function installWakeRecovery() {
  powerMonitor.on('resume', () => {
    log('system resumed — checking window health');
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || isQuitting) return;
      probeDsh(ok => {
        if (!ok) {
          log('dsh not reachable after resume — restarting service');
          restartDsh();
        } else if (mainWindow.webContents.getURL() !== dshUrl) {
          log('window URL stale after resume — reloading');
          mainWindow.loadURL(dshUrl);
        }
      });
    }, 3000);
  });
}

/* ---------------- app lifecycle ---------------- */
// Surface unexpected main-process errors instead of dying silently — the log
// is where every other diagnostic lands. A single stray rejection is usually
// recoverable; repeated crashes mean the shell is in a bad state, so surface
// a dialog (without force-quitting: the crash-recovery already rebuilds the
// window, and the user can restart from the tray).
let uncaughtStreak = 0;
// Shared accounting for uncaught exceptions AND unhandled rejections: log
// always; after 3 in a row show a dialog (without force-quitting — the
// crash-recovery already rebuilds the window, the user can restart from tray).
function noteMainError(kind, detail) {
  try { log(kind + ': ' + detail); } catch { /* ignore */ }
  uncaughtStreak += 1;
  if (uncaughtStreak < 3) return;
  uncaughtStreak = 0;
  try {
    dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      message: 'DSH DLE 主进程连续出错',
      detail: '请从托盘菜单「重启服务」或退出后重新启动。详情见日志：' + LOG_DIR,
      buttons: ['OK'],
    });
  } catch { /* dialog unavailable */ }
}
process.on('uncaughtException', (err) => noteMainError('uncaughtException', (err && err.stack || err)));
process.on('unhandledRejection', (reason) => noteMainError('unhandledRejection', (reason instanceof Error ? reason.stack : String(reason))));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    // Windows toast notifications require an AppUserModelID; without it they
    // may not appear or may be attributed to "Electron".
    if (process.platform === 'win32') app.setAppUserModelId('com.deepseek.dshdle');
    loadSettings();
    let bootVersion = '?';
    try {
      bootVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '?';
    } catch (e) { log('boot: package.json unreadable: ' + (e && e.message || e)); }
    log('boot: ' + APP_NAME + ' v' + bootVersion);
    log('data dir: ' + DATA_DIR);
    log('fallback port: ' + FALLBACK_PORT + ' (OS-assigned real port parsed from stdout)');
    installSecurityHooks();
    installWakeRecovery();
    // Node feature gate: the watchers need zstd (node:zlib) + global
    // WebSocket. Probe the features, not the version number; when missing,
    // SKIP the watchers entirely (no point running them silently broken) and
    // say so plainly.
    const nodeExe = findNodeExe();
    const nodeOk = await checkNodeVersion(nodeExe);
    if (nodeOk) {
      startSessionWatcher();
    } else {
      log('WARNING: system Node lacks zstd/WebSocket support — notifications disabled (update Node to 22.15+)');
    }
    findExistingDsh(async foundUrl => {
      if (foundUrl) {
        // Reusing an already-running dsh (dev webui on 3080, a previous shell,
        // or our last port): the stdout URL-parser never ran, so update the
        // URL and start the mux watcher — otherwise approval/question
        // notifications would silently stay off.
        dshUrl = foundUrl;
        ownsDsh = false; // external service: Restart must not spawn a second dsh
        log('reusing existing dsh at ' + dshUrl);
        if (tray) tray.setToolTip(PRODUCT_NAME + ' — 外部 dsh (端口 ' + new URL(dshUrl).port + ')');
        startMuxWatcher(dshUrl.replace(/^http/, 'ws') + '/api/events.mux');
      } else {
        const portArg = await resolvePortArg();
        if (!startDsh(portArg)) {
          // Nothing was spawned (missing node/dsh): fail fast with an
          // actionable message instead of a 40s generic timeout.
          log('startDsh returned null — nothing spawned');
          dialog.showMessageBox({
            type: 'warning',
            title: APP_NAME,
            message: '无法启动 DSH 服务',
            detail: '未找到系统 node 或 dsh。请先安装：\n' +
              '  npm install -g @deepseek-ai/dsh\n' +
              '（需要 Node.js ≥ 22.15）\n\n' +
              '日志目录：' + LOG_DIR,
            buttons: ['OK'],
          });
        }
      }
      waitForDsh(ready => {
        if (!ready) {
          log('DSH service start timeout');
          // Never leave a blank window: tell the user what happened and how
          // to fix it instead of silently loading a dead URL.
          dialog.showMessageBox({
            type: 'warning',
            title: APP_NAME,
            message: 'DSH 服务启动超时',
            detail: '请确认系统已安装 dsh（npm install -g @deepseek-ai/dsh），\n' +
              '或查看日志：' + LOG_DIR,
            buttons: ['OK'],
          });
        }
        createWindow();
        createTray();
      });
    });
  });

  app.on('window-all-closed', () => { /* tray app */ });
  app.on('before-quit', () => { isQuitting = true; });
}
