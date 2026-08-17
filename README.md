# 🐋 DSH Lite（DeepSeek Harness Desktop Lite Edition）

DeepSeek Harness 的**轻薄桌面壳**：**Electron 窗口 + QQ 式托盘 + 安全加固 + 任务完成/审批通知**。
不打包任何运行时（node / dsh），**直接复用你系统里已有的 node 和 dsh**——也就是开发版 webui 用的那套环境。

界面本体 100% 忠于原版 DSH（不做任何注入修改）；界面定制（皮肤等）通过 DSH 官方插件系统实现，与壳完全解耦。

## 和 stableDSH 的区别

| | stableDSH（旧） | **DSH Lite（现在）** |
|---|---|---|
| 数据 | `%LOCALAPPDATA%\stableDSH`（独立 DSH_HOME，与开发环境隔离） | **共享 `~/.dsh`**（Key、会话、插件、皮肤与开发版完全一致） |
| 运行环境 | 内置 node + dsh（可选） | **只用系统 node + dsh**，不内置 |
| 安装包 | ~157MB | **~80MB**（Electron 壳，无运行时） |
| dsh 更新 | 内置 updater 自动装新内核 | **跟随系统 dsh**（`npm update -g @deepseek-ai/dsh`） |
| 安装插件 | 需装两遍（独立目录） | **装一遍两边通用**（共享 `~/.dsh`） |

## 功能

- **共享数据**：DSH_HOME 不覆盖，直接使用 `~/.dsh`——API Key、会话、皮肤、插件全部与开发版共用
- **系统环境**：启动时用系统 node 执行系统 dsh（和开发版同一套），不再维护第二份运行时
- **QQ 式托盘**：点窗口 × 隐藏到托盘，不退出；托盘菜单：打开窗口 / 数据目录 / 日志目录 / 终端 / 重新加载 / 重启服务 / 插件目录 / 关于 / 退出
- **任务完成/审批/选择题通知**：壳内置 watcher（任务完成读会话日志 + 审批/选择题经 mux 流），关窗托盘驻留也可靠弹通知
- **单实例锁**：重复启动只聚焦已有窗口
- **端口复用**：优先上次端口，被占自动换新（网页 origin 稳定，界面偏好持久记住）
- **渲染崩溃自愈**：页面崩溃指数退避自动重载、连续失败重建窗口、假死自动刷新
- **安全加固**：最小权限（仅剪贴板+全屏）、外链走系统浏览器、禁止导航离开 dsh origin
- **唤醒恢复**：睡眠唤醒后自动检查服务存活并重连
- **进程树回收**：退出时 `taskkill /T /F`，不留孤儿进程
- **日志落盘**：`%LOCALAPPDATA%\DSH Lite\logs\`（壳层）+ `dsh-web.log`（服务输出）

## 开发运行（当前机器）

```bash
npm install          # 一次性（装 electron + electron-builder）
npm start            # 启动 DSH Lite（开发模式）
```

## 打包

目标机器**需要已装 node + dsh**（和开发版同一套环境）：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npx electron-builder --win
# 产物: release\DSH-Lite-Setup-1.0.0.exe
```

## 文件结构

```
DSH Lite/
├── main.js                  # 主进程（窗口 + 托盘 + 服务管理 + 单实例 + watcher）
├── package.json             # 项目定义 + electron-builder 配置
├── scripts/
│   ├── session-watcher.js   # 任务完成通知（读会话日志）
│   ├── mux-watcher.js       # 审批/选择题通知（连 mux 流）
│   ├── generate-whale-icon.js # 生成像素鲸鱼图标（sharp）
│   └── make-icon-from-png.js # 从用户像素画生成图标
├── start-dsh.bat            # 备用启动器（无黑框，调 launcher.vbs）
├── launcher.vbs             # 静默启动 electron（ASCII，无编码坑）
├── assets/
│   ├── icon.ico             # 打包用图标（鲸鱼）
│   ├── icon.png             # 托盘/窗口图标
│   └── whale.svg            # 图标源文件
└── release/                 # 打包产物输出目录
```

## 数据

- **DSH 数据**：`~/.dsh`（与开发版共享，**不要同时开**开发版 webui 和 DSH Lite）
- **壳自己的状态**：`%LOCALAPPDATA%\DSH Lite\`（日志、端口记录、通知开关设置）

## 已知事项

- **不要和开发版 webui 同时运行**：两者共享 `~/.dsh`，同时跑会抢同一份会话数据
- 首次使用：如果你的 `~/.dsh` 已配置过（开发版用着），**开箱即用，无需重新填 Key**
- 打包体积 ~80MB 是 Electron 壳的底线（Chromium 内核必须自带）；想要更小只能换 Tauri 技术栈，不划算
