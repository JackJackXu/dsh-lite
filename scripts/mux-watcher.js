#!/usr/bin/env node
'use strict';

// DSH DLE mux watcher — standalone node process (Node >= 22 has global
// WebSocket; the system node is v24).
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
// Connection attempt counter (reset to 0 on a successful open). Drives the
// exponential backoff AND the quieted logging: a persistent failure (e.g. the
// dsh 0.1.2 auth change the shell can't yet satisfy) must not spam one log
// line every 5 seconds forever.
let attempt = 0;

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;

function nextDelay() {
  // 5s -> 10s -> 20s -> 40s -> capped at 60s.
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, Math.min(attempt, 4)));
}

// Log reconnects only when they are likely to tell us something new: the first
// few, then each power-of-two attempt (4,8,16,…). Between those the failure is
// unchanged and the delay is growing, so there is nothing to add.
function shouldLogAttempt() {
  return attempt <= 3 || (attempt & (attempt - 1)) === 0;
}

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
    attempt = 0;
    process.stderr.write('mux connected to ' + url + '\n');
  };
  ws.onmessage = (ev) => {
    let frame;
    try {
      const parsed = JSON.parse(String(ev.data));
      // Real dsh mux frames are ServerRequest full forms: { rpcId, payload: {...} }.
      // Accept both the wrapped form and a bare frame.
      frame = parsed && typeof parsed === 'object' && parsed.payload && typeof parsed.payload.type === 'string'
        ? parsed.payload
        : parsed;
    } catch { return; }
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
    attempt += 1;
    if (shouldLogAttempt()) {
      process.stderr.write('mux closed (code ' + ev.code + ' ' + (ev.reason || '') + '), reconnect #' + attempt + ' in ' + Math.round(nextDelay() / 1000) + 's\n');
    }
    scheduleReconnect();
  };
  // Swallow the error event: its close always follows, and onclose owns the
  // reconnect + logging (avoids double-counting a single failure).
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

function scheduleReconnect() {
  if (closing || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, nextDelay());
}

connect();

// Heartbeat: proves liveness to the supervising shell even while the
// WebSocket is idle (no pending approvals/questions to report).
setInterval(() => process.stdout.write(JSON.stringify({ event: 'heartbeat' }) + '\n'), 30 * 1000).unref();

process.on('SIGTERM', () => { closing = true; if (ws) try { ws.close(); } catch {} process.exit(0); });
process.on('SIGINT', () => { closing = true; if (ws) try { ws.close(); } catch {} process.exit(0); });
