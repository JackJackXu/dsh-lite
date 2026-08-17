#!/usr/bin/env node
'use strict';

// DSH Lite session watcher — standalone node process (must run on Node >= 22
// which has node:zlib zstd support; the system node is v24).
//
// Watches dsh session logs (<sessionsDir>/**/session.jsonl.zstd) and prints one
// JSON line per completed top-level agent turn:
//   {"event":"turnEnd","title":...,"body":...,"sessionId":...,"cwd":...}
// The Electron main process spawns this script and turns those lines into
// Windows notifications.
//
// On-disk format: concatenated zstd frames; each frame holds JSONL records.
// A 'turn/end' event marks the end of the agent's run; older logs fall back to
// 'assistant/message'. Subagent logs (delegationDepth > 0) are skipped.
//
// Decoding strategy (adapted from dsh-desktop/session-watcher.js, MIT):
// structurally scan complete frame ranges, then zstdDecompressSync each frame
// with node:zlib — the same codec dsh itself uses. No third-party deps.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ZSTD_MAGIC = 4247762216; // 28 B5 2F FD little-endian

// Structural zstd frame scanner (ported from dsh-session-persistence-jsonl).
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start };
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) return { frames, tornStart: start };
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return { frames, tornStart: start };
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

function decodeFrame(buf) {
  return zlib.zstdDecompressSync(buf).toString('utf8');
}

// Expand one JSONL row into its events (storage rows pack many chunk events).
function expandRow(line) {
  let row;
  try { row = JSON.parse(line); } catch { return []; }
  if (!row || typeof row !== 'object') return [];
  switch (row.type) {
    case 'text-chunks':
    case 'reasoning-chunks':
      return Array.isArray(row.data && row.data.texts) ? row.data.texts : [];
    case 'tool-call-chunks':
      return Array.isArray(row.data && row.data.args) ? row.data.args : [];
    default:
      return [row];
  }
}

class SessionWatcher {
  constructor({ sessionsDir, onTurnEnd, onSession, log }) {
    this.sessionsDir = sessionsDir;
    this.onTurnEnd = onTurnEnd || (() => {});
    this.onSession = onSession || (() => {});
    this.log = log || (() => {});
    this.files = new Map(); // absPath -> { size, consumed, header, title, baseline }
    this.timer = null;
  }

  start(intervalMs = 2000) {
    // Defer the first scan so the app window paints first; batch it to avoid
    // a startup stall when many session logs exist.
    setImmediate(() => this.scan(4));
    // NOTE: standalone process — the interval MUST NOT be unref()ed, otherwise
    // the process exits after the first scan and never watches again.
    this.timer = setInterval(() => this.scan(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  listLogs() {
    try {
      if (!fs.existsSync(this.sessionsDir)) return [];
      const out = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.name === 'session.jsonl.zstd') out.push(p);
        }
      };
      walk(this.sessionsDir);
      return out;
    } catch { return []; }
  }

  scan(maxChanged = Infinity) {
    let any = false;
    let changed = 0;
    for (const file of this.listLogs()) {
      try {
        const grew = this.process(file);
        if (grew) {
          any = true;
          changed += 1;
          if (changed >= maxChanged) break;
        }
      } catch (err) { this.log('watch', 'process failed ' + file + ': ' + err.message); }
    }
    return any;
  }

  readTail(file, offset, size) {
    const len = size - offset;
    const tail = Buffer.allocUnsafe(len);
    const fd = fs.openSync(file, 'r');
    try {
      let pos = 0;
      while (pos < len) {
        const n = fs.readSync(fd, tail, pos, len - pos, offset + pos);
        if (n <= 0) break;
        pos += n;
      }
      return tail.subarray(0, pos);
    } finally {
      fs.closeSync(fd);
    }
  }

