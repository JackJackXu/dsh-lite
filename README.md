# 🐋 DSH DLE（DeepSeek Harness Desktop Lite Edition）

DeepSeek Harness 的**轻薄桌面壳**：**Electron 窗口 + 托盘驻留 + 安全加固 + 任务完成/审批通知**。
不打包任何运行时（node / dsh），**直接复用系统里已有的 node 和 dsh**——与开发版 webui 共用同一套环境。

界面本体 100% 忠于原版 DSH（不做任何注入修改）；界面定制（皮肤等）通过 DSH 官方插件系统实现，与壳完全解耦。

## 功能

- **共享数据**：把 `DSH_HOME` 钉死为 `~/.dsh`（忽略用户环境变量里的其他值）——壳的 watcher 与它启动的 dsh 永远读写同一份数据（API Key、会话、皮肤、插件），与开发版完全共用
- **系统环境**：启动时用系统 node 执行系统 dsh，不维护第二份运行时；按 npm/pnpm/Volta/Scoop/nvm 自动探测安装位置
- **托盘驻留**：点窗口 × 隐藏到托盘，不退出；托盘菜单：打开窗口 / 数据目录 / 日志目录 / 终端 / 重新加载 / 重启服务 / 插件目录 / 关于 / 退出
- **任务完成/审批/选择题通知**：壳内置 watcher（任务完成读会话日志 + 审批/选择题经 mux 流），关窗托盘驻留也可靠弹通知
- **watcher 自愈**：session/mux watcher 意外退出自动指数退避重启（最多 5 次）；30 秒心跳，挂起（不退出不输出）会被强制重启；收到有效事件即重置重启计数
- **单实例锁**：重复启动只聚焦已有窗口
- **端口复用**：优先上次端口，被占自动换新（三态探测：空闲/占用/未知）；网页 origin 稳定，界面偏好持久
- **外部 dsh 复用**：启动时扫描 3080（开发版默认）/3081（回退）/上次端口，发现已有 dsh 就直接复用其 origin，**不再启动第二个实例**（避免双开写同一份 `~/.dsh`）；此时托盘提示"外部 dsh"，重启服务只会重载窗口
- **渲染崩溃自愈**：页面崩溃指数退避自动重载、连续失败重建窗口、假死自动刷新（定时器去重）
- **唤醒恢复**：睡眠唤醒后自动检查服务存活并重连
- **安全加固**：最小权限（仅剪贴板+全屏+通知）、外链走系统浏览器、禁止导航离开 dsh origin（含 iframe/重定向）、禁止 `<webview>`
- **进程树回收**：退出时 `taskkill /T /F` 并等待完成，不留孤儿进程
- **日志落盘**：`%LOCALAPPDATA%\DSH DLE\logs\`（壳层 + dsh-web.log，均 5MB 轮转，UTF-8 BOM 防中文乱码）

## 环境要求

- **Windows 10/11**
- **Node.js ≥ 22.15**（会话通知需要 zstd 解压 + 全局 WebSocket；版本不满足时通知自动停用并提示）
- **dsh**：`npm install -g @deepseek-ai/dsh`（或等效全局安装）——壳会按上述安装方式自动探测
- **Clash/代理（国内网络）**：dsh 直连 GitHub 可能被墙，建议配置 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量

## 开发运行

```bash
npm install          # 一次性（装 electron + electron-builder）
npm start            # 启动 DSH DLE（开发模式）
```

## 打包

目标机器**需要已装 node + dsh**（和开发版同一套环境）：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npx electron-builder --win
# 产物: release\DSH-DLE-Setup-1.0.0.exe
```

## 文件结构

```
DSH DLE/
├── main.js                  # 主进程（窗口 + 托盘 + 服务管理 + 单实例 + watcher 监督）
├── package.json             # 项目定义 + electron-builder 配置
├── LICENSE                  # MIT
├── scripts/                 # 运行时 watcher（随安装包发布）
│   ├── session-watcher.js   # 任务完成通知（读会话日志，zstd 解码，30s 心跳）
│   ├── mux-watcher.js       # 审批/选择题通知（连 mux WebSocket 流，30s 心跳）
│   ├── icon-utils.js        # 开发用：图标脚本共享的 sharp 加载（不进安装包）
│   ├── generate-whale-icon.js # 开发用：生成像素鲸鱼图标（不进安装包）
│   ├── make-icon-from-png.js   # 开发用：从用户像素画生成图标（不进安装包）
│   └── sprite-to-png.js        # 开发用：鲸鱼 sprite → PNG（不进安装包）
├── start-dsh.bat            # 备用启动器（无黑框，调 launcher.vbs）
├── launcher.vbs             # 静默启动 electron（ASCII，无编码坑）
├── assets/
│   ├── icon.ico             # 打包用图标（鲸鱼）
│   ├── icon.png             # 托盘/窗口图标
│   └── whale.svg            # 图标源文件
└── release/                 # 打包产物输出目录
```

> 图标生成脚本（generate-whale-icon / make-icon-from-png / sprite-to-png / icon-utils）是开发工具，**不打进安装包**；它们动态解析全局 sharp，无需修改路径。

## 数据

- **DSH 数据**：`~/.dsh`（与开发版共享，**不要同时开**开发版 webui 和 DSH DLE；壳已尽力避免重复启动，但两个进程并发写同一份数据仍有风险）
- **壳自己的状态**：`%LOCALAPPDATA%\DSH DLE\`（日志、端口记录、通知开关设置）

## 已知事项

- **不要和开发版 webui 同时运行**：两者共享 `~/.dsh`，同时跑会抢同一份会话数据（壳启动时会复用已有实例而非再开一个，但若两个壳同时启动窗口仍可能撞车）
- 首次使用：如果 `~/.dsh` 已配置过（开发版用着），**开箱即用，无需重新填 Key**
- 打包体积 ~80MB 是 Electron 壳的底线（Chromium 内核必须自带）；想要更小只能换 Tauri 技术栈，不划算

## License

MIT（见 [LICENSE](LICENSE)）
