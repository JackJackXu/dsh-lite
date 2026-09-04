# Changelog — DSH DLE

本文件的格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] — 2026-09-05

### 变更

- **启动加载页**：启动即建窗显示本地 loading 页，dsh 就绪后再载入 WebUI（告别"双击后黑屏/无反馈等待"）
- **开机自启开关**：托盘「Launch at Login」勾选即随 Windows 启动，持久化
- **settings 加 schemaVersion**：为将来字段迁移预留单一路径（v1 无字段变更）
- **mux watcher 断连退避 + 日志降噪**：5s→60s 指数退避；只在状态变化时打日志（修掉 `code 1006` 每 5s 刷屏）
- **CI 产 Windows 安装包**：GitHub Actions 每次 push 自动打包并上传 artifact（不再只在本地手打）
- 新增 `ARCHITECTURE.md`：完整体检结论 + 明确暂缓/不做项及原因
- 版本号 1.0.2 → 1.1.0

## [1.0.2] — 2026-09-05

### 变更

- **记住主窗口大小/位置/最大化**：跨重启恢复；校验显示器，拔掉外接屏不会开在屏外
- **About「检查更新」按钮**：在 About 弹窗里点击即可手动检查 dsh 最新版并刷新版本行
- **GPU 诊断改进**：窗口就绪后再读一次 GPU 真实状态（启动早期读到的是 `?`/`disabled_off`，误导）
- 版本号 1.0.1 → 1.0.2

## [1.0.1] — 2026-09-05

### 变更

- **适配 dsh 0.1.2-rc.1 鉴权（token+cookie）**：横幅解析保留完整带 token 的 URL；就绪探测像浏览器一样走 303+Set-Cookie 握手再判就绪（否则永远 40s 超时、黑屏无托盘）
- **mux ws 地址修正**：从完整 URL 构造并保留 token（原拼接把路径接到 query 之后，是坏地址）
- **超时自愈**：启动失败/超时后自动退出并释放单实例锁，不再留"无窗口后台"僵尸挡住重开
- **双开防护**：检测到已运行的带 token dsh（无法复用时）弹窗询问，而非硬起第二个并发写 `~/.dsh`
- **startDsh 同步失败快速退出**（不再干等 40 秒）
- 版本号 1.0.0 → 1.0.1

## [Unreleased] — 审查中（未发布）

### 变更

- **升级 Electron 31 → 41**（Chromium 安全更新覆盖；electron-builder 24 → 26）
- **扩展 dsh 安装路径探测**：支持 npm / pnpm / Volta / nvm-windows / PATH 兜底（此前仅 `%APPDATA%\npm`）
- **watcher 监督 + 心跳**：session/mux watcher 意外退出自动指数退避重启（最多 5 次）；30 秒心跳 + 90 秒超时强杀（挂起也能自愈）；收到有效事件重置重启计数；watcher 内部错误经 stderr 落盘
- **Node 特性门禁**：直接探测 zstd + 全局 WebSocket（而非比主版本号——zstd 需 22.15+）；不满足则跳过 watcher 并明示
- **外部 dsh 复用 + 所有权模型**：启动时扫描 3080/3081/上次端口，复用已有 dsh；`ownsDsh` 标记区分"本壳启动/外部服务"，复用外部服务时"重启"只重载窗口（不再双开写同一份 `~/.dsh`）
- **watcher stdout 行缓冲**：session/mux watcher 的输出按行攒齐再解析，JSON 被管道拆半不再丢通知
- **dsh stdout 行缓冲**：URL 解析不再被管道拆行破坏（否则端口不保存、mux 不启动、40 秒假超时）
- **waitForDsh 竞态修复**：超时/成功回调加 once 守卫，避免重复回调
- **openTerminal 注入防护**：PowerShell 回退改用 `-EncodedCommand`（Base64），目录含单引号也安全
- **子进程 exit 竞态修复**：dsh / mux / session watcher 的 exit 处理器加引用自检，重启服务后退出不再遗留孤儿 node.exe
- **createWindow 修复**：close/closed 处理器补 `const win = mainWindow`（此前引用未声明变量，点 × 隐藏托盘崩溃）
- **probeUrl 无字节上限**：`id="root"` 标记在 2KB 后也能命中（此前真实 dsh 会被误判不存在而双开）
- **启动失败快路径**：找不到 node/dsh 立即弹修复指引，不再干等 40 秒
- **Notification 防 GC**：通知对象保留引用到关闭，避免 toast 不显示
- **probeDsh 双重回调修复**：once 守卫
- **日志优化**：UTF-8 BOM（防 PowerShell/记事本中文乱码）；`ensureUtf8Bom` 只读 3 字节（不再整文件 O(n²)）；壳日志与 dsh-web.log 均 5MB 轮转
- **端口三态探测**：空闲/占用/未知（超时重试一次），避免误判
- **mux 重放去重**：10 分钟窗口内相同审批/问题只通知一次；Map 定期剪枝
- **打包隐私修复**：extraResources 只打包运行时需要的 2 个 watcher（此前整目录打包，图标脚本泄露开发者用户名路径）
- **launcher.vbs 去硬编码**：用脚本自身目录推导，不再写死开发机路径
- **图标脚本去重**：抽公共 `icon-utils.js`；删除与 icon.png 重复的 whale-pixel.png
- **补 LICENSE（MIT）**；README/CHANGELOG 重写

## [1.0.0] — 2026-08-17

首个发布版本（stableDSH 重构为 DSH DLE：去隔离、去内置运行时、改名）。

- Electron 壳：窗口 / 托盘 / 单实例 / 端口复用 / 崩溃自愈 / 唤醒恢复 / 进程树回收 / 日志轮转
- 通知走壳：session-watcher（任务完成）+ mux-watcher（审批/选择题）
- 安全加固：最小权限、导航锁（精确 origin 比较）、禁 webview、外链走系统浏览器
- 共享 `~/.dsh`：与开发版 webui 数据/插件/皮肤完全一致
