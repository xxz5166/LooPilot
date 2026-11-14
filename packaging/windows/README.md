# Windows 安装包

构建生产文件后，执行 `npm run package:win` 生成 `dist/LooPilot.exe`。然后使用 Inno Setup 编译 `installer/LooPilot.iss`，生成可双击安装的 `LooPilot-Setup.exe`。

安装后开始菜单会提供四种启动方式：普通模式、安全队列模式、临时 Cloudflare 隧道、自定义隧道。

自定义隧道配置文件位于 `%APPDATA%\LooPilot\config.json`。`tunnelCommand` 填写程序名或绝对路径，`tunnelArgs` 使用 JSON 数组；参数支持 `{PORT}` 和 `{LOCAL_URL}` 占位符。固定的公网地址可填写 `tunnelUrl`。
