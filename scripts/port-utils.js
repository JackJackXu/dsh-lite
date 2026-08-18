// Port persistence + probe helpers (pure Node, no Electron) so the shell's
// port logic can be unit-tested in plain node (main.js itself cannot be
// require()d outside Electron).
'use strict';

const fs = require('fs');
const net = require('net');

// Read the last-used port. Returns 0 when absent, empty, or invalid —
// an invalid/corrupt port file (Infinity, 0, >65535) must never reach
// net.connect (it throws RangeError synchronously).
function readLastPort(portFile) {
  try {
    const p = Number(fs.readFileSync(portFile, 'utf8').trim());
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : 0;
  } catch { return 0; }
}

function savePort(portFile, port) {
  try { fs.writeFileSync(portFile, String(port)); } catch { /* ignore */ }
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

module.exports = { readLastPort, savePort, portFree };
