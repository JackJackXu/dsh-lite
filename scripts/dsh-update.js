'use strict'
/**
 * dsh-update.js — dsh 更新管理（查询 / 比较 / 执行全局更新）。
 *
 * main.js 负责调度（启动 + 每 24h）、托盘菜单、通知与服务重启；
 * 本模块只做三件纯函数的事，便于独立测试：
 *   1. 读本地全局 dsh 版本（从 findDshEntry 定位的 bin.js 推导 package.json）
 *   2. 从 npmmirror 抓 @deepseek-ai/dsh 的 dist-tags（latest / next）
 *   3. 比较版本、决策目标版本、执行 `npm i -g`（显式带 allow-scripts）
 *
 * 为什么查 npmmirror 而不是 `npm view`：省一个 npm 子进程，且用户环境
 * npm 默认源就是 npmmirror；registry 响应直接 JSON，超时由调用方控制。
 * 为什么更新必须带 --allow-scripts：npm 11 的 allow-scripts 机制默认拦截
 * node-pty/koffi 等原生模块的安装脚本（2026-08-21 升级 rc.8 实测踩坑：
 * pty.node 没生成导致 dsh 启动崩溃），显式放行列表与用户 .npmrc 一致。
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

/** npmmirror registry（用户环境默认源；scoped 包名需 %2f 编码）。 */
const REGISTRY = 'https://registry.npmmirror.com/@deepseek-ai%2fdsh'

/**
 * npm 11 allow-scripts 放行列表，与用户 `npm config get allow-scripts` 一致。
 * 少了任何一个，npm i -g 都会拦截对应安装脚本（原生模块不构建 → dsh 崩）。
 */
const ALLOW_SCRIPTS =
  'esbuild,@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs'

/**
 * 本地全局 dsh 版本。entryPath 来自 main.js 的 findDshEntry()：
 *   .../node_modules/@deepseek-ai/dsh/lib/bin.js
 * 包版本就在同目录的 package.json（bin.js 上两级）。
 * @param {string|null} entryPath bin.js 的绝对路径，找不到时传 null
 * @returns {string|null} 版本号，读不到返回 null
 */
function localDshVersion(entryPath) {
  if (!entryPath) return null
  try {
    const pkgPath = path.join(path.dirname(path.dirname(entryPath)), 'package.json')
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null
  } catch {
    return null
  }
}

/**
 * 抓取 dist-tags（latest / next）。next 是预发布通道（rc.7 之后有 rc.8），
 * latest 是稳定通道——两者都查，本地版本落后哪个就提示哪个。
 * @param {number} timeoutMs 超时上限（默认 8s）
 * @returns {Promise<{latest: string|null, next: string|null}|null>} 失败返回 null
 */
async function fetchDshDistTags(timeoutMs = 8000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(REGISTRY, { signal: ctrl.signal })
    if (!res.ok) return null
    const j = await res.json()
    const tags = j && j['dist-tags'] ? j['dist-tags'] : {}
    return { latest: tags.latest || null, next: tags.next || null }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 语义化版本比较，支持 x.y.z 与 x.y.z-rc.N（rc.N 视为比正式版旧：
 * 1.0.0-rc.1 < 1.0.0）。解析失败退化为字符串比较。
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1} a<b → -1，a>b → 1，相等 → 0
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(String(v).trim())
    return m
      ? { major: +m[1], minor: +m[2], patch: +m[3], rc: m[4] === undefined ? Infinity : +m[4] }
      : null
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) {
    const sa = String(a)
    const sb = String(b)
    if (sa === sb) return 0
    return sa < sb ? -1 : 1
  }
  for (const key of ['major', 'minor', 'patch', 'rc']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  return 0
}

/**
 * 决策更新目标：本地落后 latest → 提示 latest；本地 ≥ latest 但落后 next
 * → 提示 next（用户在 rc 通道上，latest 可能比本地旧）；都领先 → 无更新。
 * @param {string|null} local 本地版本
 * @param {{latest: string|null, next: string|null}|null} tags dist-tags
 * @returns {{version: string, tag: string}|null} 目标版本；无更新返回 null
 */
function updateCandidate(local, tags) {
  if (!local || !tags) return null
  const cands = []
  if (tags.latest && compareVersions(local, tags.latest) < 0) {
    cands.push({ version: tags.latest, tag: 'latest' })
  }
  if (
    tags.next &&
    tags.next !== tags.latest &&
    compareVersions(local, tags.next) < 0
  ) {
    cands.push({ version: tags.next, tag: 'next' })
  }
  if (!cands.length) return null
  cands.sort((x, y) => compareVersions(x.version, y.version))
  return cands[cands.length - 1]
}

/**
 * 执行全局更新：`npm install -g @deepseek-ai/dsh@<version>`。
 * 显式 --allow-scripts（见文件头注释）。npm 在 Windows 上是 npm.cmd，
 * 由调用方传入（findNodeExe 同目录）。
 * @param {string} version 目标版本
 * @param {{npmPath?: string, cwd?: string, onOutput?: (s: string) => void}} [opts]
 * @returns {Promise<{ok: boolean, code: number|null, error?: string, output: string}>}
 */
function runGlobalUpdate(version, opts = {}) {
  const { npmPath = 'npm', cwd, onOutput } = opts
  return new Promise((resolve) => {
    const args = [
      'install',
      '-g',
      `@deepseek-ai/dsh@${version}`,
      `--allow-scripts=${ALLOW_SCRIPTS}`,
    ]
    let output = ''
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      resolve(result)
    }
    let proc
    try {
      proc = spawn(npmPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      finish({ ok: false, code: null, error: String((err && err.message) || err), output })
      return
    }
    const sink = (buf) => {
      const text = buf.toString()
      output += text
      if (typeof onOutput === 'function') onOutput(text)
    }
    proc.stdout.on('data', sink)
    proc.stderr.on('data', sink)
    proc.on('error', (err) =>
      finish({ ok: false, code: null, error: String((err && err.message) || err), output })
    )
    proc.on('exit', (code) => finish({ ok: code === 0, code, output }))
  })
}

module.exports = {
  ALLOW_SCRIPTS,
  REGISTRY,
  compareVersions,
  fetchDshDistTags,
  localDshVersion,
  runGlobalUpdate,
  updateCandidate,
}
