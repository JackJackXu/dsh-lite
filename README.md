# 🐋 stableDSH

DeepSeek Harness (DSH) 的自包含桌面版：**本地服务 + Electron 窗口 + QQ 式托盘**，
**数据与开发环境完全隔离**，适合日常使用。

界面本体 100% 忠于原版 DSH（**不做任何注入修改**）；界面定制（小鲸鱼皮肤等）通过
DSH 官方插件系统实现，与壳完全解耦。

## 与"dsh-desktop 旧版"的区别

| | dsh-desktop (旧) | stableDSH (现在) |
|---|---|---|
| 服务端口 | 3080（会和开发 webui 冲突） | **3081**（独立） |
| 数据目录 | 借用 `~/.dsh` | **`%LOCALAPPDATA%\stableDSH`**（独立 DSH_HOME） |
| 运行环境 | 依赖系统 node + 全局 dsh | **内置 node + dsh**（可选，缺省回退系统） |
| 单实例 | 无 | **有**（双击不重复起服务） |
| 日志 | 无 | **落盘**（`数据目录\logs\`） |
| 崩溃恢复 | 无 | 服务异常退出托盘提示 + 一键重启 |

## 功能

- **独立服务**：启动时自动拉起 dsh web，**端口复用**（优先上次端口，被占自动换新）——网页 origin 稳定，界面偏好持久记住
- **渲染崩溃自愈**：页面崩溃指数退避自动重载、连续失败重建窗口、假死自动刷新
- **数据隔离**：所有配置/会话/凭证/插件都在 `%LOCALAPPDATA%\stableDSH`，**绝不触碰 `~/.dsh`**
- **QQ 式托盘**：点窗口 × 隐藏到托盘，不退出
- **托盘菜单**：打开窗口 / 数据目录 / 日志目录 / 重新加载 / 重启服务 / 插件目录 / 关于 / 退出
- **单实例锁**：重复启动只聚焦已有窗口
- **日志落盘**：`数据目录\logs\stableDSH.log`（壳层）+ `dsh-web.log`（服务完整输出，排错用）
- **进程树回收**：退出时 `taskkill /T /F`，不留孤儿进程
- **会话完成/审批/选择题通知**：壳内置 watcher（任务完成读会话日志 + 审批/选择题经 mux 流），关窗托盘驻留也可靠弹通知
- **打开终端**：托盘一键在数据目录打开 **Windows Terminal**（无 wt 时回退 PowerShell），现代化外观
- **dsh 内核自动更新**：启动后自动查 npm 最新版，同意后装进数据目录 `agent\`（overlay 原子切换，失败保留旧版，重启生效）
- **内置 node 供 agent**：把内置 node 加进 agent 的 PATH（电脑没装 node 也能跑 `node`/`npm`，装了则优先自己的）
- **静默启动**：服务进程无控制台窗口
- **首次运行**：第一次启动后进网页设置页，用 DSH 官方引导流程填 API Key（独立数据目录，需填一次）

## 开发运行（当前机器）

```bash
npm install          # 一次性
npm start            # 启动 stableDSH（开发模式，用系统 node + 全局 dsh）
```

## 自包含打包（推荐交付方式）

内置运行时后打包，目标机器**不需要装 node / dsh**：

```powershell
# 1) 下载内置 node + dsh 到 resources/（node ~30MB + dsh 依赖树，npmmirror 加速）
node scripts\fetch-resources.js

# 2) 打包（管理员权限执行，winCodeSign 需要）
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npx electron-builder --win
# 产物: release\stableDSH-Setup-1.0.0.exe
```

> 只想小体积、目标机器已有 node+dsh 时，可跳过第 1 步直接打包（系统回退模式）。

## 安装插件（皮肤等）

插件在开发环境（当前 webui）开发调试好后，一行命令装进 stableDSH：

```bat
scripts\install-plugin.bat C:\path\to\plugin-bundle
```

然后托盘菜单 **Restart DSH Service** 生效。

## 文件结构

```
stableDSH/
├── main.js                  # 主进程（窗口 + 托盘 + 服务管理 + 单实例）
├── package.json             # 项目定义 + electron-builder 配置
├── scripts/
│   ├── fetch-resources.js   # 下载内置 node + dsh（自包含）
│   ├── after-pack.js        # 打包后补拷 resources（防 node_modules 被剥）
│   ├── generate-whale-icon.js # 生成像素鲸鱼图标（sharp）
│   ├── make-icon-from-png.js # 从用户像素画生成图标
│   ├── dsh-updater.js       # dsh 内核更新（overlay 原子切换）
│   └── install-plugin.bat   # 一行命令装插件进 stableDSH
├── start-dsh.bat            # 备用启动器（无黑框，调 launcher.vbs）
├── launcher.vbs             # 静默启动 electron（ASCII，无编码坑）
├── create-shortcut.vbs      # 生成桌面快捷方式（可选）
├── assets/
│   ├── icon.ico             # 打包用图标（官方鲸鱼）
│   ├── icon.png             # 托盘/窗口图标
│   └── whale.svg            # 图标源文件（官方 favicon 放大版）
├── resources/               # 内置运行时（fetch-resources.js 生成）
│   ├── node/                # 便携版 node.exe + npm
│   └── dsh/                 # @deepseek-ai/dsh 完整安装
└── release/                 # 打包产物输出目录
```

## 数据目录（`%LOCALAPPDATA%\stableDSH`）

```
%LOCALAPPDATA%\stableDSH\
├── profiles\web\     # web profile（插件装在这里）
├── sessions\         # 会话记录
├── storages\         # 存储
├── settings.yaml     # 配置
└── logs\             # stableDSH 日志
```

卸载时**默认保留数据目录**（会话不丢）；想彻底清除就手动删 `%LOCALAPPDATA%\stableDSH`。

## 高级

- 换端口（仅作解析失败兜底）：`set STABLEDSH_PORT=4000 && stableDSH.exe`
- 换数据目录：`set STABLEDSH_HOME=D:\my-dsh && stableDSH.exe`

## 已知事项

- 首次使用需在设置页填一次 API Key（数据隔离的代价，一次性）
- 打包体积：Electron 引擎 ~100MB + 内置运行时（node ~30MB + dsh 依赖树），正常范围
- 与开发环境完全独立：两边插件、主题、会话互不影响
