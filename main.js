/**
 * main.js — stableDSH (DeepSeek Harness desktop wrapper)
 *
 * Design:
 *  - Self-contained: prefers bundled resources (resources/node, resources/dsh),
 *    falls back to the system node/dsh when not bundled (dev mode).
 *  - Isolated data: DSH_HOME = %LOCALAPPDATA%\stableDSH (independent config,
 *    sessions, plugins — never touches the user's ~/.dsh).
 *  - Port: last-used port is reused when free (stable web origin), otherwise
 *    the OS assigns a free one (parsed from stdout).
 *  - Single instance: a second launch focuses the existing window.
 *  - QQ-style tray: close hides to tray; tray menu drives everything.
 *  - Logs to <dataDir>\logs\stableDSH.log for plugin/service debugging.
 */
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog, Notification, session, powerMonitor } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const updater = require('./scripts/dsh-updater.js');

const APP_NAME = 'stableDSH';
// The service is started with --port 0 so the OS assigns a free port (never
// conflicts). The real URL is parsed from dsh's stdout line:
//   "dsh web: http://127.0.0.1:<port>"
// FALLBACK_PORT is used only if that line never arrives.
const FALLBACK_PORT = Number(process.env.STABLEDSH_PORT || 3081);
let dshUrl = 'http://127.0.0.1:' + FALLBACK_PORT;
const POLL_INTERVAL = 800;
const POLL_TIMEOUT = 40000;

// Isolated data directory (DSH_HOME). Never touches ~/.dsh.
const DATA_DIR = process.env.STABLEDSH_HOME || path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || '.', APP_NAME);
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'stableDSH.log');

// Bundled runtime dir (resources/). Packaged builds put it OUTSIDE app.asar via
// extraResources so the spawned system node.exe can run real files:
//   dev:      <project>/resources
//   packaged: <installDir>/resources/resources   (__dirname = .../resources/app.asar)
function resDir() {
  const inApp = path.join(__dirname, 'resources');
  if (fs.existsSync(inApp)) return inApp;
  return path.join(path.dirname(__dirname), 'resources');
}

let mainWindow = null;
let tray = null;
let dshProc = null;
let watcherProc = null;
let lastCwd = null;
let muxProc = null;
let isQuitting = false;
let isRestarting = false;

/* ---------------- logging ---------------- */
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* log dir unavailable */ }
}

/* ---------------- bundled vs system environment ---------------- */
function findNodeExe() {
  const builtin = path.join(resDir(), 'node', 'node.exe');
  if (fs.existsSync(builtin)) return builtin;
  const candidates = [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function findDshEntry() {
  // Update overlay first (dsh kernel updates install here), then bundled, then system.
  const overlay = path.join(DATA_DIR, 'agent', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(overlay)) return overlay;
  const builtin = path.join(resDir(), 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(builtin)) return builtin;
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/* ---------------- DSH service probe (health check) ---------------- */
function probeDsh(cb) {
  const req = http.get(dshUrl, res => {
    let body = '';
    res.on('data', c => {
      body += c;
      if (body.length > 2000) req.destroy();
    });
    res.on('end', () => cb(res.statusCode === 200 && (body.includes('id="root"') || body.includes('DeepSeek Harness'))));
    res.on('error', () => cb(false));
  });
  req.on('error', () => cb(false));
  req.setTimeout(1500, () => { req.destroy(); cb(false); });
}

function waitForDsh(cb) {
  const start = Date.now();
  const timer = setInterval(() => {
    probeDsh(ok => {
      if (ok) { clearInterval(timer); cb(true); }
      else if (Date.now() - start > POLL_TIMEOUT) { clearInterval(timer); cb(false); }
    });
  }, POLL_INTERVAL);
}

/* ---------------- service lifecycle ---------------- */
function dshWebLog(data) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'dsh-web.log'), data);
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

function portFree(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(true));
    socket.setTimeout(800, () => { socket.destroy(); resolve(true); });
  });
}

