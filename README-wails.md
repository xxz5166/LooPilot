# LooPilot-go Windows 构建与安装

该版本使用 Go + Wails 2.10.2 + React/TypeScript。Node.js、LooPilot server、build、public、bin、node_modules 和 Windows runtime 会嵌入 EXE，目标电脑无需安装 Node.js。

## 构建

在仓库根目录执行：

```powershell
.\build-wails.ps1
```

首次成功构建输出 `LooPilot-go v0.1.exe`，随后 `wails-version.json` 自动变为下一版本。再次构建输出 `LooPilot-go v0.2.exe`，依次递增。脚本使用 `wails build`，会自动带上 Wails 所需构建标签；不要直接使用 `go build`。只检查而不递增版本：

```powershell
.\build-wails.ps1 -NoBump
```

也可以进入 `wails-app\LooPilotGo` 执行 `wails dev` 或 `wails build`。正式脚本会先构建 React 前端、刷新嵌入资源、生成 Wails 绑定，再执行 Go 测试和 Windows GUI 编译。

## 运行目录

- 配置与 DPAPI 加密密钥：`%APPDATA%\LooPilot`
- 首次启动释放的 Node runtime：`%LOCALAPPDATA%\LooPilot\runtime`
- Node 服务、Codex Bridge 和 cloudflared 由 Go 主进程统一停止；退出时使用 Windows 进程树清理。

公网模式只会在用户选择并启动后运行 Tunnel。Token 不写入普通配置、日志、命令行或二维码；二维码仅包含服务地址和 6 位配对码。
