// session-watcher 帧扫描 + 行展开行为测试。
// 运行：node tests/session-watcher.test.js（含于 npm test）。
// scanZstdFrames 只做结构扫描（不调用 zstd 解码），用合成帧即可覆盖完整帧 /
// 多帧 / 半截帧；expandRow 覆盖三种存储行 + 坏输入。

const { scanZstdFrames, expandRow } = require('../scripts/session-watcher.js');

let pass = true;
const check = (name, cond) => {
  if (!cond) pass = false;
  console.log((cond ? '✅' : '❌') + ' ' + name);
};

// 构造一个最小合法 zstd 帧：magic + descriptor(0x20: singleSegment,
// contentSize 1 字节, 无 checksum/字典) + contentSize + 一个 raw 块头 + payload。
// 与 scanZstdFrames 的字段解析一一对应。
function makeFrame(payload) {
  const magic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
  const desc = Buffer.from([0x20]);
  const contentSize = Buffer.from([payload.length]);
  const blockHeader = Buffer.alloc(3);
  blockHeader.writeUIntLE((payload.length << 3) | 1, 0, 3); // raw 块, lastBlock
  return Buffer.concat([magic, desc, contentSize, blockHeader, payload]);
}

// ── scanZstdFrames ────────────────────────────────────────────────────────
{
  const r = scanZstdFrames(Buffer.alloc(0));
  check('空 buffer → 无帧、无 tornStart', r.frames.length === 0 && r.tornStart === undefined);
}
{
  const r = scanZstdFrames(Buffer.from('not a zstd file at all'));
  check('非 zstd 开头 → 无帧、tornStart 0', r.frames.length === 0 && r.tornStart === 0);
}
{
  const frame = makeFrame(Buffer.from('hello, dsh'));
  const r = scanZstdFrames(frame);
  check('单完整帧 → 1 帧、end=总长', r.frames.length === 1 && r.frames[0].start === 0 && r.frames[0].end === frame.length && r.tornStart === undefined);
}
{
  const f1 = makeFrame(Buffer.from('aaa'));
  const f2 = makeFrame(Buffer.from('bbb'));
  const buf = Buffer.concat([f1, f2]);
  const r = scanZstdFrames(buf);
  check('两帧连续 → 2 帧、边界正确', r.frames.length === 2 && r.frames[0].end === f1.length && r.frames[1].start === f1.length && r.frames[1].end === buf.length);
}
{
  const f1 = makeFrame(Buffer.from('aaa'));
  const torn = f1.subarray(0, 6); // magic + descriptor + contentSize + 半个块头
  const r = scanZstdFrames(Buffer.concat([f1, torn]));
  check('完整帧 + 半截帧 → 1 完整帧、tornStart 在帧尾', r.frames.length === 1 && r.tornStart === f1.length);
}
{
  const f1 = makeFrame(Buffer.from('aaa'));
  const cut = f1.subarray(0, f1.length - 2); // 块 payload 被截断
  const r = scanZstdFrames(cut);
  check('单帧被截断 → 无帧、tornStart 0', r.frames.length === 0 && r.tornStart === 0);
}

// ── expandRow ─────────────────────────────────────────────────────────────
{
  const r = expandRow('{ not json');
  check('坏 JSON → []', Array.isArray(r) && r.length === 0);
}
{
  const r = expandRow('"a string"');
  check('非对象行 → []', Array.isArray(r) && r.length === 0);
}
{
  const r = expandRow(JSON.stringify({ type: 'text-chunks', data: { texts: ['a', 'b'] } }));
  check('text-chunks → texts', Array.isArray(r) && r.join(',') === 'a,b');
}
{
  const r = expandRow(JSON.stringify({ type: 'tool-call-chunks', data: { args: [{ id: 1 }, { id: 2 }] } }));
  check('tool-call-chunks → args', Array.isArray(r) && r.length === 2 && r[1].id === 2);
}
{
  const r = expandRow(JSON.stringify({ type: 'session', data: { id: 's1' } }));
  check('普通行 → 原样包一层', Array.isArray(r) && r.length === 1 && r[0].type === 'session');
}
{
  const r = expandRow(JSON.stringify({ type: 'text-chunks', data: {} }));
  check('text-chunks 无 texts → []', Array.isArray(r) && r.length === 0);
}

console.log(pass ? '\nsession-watcher 测试通过' : '\nsession-watcher 测试失败');
process.exit(pass ? 0 : 1);