  process(file) {
    let st;
    try { st = fs.statSync(file); } catch { this.files.delete(file); return false; }
    let rec = this.files.get(file);
    if (!rec) {
      rec = { size: 0, consumed: 0, header: null, title: null, baseline: false, hasTurnEvents: false };
      this.files.set(file, rec);
    }
    if (st.size <= rec.consumed && rec.baseline) return false;

    // Truncated/rewritten log (e.g. repair) -> re-baseline.
    if (st.size < rec.consumed) {
      rec.consumed = 0; rec.header = null; rec.title = null; rec.baseline = false; rec.hasTurnEvents = false;
    }

    const first = !rec.baseline;
    const readFrom = rec.consumed;
    let tail;
    try { tail = this.readTail(file, readFrom, st.size); } catch { return false; }

    // Tail not on a frame boundary -> re-baseline.
    if (!first && tail.length >= 4 && tail.readUInt32LE(0) !== ZSTD_MAGIC) {
      rec.consumed = 0; rec.header = null; rec.title = null; rec.baseline = false; rec.hasTurnEvents = false;
      return this.process(file);
    }

    const { frames } = scanZstdFrames(tail);

    // First sight of this session: parse the header row and scan the whole
    // first frame for the title (usually lives in the first frame too).
    // History beyond that never triggers notifications. Announce the session's
    // working directory so the shell can open a terminal there.
    if (first) {
      if (frames.length > 0) {
        try {
          const text = decodeFrame(tail.subarray(frames[0].start, frames[0].end));
          const lines = text.split('\n');
          const h = JSON.parse(lines[0]);
          if (h && h.type === 'session') {
            rec.header = h;
            if (typeof h.cwd === 'string' && h.cwd) {
              try { this.onSession({ cwd: h.cwd, sessionId: h.id }); }
              catch (err) { this.log('watch', 'onSession error: ' + err.message); }
            }
          }
          for (let i = 1; i < lines.length; i++) {
            for (const ev of expandRow(lines[i])) {
              if (!ev || typeof ev !== 'object') continue;
              if (ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string') rec.title = ev.data.title;
              if (ev.type === 'turn/start' || ev.type === 'turn/end') rec.hasTurnEvents = true;
            }
          }
        } catch { /* header damaged, retry next pass */ }
        rec.consumed = readFrom + frames[frames.length - 1].end;
      }
      rec.baseline = true;
      rec.size = st.size;
      return true;
    }

    // Incremental: decode only new complete frames after consumed.
    let turnEnds = 0;
    let assistantMessages = 0;
    let consumed = readFrom;
    for (const f of frames) {
      let text;
      try { text = decodeFrame(tail.subarray(f.start, f.end)); } catch { break; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        for (const ev of expandRow(line)) {
          if (!ev || typeof ev !== 'object') continue;
          if (ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string') rec.title = ev.data.title;
          if (ev.type === 'turn/start' || ev.type === 'turn/end') rec.hasTurnEvents = true;
          if (ev.type === 'turn/end') turnEnds += 1;
          if (ev.type === 'assistant/message') assistantMessages += 1;
        }
      }
      consumed = readFrom + f.end;
    }
    rec.consumed = consumed;
    rec.size = st.size;

    const count = rec.hasTurnEvents ? turnEnds : assistantMessages;
    if (count > 0) this.emit(rec, count);
    return count > 0 || consumed > readFrom;
  }

  emit(rec, count) {
    const h = rec.header || {};
    if (h.delegationDepth > 0) return; // subagent logs are noise
    let title = rec.title || 'DSH task finished';
    const cwdBase = h.cwd ? path.basename(h.cwd) : null;
    const shortId = h.id ? h.id.slice(-8) : null;
    let body = [cwdBase, shortId ? 'session ' + shortId : null].filter(Boolean).join(' \u00b7 ');
    body += count > 1 ? ' (' + count + ' turns finished)' : '';
    try { this.onTurnEnd({ title, body, sessionId: h.id, cwd: h.cwd }); }
    catch (err) { this.log('watch', 'onTurnEnd error: ' + err.message); }
  }
}

// --- standalone entry ------------------------------------------------------
// Guard so `require('./session-watcher.js')` in tests does not start watching.
if (require.main === module) {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--sessions');
  const sessionsDir = idx >= 0 ? args[idx + 1] : null;
  if (!sessionsDir) {
    process.stderr.write('usage: node session-watcher.js --sessions <dir>\n');
    process.exit(1);
  }

  const watcher = new SessionWatcher({
    sessionsDir,
    onTurnEnd: (m) => process.stdout.write(JSON.stringify({ event: 'turnEnd', ...m }) + '\n'),
    onSession: (m) => process.stdout.write(JSON.stringify({ event: 'session', ...m }) + '\n'),
    log: () => {},
  });
  watcher.start(2000);

  process.on('SIGTERM', () => { watcher.stop(); process.exit(0); });
  process.on('SIGINT', () => { watcher.stop(); process.exit(0); });
}

module.exports = { SessionWatcher, scanZstdFrames, expandRow };
