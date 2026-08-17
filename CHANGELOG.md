# Changelog — DSH DLE

本文件的格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] — 审查中（未发布）

### 变更

- **升级 Electron 31 → 41**（Chromium 安全更新覆盖；electron-builder 24 → 26）
- **扩展 dsh 安装路径探测**：支持 npm / pnpm / Volta / nvm-windows / PATH 兜底（此前仅 `%APPDATA%\npm`）
- **图标生成脚本去硬编码**：3 个开发脚本不再写死本机 sharp 路径，改为动态解析（require.resolve → 常见全局根 → 报错提示）
- **watcher stdout 行缓冲**：session/mux watcher 的输出按行攒齐再解析，JSON 被管道拆半不再丢通知
- **waitForDsh 竞态修复**：超时/成功回调加 once 守卫，避免重复回调
- **openTerminal 注入防护**：PowerShell 回退改用 `-EncodedCommand`（Base64），目录含单引号也安全
- **子进程 exit 竞态修复**：dsh / mux / session watcher 的 exit 处理器加引用自检，重启服务后退出不再遗留孤儿 node.exe
- **Notification 防 GC**：通知对象保留引用到关闭，避免 toast 不显示
- **probeDsh 双重回调修复**：once 守卫
- **打包隐私修复**：extraResources 只打包运行时需要的 2 个 watcher（此前整目录打包，图标脚本泄露开发者用户名路径）
- **launcher.vbs 去硬编码**：用脚本自身目录推导，不再写死开发机路径
- **补 LICENSE（MIT）**；README 重写

## [1.0.0] — 2026-08-17

首个发布版本（stableDSH 重构为 DSH DLE：去隔离、去内置运行时、改名）。

- Electron 壳：窗口 / 托盘 / 单实例 / 端口复用 / 崩溃自愈 / 唤醒恢复 / 进程树回收 / 日志轮转
- 通知走壳：session-watcher（任务完成）+ mux-watcher（审批/选择题）
- 安全加固：最小权限、导航锁（精确 origin 比较）、禁 webview、外链走系统浏览器
- 共享 `~/.dsh`：与开发版 webui 数据/插件/皮肤完全一致
