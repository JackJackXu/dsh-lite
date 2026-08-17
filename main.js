/**
 * main.js — DSH Lite (DeepSeek Harness Desktop Lite Edition)
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
 *  - Logs to <dataDir>\logs\dsh-lite.log for plugin/service debugging.
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
// Short name shown in notifications and logs; window/tray/about use the full name.
const APP_NAME = 'DSH Lite';
// The service is started with --port 0 so the OS assigns a free port (never
// conflicts). The real URL is parsed from dsh's stdout line:
//   "dsh web: http://127.0.0.1:<port>"
// FALLBACK_PORT is used only if that line never arrives.
const FALLBACK_PORT = Number(process.env.STABLEDSH_PORT || 3081);
let dshUrl = 'http://127.0.0.1:' + FALLBACK_PORT;
const POLL_INTERVAL = 800;
const POLL_TIMEOUT = 40000;

// Shell state dir (logs, port persistence, settings). NOT used as DSH_HOME:
// the app deliberately shares ~/.dsh with the dev web profile.
const DATA_DIR = process.env.STABLEDSH_HOME || path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || '.', 'DSH Lite');
// The shared DeepSeek Harness home — never overridden, so API key, sessions,
// plugins and skins are the same ones the dev web profile uses.
const DSH_HOME = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'dsh-lite.log');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// User settings (persisted). Only notifications toggle for now.
let notificationsEnabled = true;

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (typeof s.notifications === 'boolean') notificationsEnabled = s.notifications;
  } catch { /* first run — defaults */ }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ notifications: notificationsEnabled }, null, 2));
  } catch { /* ignore */ }
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

/* ---------------- system environment lookup ---------------- */
// DSH Lite uses the system Node.js and dsh installation (the same environment
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

function findDshEntry() {
  const candidate = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return fs.existsSync(candidate) ? candidate : null;
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
// Cap the web log at ~5MB: dsh stdout can grow unboundedly over long sessions.
// On overflow, keep the tail half and restart — cheap rotation, no deps.
const WEB_LOG_LIMIT = 5 * 1024 * 1024;
function dshWebLog(data) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, 'dsh-web.log');
    if (fs.existsSync(file) && fs.statSync(file).size > WEB_LOG_LIMIT) {
      const buf = fs.readFileSync(file);
      const tail = buf.subarray(buf.length / 2); // keep the recent half
      fs.writeFileSync(file, tail);
    }
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
  if (!entry) { log('dsh entry not found (system)'); return null; }
  const nodeExe = findNodeExe();
  if (!nodeExe) { log('node.exe not found'); return null; }
  log('starting dsh web via system node: ' + nodeExe + ' (--port ' + portArg + ')');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  // No DSH_HOME override: share ~/.dsh with the dev web profile (API key,
  // sessions, plugins, skins). The spawned process inherits the user's PATH.
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
        if (msg.event === 'turnEnd') {
          const body = msg.title ? '任务完成：「' + msg.title + '」' : '任务完成，点击查看详情';
          showNotification(APP_NAME, body);
        } else if (msg.event === 'session' && typeof msg.cwd === 'string') {
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

// One notification path for every event (task finished / approval / question).
// Windows toasts do not steal focus; the user asked to know even with the
// window open. Falls back to a tray balloon when toasts are unsupported.
function showNotification(title, body) {
  if (!notificationsEnabled) return;
  log('notify: ' + body);
  if (Notification.isSupported()) {
    const n = new Notification({ title, body });
    n.on('click', () => showWindow());
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
    // wt.exe missing -> PowerShell window fallback
    try {
      spawn('powershell.exe', ['-NoExit', '-Command', "Set-Location -LiteralPath '" + dir + "'"], { windowsHide: true, stdio: 'ignore' });
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
  if (muxProc && !muxProc.killed) {
    try { muxProc.kill(); } catch (e) { /* ignore */ }
  }
  const nodeExe = findNodeExe();
  const muxJs = path.join(scriptsDir(), 'mux-watcher.js');
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
          showNotification(APP_NAME, '需要你的审批：' + msg.toolName + reason);
        } else if (msg.kind === 'question') {
          const head = msg.header ? '「' + msg.header + '」' : '';
          showNotification(APP_NAME, '需要你回答' + head + '：' + (msg.question || '有一个问题等待你回答'));
        }
      } catch { /* partial line */ }
    }
  });
  muxProc.on('exit', code => {
    muxProc = null;
    if (!isQuitting) log('mux watcher exited, code=' + code);
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
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About ' + PRODUCT_NAME,
    message: PRODUCT_NAME + '\nv' + pkg.version,
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

  mainWindow.loadURL(dshUrl);
  setupCrashRecovery(mainWindow);

  mainWindow.on('close', e => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  // Keep the window title stable: dsh pages rewrite document.title on load,
  // which would overwrite the product name in the title bar.
  mainWindow.on('page-title-updated', e => e.preventDefault());
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
// is where every other diagnostic lands, so route them there too.
process.on('uncaughtException', (err) => { try { log('uncaughtException: ' + (err && err.stack || err)); } catch { /* ignore */ } });
process.on('unhandledRejection', (reason) => { try { log('unhandledRejection: ' + (reason instanceof Error ? reason.stack : String(reason))); } catch { /* ignore */ } });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    // Windows toast notifications require an AppUserModelID; without it they
    // may not appear or may be attributed to "Electron".
    if (process.platform === 'win32') app.setAppUserModelId('com.deepseek.dshlite');
    loadSettings();
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    log('boot: ' + APP_NAME + ' v' + pkg.version);
    log('data dir: ' + DATA_DIR);
    log('fallback port: ' + FALLBACK_PORT + ' (OS-assigned real port parsed from stdout)');
    installSecurityHooks();
    installWakeRecovery();
    startSessionWatcher();
    probeDsh(async ok => {
      if (!ok) {
        const portArg = await resolvePortArg();
        startDsh(portArg);
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
