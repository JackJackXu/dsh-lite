// port-utils 行为测试 — 端口持久化三态 + 探测两态。
// 运行：node tests/port-utils.test.js（含于 npm test）。
// 说明：portFree 的 null 态（连接超时）需要防火墙/半开连接才能稳定复现，
// 本地无法可靠制造，故只测 true/false 两态；null 分支逻辑简单（setTimeout
// 触发 finish(null)），由代码审查覆盖。

const { readLastPort, savePort, portFree } = require('../scripts/port-utils.js');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

let pass = true;
const check = (name, cond) => {
  if (!cond) pass = false;
  console.log((cond ? '✅' : '❌') + ' ' + name);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dle-port-test-'));
const file = path.join(tmp, 'port.txt');

// ── readLastPort 三态 ─────────────────────────────────────────────────────
check('文件不存在 → 0', readLastPort(path.join(tmp, 'missing.txt')) === 0);
fs.writeFileSync(file, '');
check('空文件 → 0', readLastPort(file) === 0);
for (const bad of ['abc', '99999', '-1', '0', 'Infinity']) {
  fs.writeFileSync(file, bad);
  check('非法内容 "' + bad + '" → 0', readLastPort(file) === 0);
}
fs.writeFileSync(file, ' 52345 \n'); // 空白包裹的合法数字：trim 后有效
check('空白包裹的合法内容 → 52345', readLastPort(file) === 52345);

// ── savePort 往返 ─────────────────────────────────────────────────────────
savePort(file, 3081);
check('savePort 后读回 3081', readLastPort(file) === 3081);

// ── portFree：空闲端口 → true ────────────────────────────────────────────
async function testPortFree() {
  // 找一个当前空闲的端口：临时监听 :0，关闭后该端口短时空闲。
  const freePort = await new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const state = await portFree(freePort);
  check('空闲端口 → true（收到 ' + state + '）', state === true);

  // 占用端口 → false
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const busyPort = server.address().port;
  const busyState = await portFree(busyPort);
  check('占用端口 → false（收到 ' + busyState + '）', busyState === false);
  await new Promise(resolve => server.close(resolve));
}

testPortFree().then(() => {
  console.log(pass ? '\nport-utils 测试通过' : '\nport-utils 测试失败');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
});