// Decide the port argument: reuse lastPort when free, else let the OS pick.
async function resolvePortArg() {
  const lastPort = readLastPort();
  if (lastPort > 0) {
    if (await portFree(lastPort)) {
      log('reusing port ' + lastPort);
      return String(lastPort);
    }
    log('port ' + lastPort + ' busy — falling back to random port');
  }
  return '0';
}

function startDsh(portArg) {
  const entry = findDshEntry();
  if (!entry) { log('dsh entry not found (bundled or system)'); return null; }
  const nodeExe = findNodeExe();
  if (!nodeExe) { log('node.exe not found'); return null; }
  const mode = entry.includes(resDir()) ? 'bundled' : 'system';
  log('starting dsh web via ' + mode + ' node: ' + nodeExe + ' (--port ' + portArg + ')');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  env.DSH_HOME = DATA_DIR;   // isolated data directory
  // Make the bundled node available to the agent: append (never prepend) the
  // bundled node dir to PATH, so a machine without Node still lets the agent
  // run `node`/`npm`, while a machine with its own Node keeps using it.
  const bundledNodeDir = path.join(resDir(), 'node');
  if (fs.existsSync(path.join(bundledNodeDir, 'node.exe')) && !(env.PATH || '').split(path.delimiter).includes(bundledNodeDir)) {
    env.PATH = env.PATH ? env.PATH + path.delimiter + bundledNodeDir : bundledNodeDir;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Capture stdout to parse the announced port and to persist dsh-web.log.
  dshProc = spawn(nodeExe, [entry, 'web', '--port', portArg], {
    cwd: DATA_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  dshProc.stdout.on('data', buf => {
    const text = buf.toString();
    dshWebLog(text);
    const m = /dsh web: (https?:\/\/127\.0\.0\.1:\d+)/.exec(text);
    if (m) {
      dshUrl = m[1];
      try {
        const port = Number(new URL(dshUrl).port);
        if (port > 0) savePort(port);
      } catch { /* ignore */ }
      log('resolved dsh url: ' + dshUrl);
      startMuxWatcher(dshUrl.replace(/^http/, 'ws') + '/api/events.mux'); // approval/question notifications
    }
  });
  dshProc.stderr.on('data', buf => dshWebLog(buf.toString()));
  dshProc.on('exit', code => {
    log('dsh service exited, code=' + code);
    dshProc = null;
    if (!isQuitting && !isRestarting && tray) {
      tray.displayBalloon({
        title: APP_NAME,
        content: 'DSH service stopped unexpectedly (code ' + code + '). Use "Restart Service" from the tray.',
      });
    }
  });
  return dshProc;
}

// Kill the whole process tree: dsh spawns pwsh/agent children that would
// otherwise linger after exit.
function stopDsh() {
  if (dshProc && dshProc.pid) {
    try {
      spawn('taskkill', ['/PID', String(dshProc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      try { dshProc.kill(); } catch (x) { /* ignore */ }
    }
  }
}

function restartDsh() {
  if (isRestarting) return;
  isRestarting = true;
  if (tray) tray.setToolTip(APP_NAME + ' - restarting...');
  stopDsh();
  setTimeout(async () => {
    const portArg = await resolvePortArg();
    startDsh(portArg);
    waitForDsh(ok => {
      isRestarting = false;
      if (tray) tray.setToolTip(APP_NAME);
      if (mainWindow) {
        if (ok) mainWindow.loadURL(dshUrl);
        else log('service restart timed out');
      }
    });
  }, 800);
}

/* ---------------- session watcher (notifications + terminal dir) ---------------- */
// Runs as a standalone node process (bundled node has zstd support; the
// Electron main process node does not). Prints JSON lines:
//   {"event":"turnEnd",...}  -> Windows notification
//   {"event":"session",cwd}  -> remember the latest working directory
function startSessionWatcher() {
  const nodeExe = findNodeExe();
  const watcherJs = path.join(__dirname, 'scripts', 'session-watcher.js');
  if (!nodeExe || !fs.existsSync(watcherJs)) { log('session watcher unavailable'); return; }
  const sessionsDir = path.join(DATA_DIR, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  watcherProc = spawn(nodeExe, [watcherJs, '--sessions', sessionsDir], {
    cwd: DATA_DIR,
    env: Object.assign({}, process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  watcherProc.stdout.on('data', buf => {
    for (const line of buf.toString().split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event === 'turnEnd') notifyTurnEnd(msg);
        else if (msg.event === 'session' && typeof msg.cwd === 'string') {
          lastCwd = msg.cwd;
          log('session cwd: ' + lastCwd);
        }
      } catch { /* partial line */ }
    }
  });
  watcherProc.on('exit', code => {
    watcherProc = null;
    if (!isQuitting) log('session watcher exited, code=' + code);
  });
}

function notifyTurnEnd(msg) {
  const body = msg.title ? '任务完成：「' + msg.title + '」' : '任务完成，点击查看详情';
  log('task finished: ' + body);
  // Always notify: Windows toasts do not steal focus; the user asked to know
  // when a task finishes even with the window open.
  if (Notification.isSupported()) {
    const n = new Notification({ title: APP_NAME, body });
    n.on('click', () => showWindow());
    n.show();
  } else if (tray) {
    tray.displayBalloon({ title: APP_NAME, content: body });
  }
}

// Open Windows Terminal (or PowerShell fallback) in the latest session's
// working directory — modern look, not classic cmd.
function openTerminal() {
  const dir = lastCwd || DATA_DIR;
  const wt = spawn('wt.exe', ['-d', dir], { windowsHide: true, stdio: 'ignore' });
  wt.on('error', () => {
    // wt.exe missing -> PowerShell window fallback
    try {
      spawn('powershell.exe', ['-NoExit', '-Command', "Set-Location -LiteralPath '" + dir + "'"], { windowsHide: true, stdio: 'ignore' });
    } catch (e) { log('open terminal failed: ' + e.message); }
  });
}

/* ---------------- mux watcher: approval & question notifications ---------------- */
// The dsh web app exposes its mux stream over WebSocket (/api/events.mux);
// every pending approval / user question arrives there (including a replay of
// still-pending entries on connect). A standalone node process (bundled node
// has global WebSocket; the Electron main process node does not) connects and
// reports attention events over stdout:
//   {"event":"attention","kind":"approval"|"question",...}
function notifyAttention(body) {
  log('attention: ' + body);
  if (Notification.isSupported()) {
    const n = new Notification({ title: APP_NAME, body: body || '' });
    n.on('click', () => showWindow());
    n.show();
  } else if (tray) {
    tray.displayBalloon({ title: APP_NAME, content: body || '' });
  }
}

function startMuxWatcher(wsUrl) {
  if (muxProc && !muxProc.killed) {
    try { muxProc.kill(); } catch (e) { /* ignore */ }
  }
  const nodeExe = findNodeExe();
  const muxJs = path.join(__dirname, 'scripts', 'mux-watcher.js');
  if (!nodeExe || !fs.existsSync(muxJs)) { log('mux watcher unavailable'); return; }
  muxProc = spawn(nodeExe, [muxJs, '--url', wsUrl], {
    cwd: DATA_DIR,
    env: Object.assign({}, process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  muxProc.stderr.on('data', buf => log('mux: ' + buf.toString().trim()));
  muxProc.stdout.on('data', buf => {
    for (const line of buf.toString().split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event !== 'attention') continue;
        if (msg.kind === 'approval') {
          const reason = msg.reason ? '（' + msg.reason + '）' : '';
          notifyAttention('需要你的审批：' + msg.toolName + reason);
        } else if (msg.kind === 'question') {
          const head = msg.header ? '「' + msg.header + '」' : '';
          notifyAttention('需要你回答' + head + '：' + (msg.question || '有一个问题等待你回答'));
        }
      } catch { /* partial line */ }
    }
  });
  muxProc.on('exit', code => {
    muxProc = null;
    if (!isQuitting) log('mux watcher exited, code=' + code);
  });
}

/* ---------------- dsh kernel updates (overlay) ---------------- */
function currentDshVersion() {
  const entry = findDshEntry();
  return entry ? updater.installedVersion(entry) : null;
}

// Check for a newer @deepseek-ai/dsh on npm. silent: only report problems when
// the user asked manually. Returns after prompting/installing.
async function checkDshUpdates(silent) {
  const latest = await updater.fetchLatestVersion();
  if (!latest) {
    if (!silent) dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Check Updates', message: 'Could not reach npm registry.' });
    return;
  }
  const current = currentDshVersion();
  if (current && updater.compareVersions(latest.version, current) <= 0) {
    if (!silent) dialog.showMessageBox(mainWindow, { type: 'info', title: 'Check Updates', message: APP_NAME + ' is up to date (dsh ' + current + ').' });
    return;
  }
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'dsh Update Available',
    message: 'New dsh version: ' + latest.version + (current ? ' (current ' + current + ')' : ''),
    detail: 'Install now? The update is installed into your data directory and the old version is kept as a fallback.',
    buttons: ['Update Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (r.response === 0) await runDshUpdate(latest);
}

async function runDshUpdate(latest) {
  const nodeExe = findNodeExe();
  const npmCli = path.join(resDir(), 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!nodeExe || !fs.existsSync(npmCli)) {
    dialog.showMessageBox(mainWindow, { type: 'error', title: 'Update Failed', message: 'Bundled npm not found.' });
    return;
  }
  const stagingDir = path.join(DATA_DIR, 'agent-staging');
  const agentDir = path.join(DATA_DIR, 'agent');
  log('dsh update: installing ' + latest.version + ' to staging...');
  const installed = await new Promise(resolve => {
    updater.installToStaging({ nodeExe, npmCli, version: latest.version, registry: latest.registry, stagingDir, onExit: resolve });
  });
  if (!installed) {
    log('dsh update: install failed (old version kept)');
    dialog.showMessageBox(mainWindow, { type: 'error', title: 'Update Failed', message: 'Install failed. The previous version is kept.' });
    return;
  }
  if (!updater.commitOverlay(stagingDir, agentDir)) {
    log('dsh update: commit failed (rolled back)');
    dialog.showMessageBox(mainWindow, { type: 'error', title: 'Update Failed', message: 'Could not activate the update. Rolled back to the previous version.' });
    return;
  }
  log('dsh update: activated ' + latest.version + ' (overlay)');
  const rr = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: 'dsh ' + latest.version + ' installed.',
    detail: 'Restart the DSH service to use it.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (rr.response === 0) restartDsh();
}

/* ---------------- paths ---------------- */
function openDataDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); shell.openPath(DATA_DIR); }
function openLogDir() { fs.mkdirSync(LOG_DIR, { recursive: true }); shell.openPath(LOG_DIR); }
function openPluginDir() {
  const candidates = [
    path.join(DATA_DIR, 'profiles', 'web', 'node_modules'),
    path.join(DATA_DIR, 'profiles', 'node_modules'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return shell.openPath(c);
  shell.openPath(DATA_DIR);
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

function createTray() {
  const img = loadTrayIcon();
  tray = new Tray(img || nativeImage.createEmpty());
  tray.setToolTip(APP_NAME);
  const menu = Menu.buildFromTemplate([
    { label: 'Open ' + APP_NAME, click: () => showWindow() },
    { label: 'Open Data Directory', click: openDataDir },
    { label: 'Open Log Directory', click: openLogDir },
    { type: 'separator' },
    { label: 'Check for dsh Updates', click: () => checkDshUpdates(false) },
    { label: 'Open Terminal (session dir)', click: openTerminal },
    { label: 'Reload UI', click: () => { if (mainWindow) mainWindow.loadURL(dshUrl); } },
    { label: 'Restart DSH Service', click: restartDsh },
    { label: 'Open Plugin Directory', click: openPluginDir },
    { type: 'separator' },
    { label: 'About ' + APP_NAME, click: showAbout },
    { label: 'Quit', click: quitApp },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showWindow());
}

function showAbout() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About ' + APP_NAME,
    message: APP_NAME + ' ' + pkg.version,
    detail: 'DeepSeek Harness desktop wrapper (self-contained)\n\n' +
      'Data: ' + DATA_DIR + '\n' +
      'URL: ' + dshUrl + '\n' +
      'Mode: ' + (findDshEntry()?.includes(resDir()) ? 'bundled' : 'system') + '\n\n' +
      'Notifications (task finished / approval / question) via built-in watchers.',
  });
}

/* ---------------- window ---------------- */
// Renderer crash self-recovery: exponential backoff reload, rebuild the
// window after too many consecutive failures, auto-reload on hang.
let crashCount = 0;
const CRASH_LIMIT = 4;

function setupCrashRecovery(win) {
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
  win.webContents.on('unresponsive', () => {
    log('renderer unresponsive — scheduling reload');
    setTimeout(() => {
      if (win.isDestroyed() || isQuitting) return;
      if (win.webContents.isCrashed && win.webContents.isCrashed()) return;
      win.webContents.reload();
    }, 5000);
  });
  win.webContents.on('responsive', () => { /* recovered */ });
}

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#1a1a1a',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  mainWindow.loadURL(dshUrl);
  setupCrashRecovery(mainWindow);

  mainWindow.on('close', e => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitApp() {
  isQuitting = true;
  stopDsh();
  if (watcherProc && !watcherProc.killed) {
    try { watcherProc.kill(); } catch (e) { /* ignore */ }
  }
  if (muxProc && !muxProc.killed) {
    try { muxProc.kill(); } catch (e) { /* ignore */ }
  }
  app.quit();
}

/* ---------------- security hardening & window health ---------------- */
// Least-privilege permissions (borrowed from bruc3van/dsh-desktop): the web UI
// only needs clipboard write + fullscreen; cameras/mics/devices are denied.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

function installSecurityHooks() {
  try {
    session.defaultSession.setPermissionRequestHandler((_c, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_c, permission) => ALLOWED_PERMISSIONS.has(permission));
    session.defaultSession.setDevicePermissionHandler(() => false);
  } catch (e) { log('permission handler setup failed: ' + e.message); }
  // Every webContents: deny popup windows, send http(s) links to the system
  // browser, block navigation away from the dsh origin.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const p = new URL(url);
        if (p.protocol === 'http:' || p.protocol === 'https:') shell.openExternal(url);
      } catch { /* malformed url */ }
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      const origin = (() => { try { return new URL(dshUrl).origin; } catch { return ''; } })();
      if (origin === '' || !url.startsWith(origin)) event.preventDefault();
    });
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
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    log('boot: ' + APP_NAME + ' v' + pkg.version);
    log('data dir: ' + DATA_DIR);
    log('fallback port: ' + FALLBACK_PORT + ' (OS-assigned real port parsed from stdout)');
    installSecurityHooks();
    installWakeRecovery();
    startSessionWatcher();
    // Auto-check for dsh kernel updates shortly after boot (silent; prompts only when newer).
    setTimeout(() => { checkDshUpdates(true); }, 15000);
    probeDsh(async ok => {
      if (!ok) {
        const portArg = await resolvePortArg();
        startDsh(portArg);
      }
      waitForDsh(ready => {
        if (!ready) log('DSH service start timeout');
        createWindow();
        createTray();
      });
    });
  });

  app.on('window-all-closed', () => { /* tray app */ });
  app.on('before-quit', () => { isQuitting = true; });
}
