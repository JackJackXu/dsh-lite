# DSH DLE — 架构体检与决策记录

> 2026-09-05（随 v1.1.0 记录）。本文记录针对 Electron 套壳的架构体检结论，以及**明确暂缓/不做**的项与原因，避免未来重复评估。
> 关联：`README.md`、`CHANGELOG.md`；交接文档在 `C:\MyMy\my_work\DSH_DEV\`。

## 一、定位与安全基线（为什么很多通用 Electron 建议不适用）

DSH DLE 是**最薄的套壳**：主进程只负责拉 dsh 服务 + 开窗口 + 托盘/通知；渲染层是官方 dsh WebUI（localhost），**无 preload、无 IPC、零注入**。

已具备的安全基线（勿回退）：
- `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webSecurity:true`
- 导航锁（精确 origin 比对）、禁 `<webview>`、弹窗外链走系统浏览器、最小权限（仅剪贴板写/全屏/通知）
- **不要**为加功能去开 `ipcMain`+`contextBridge` 暴露 Node——那会破坏这个安全模型。

## 二、稳定性/性能现状（多为已具备，记录结论）
- 崩溃自愈：did-fail-load 退避重试、render-process-gone 重建、unresponsive 自动 reload、watcher 心跳+指数重启、超时自动退出释放单实例锁——已实现。
- 性能：强制 GPU、256MB 磁盘缓存、关 spellcheck、日志缓冲、`--no-open`——已实现。
- v1.0.x 修复 dsh 0.1.2 token+cookie 鉴权导致的"启动即黑屏/超时"。

## 三、明确暂缓 / 不做 及原因（重要）

| 项 | 状态 | 原因 |
|---|---|---|
| **mux 审批/提问通知完整修复** | 暂缓 | 0.1.2 后 mux 需 HttpOnly cookie + /api 浏览器信任围栏，Node 自带 WebSocket 带不了 Cookie 头，需打包可带头的 WS 客户端 + cookie 握手，工程量大、且是次级功能（任务完成通知正常）。单独成项再做。 |
| **main.js 拆模块** | 暂缓 | 1700+ 行单文件，重构收益大但改动面广、需配行为测试，宜作独立一次"重构版"发布，不宜和功能批次混发。 |
| **引入 TypeScript** | 不做 | 纯 JS + 详细 JSDoc 已够；TS 会显著增加构建链复杂度，违背"轻薄、少依赖"定位。 |
| **macOS / Linux 跨平台** | 暂缓 | 代码有 taskkill、`%LOCALAPPDATA%`、wt.exe 等 Windows 专属；用户场景为 Windows，跨平台投入大无近期收益。README 已注明仅 Windows。 |
| **壳自身自动更新（electron-updater）** | 暂缓 | 需 GitHub Releases + 签名 + 网络，与镜像/费用敏感环境冲突；现有"托盘手动更新 dsh"已覆盖主要需求。 |
| **错误上报（Sentry 等）** | 暂缓 | 涉及隐私 + 成本；轻量替代=错误弹窗给日志路径 + GitHub issue 模板即可。 |
| **DATA_DIR 改用 app.getPath('userData')** | 暂缓 | 会改变设置/日志/端口的存放位置（现 `%LOCALAPPDATA%\DSH DLE`），需迁移旧数据，Windows 单平台下收益低、风险高。 |
| **启动速度深度优化（V8/预热）** | 暂缓 | Electron 冷启动大头是 Chromium + dsh 服务冷启动，已用端口复用缓解；当前阶段收益小。 |

## 四、1.1.0 本次落地的改进
- settings 增加 `schemaVersion` 迁移机制
- 托盘「开机自启」开关（持久化）
- 启动加载页：启动即建窗显示 `assets/loading.html`，dsh 就绪后再载入 WebUI（告别黑屏/无反馈等待）
- mux watcher 断连指数退避 + 日志降噪
- CI：在 GitHub Actions 产出 Windows 安装包并上传 artifact
