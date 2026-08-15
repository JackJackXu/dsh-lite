/**
 * main.js — stableDSH (DeepSeek Harness desktop wrapper)
 *
 * Design:
 *  - Self-contained: prefers bundled resources (resources/node, resources/dsh),
 *    falls back to the system node/dsh when not bundled (dev mode).
 *  - Isolated data: DSH_HOME = %LOCALAPPDATA%\stableDSH (independent config,
 *    sessions, plugins — never touches the user's ~/.dsh).
 *  - Port: OS-assigned free port (--port 0, parsed from stdout); no conflicts.
 *  - Single instance: a second launch focuses the existing window.
 *  - QQ-style tray: close hides to tray; tray menu drives everything.
 *  - Logs to <dataDir>\logs\stableDSH.log for plugin/service debugging.
 */
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog, Notification } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

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

function startDsh() {
  const entry = findDshEntry();
  if (!entry) { log('dsh entry not found (bundled or system)'); return null; }
  const nodeExe = findNodeExe();
  if (!nodeExe) { log('node.exe not found'); return null; }
  const mode = entry.includes(resDir()) ? 'bundled' : 'system';
  log('starting dsh web via ' + mode + ' node: ' + nodeExe + ' (--port 0, OS-assigned)');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  env.DSH_HOME = DATA_DIR;   // isolated data directory
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Capture stdout to parse the announced port and to persist dsh-web.log.
  dshProc = spawn(nodeExe, [entry, 'web', '--port', '0'], {
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
      log('resolved dsh url: ' + dshUrl);
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
  setTimeout(() => {
    startDsh();
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
  log('task finished: ' + (msg.title || '') + ' | ' + (msg.body || ''));
  if (!mainWindow || mainWindow.isMinimized()) {
    if (Notification.isSupported()) {
      const n = new Notification({ title: msg.title || APP_NAME, body: msg.body || '' });
      n.on('click', () => showWindow());
      n.show();
    } else if (tray) {
      tray.displayBalloon({ title: msg.title || APP_NAME, content: msg.body || '' });
    }
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
      'A visual skin (mist-terminal) is developed as a DSH plugin separately.',
  });
}

/* ---------------- window ---------------- */
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
  app.quit();
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
    startSessionWatcher();
    probeDsh(ok => {
      if (!ok) startDsh();
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
