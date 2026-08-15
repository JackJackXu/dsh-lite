#!/usr/bin/env node
'use strict';

// stableDSH mux watcher — standalone node process (Node >= 22 has global
// WebSocket; the bundled node.exe is v24).
//
// Connects to the dsh web app's mux stream (WebSocket upgrade on
// /api/events.mux) and prints one JSON line per pending human-interaction
// event:
//   {"event":"attention","kind":"approval","toolName":...,"reason":...}
//   {"event":"attention","kind":"question","header":...,"question":...}
// The Electron main process turns these into Windows notifications.
//
// Connection failures are retried silently (no stdout noise); the main
// process re-spawns this script when the service restarts on a new port.

const args = process.argv.slice(2);
const idx = args.indexOf('--url');
const url = idx >= 0 ? args[idx + 1] : null;
if (!url) {
  process.stderr.write('usage: node mux-watcher.js --url ws://127.0.0.1:<port>/api/events.mux\n');
  process.exit(1);
}

let ws = null;
let retryTimer = null;
let closing = false;
let failures = 0;

function connect() {
  if (closing) return;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    process.stderr.write('mux connect threw: ' + e.message + '\n');
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    failures = 0;
    process.stderr.write('mux connected to ' + url + '\n');
  };
  ws.onmessage = (ev) => {
    let frame;
    try { frame = JSON.parse(String(ev.data)); } catch { return; }
    if (!frame || typeof frame.type !== 'string') return;
    if (frame.type === 'approval/requested') {
      process.stdout.write(JSON.stringify({
        event: 'attention', kind: 'approval',
        toolName: frame.toolName || 'tool',
        reason: frame.reason || '',
      }) + '\n');
    } else if (frame.type === 'question/requested') {
      for (const q of frame.questions || []) {
        process.stdout.write(JSON.stringify({
          event: 'attention', kind: 'question',
          header: q.header || '',
          question: q.question || '',
        }) + '\n');
      }
    }
  };
  ws.onclose = (ev) => {
    ws = null;
    process.stderr.write('mux closed (code ' + ev.code + ' ' + ev.reason + ')\n');
    scheduleReconnect();
  };
  ws.onerror = (ev) => {
    failures += 1;
    process.stderr.write('mux error (attempt ' + failures + '): ' + (ev && ev.message ? ev.message : String(ev)) + '\n');
    try { ws.close(); } catch { /* ignore */ }
  };
}

function scheduleReconnect() {
  if (closing || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, 5000);
}

connect();

process.on('SIGTERM', () => { closing = true; if (ws) try { ws.close(); } catch {} process.exit(0); });
process.on('SIGINT', () => { closing = true; if (ws) try { ws.close(); } catch {} process.exit(0); });
