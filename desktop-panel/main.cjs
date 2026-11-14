const { app, BrowserWindow, clipboard, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const os = require("node:os");
const dns = require("node:dns").promises;
const { spawn, spawnSync } = require("node:child_process");

const APP_NAME = "LooPilot-ele";
const DEFAULT_PORT = 4317;
let mainWindow;
let manager;

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function desktopVersion() {
  try {
    const versionPath = app.isPackaged
      ? path.join(app.getAppPath(), "desktop-version.json")
      : path.resolve(__dirname, "..", "desktop-version.json");
    return JSON.parse(fs.readFileSync(versionPath, "utf8")).label || "v0.1";
  } catch {
    return "v0.1";
  }
}

class ServiceManager {
  constructor() {
    this.projectRoot = app.isPackaged
      ? path.join(process.resourcesPath, "loopilot")
      : path.resolve(__dirname, "..");
    this.stateDir = path.join(app.getPath("appData"), "LooPilot");
    this.configPath = path.join(this.stateDir, "config.json");
    this.child = null;
    this.startOptions = null;
    this.publicUrl = "";
    this.logs = [];
    this.stateValue = {
      service: "stopped",
      health: "unknown",
      mode: "local",
      safe: false,
      bridge: "not-started",
      port: DEFAULT_PORT,
      localUrl: `http://127.0.0.1:${DEFAULT_PORT}`,
      authorizedUrl: "",
      pairingCode: "",
      publicUrl: "",
      logs: []
    };
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  loadConfig() {
    try {
      const config = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
      return {
        port: normalizePort(config.port),
        mode: ["local", "quick", "fixed", "custom"].includes(config.mode) ? config.mode : "local",
        safe: Boolean(config.safe),
        codexHome: String(config.codexHome || "")
      };
    } catch {
      return { port: DEFAULT_PORT, mode: "local", safe: false, codexHome: "" };
    }
  }

  saveConfig(config) {
    const current = this.loadConfig();
    const next = { ...current, ...config, port: normalizePort(config.port || current.port) };
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    return next;
  }

  getState() {
    this.syncCredentials();
    return { ...this.stateValue, logs: [...this.logs] };
  }

  emitState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("loopilot:state", this.getState());
  }

  addLog(line) {
    const safeLine = redactSecrets(String(line), this.readToken());
    if (!safeLine.trim()) return;
    this.logs.push(safeLine.trim());
    if (this.logs.length > 80) this.logs.shift();
    this.stateValue.logs = [...this.logs];
    this.emitState();
  }

  readToken() {
    return readPrivateFile(path.join(this.stateDir, "auth-token"));
  }

  readPairingCode() {
    return readPrivateFile(path.join(this.stateDir, "pairing-code"));
  }

  syncCredentials() {
    const token = this.readToken();
    const pairingCode = this.readPairingCode();
    this.stateValue.pairingCode = /^\d{6}$/.test(pairingCode) ? pairingCode : "";
    this.stateValue.authorizedUrl = token
      ? `${this.stateValue.localUrl}/?token=${encodeURIComponent(token)}`
      : "";
    this.stateValue.publicUrl = this.publicUrl;
  }

  async start(rawOptions = {}) {
    if (this.child) await this.stop();
    const saved = this.saveConfig({
      ...rawOptions,
      safe: rawOptions.safeMode ?? rawOptions.safe
    });
    const port = normalizePort(saved.port);
    const mode = saved.mode;
    const safe = Boolean(saved.safe);
    const portStatus = await checkPortAvailable(port);
    if (!portStatus.available) throw new Error(`端口 ${port} 已被占用，请在高级设置中修改端口。`);

    const serverPath = path.join(this.projectRoot, "server", "index.mjs");
    if (!fs.existsSync(serverPath)) throw new Error(`LooPilot 核心文件缺失：${serverPath}`);
    const localUrl = `http://127.0.0.1:${port}`;
    const args = [serverPath, "--prod"];
    if (mode === "quick") args.push("--public");
    if (mode === "fixed" || mode === "custom") args.push("--tunnel", mode === "fixed" ? "cloudflare" : "custom");
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      LOOPILOT_STATE_DIR: this.stateDir,
      PORT: String(port),
      LOOPILOT_TUNNEL_MODE: mode === "local" ? "none" : mode === "custom" ? "custom" : "cloudflare"
    };
    if (safe) env.LOOPILOT_BRIDGE_MODE = "queue";
    if (saved.codexHome) env.CODEX_HOME = saved.codexHome;

    this.logs = [];
    this.publicUrl = "";
    this.startOptions = { ...saved, port, mode, safe };
    this.stateValue = {
      ...this.stateValue,
      service: "starting",
      health: "checking",
      mode,
      safe,
      bridge: safe ? "safe-mode" : "starting",
      port,
      localUrl,
      authorizedUrl: "",
      pairingCode: "",
      publicUrl: "",
      logs: []
    };
    this.emitState();

    this.child = spawn(process.execPath, args, {
      cwd: this.projectRoot,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consumeOutput(chunk));
    this.child.stderr.on("data", (chunk) => this.consumeOutput(chunk));
    this.child.once("error", (error) => {
      this.addLog(`服务进程错误：${error.message}`);
      this.stateValue.service = "error";
      this.stateValue.health = "blocked";
      this.emitState();
    });
    this.child.once("close", (code) => {
      this.child = null;
      if (this.stateValue.service !== "stopping") {
        this.stateValue.service = code === 0 ? "stopped" : "error";
        this.stateValue.health = code === 0 ? "unknown" : "blocked";
        this.stateValue.bridge = "not-started";
        this.addLog(`服务进程已退出（代码 ${code ?? "unknown"}）`);
      }
      this.emitState();
    });
    await waitForHealth(localUrl);
    this.stateValue.service = "running";
    this.stateValue.health = "healthy";
    this.stateValue.bridge = safe ? "safe-mode" : "connected";
    this.syncCredentials();
    this.emitState();
    return this.getState();
  }

  consumeOutput(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const publicMatch = line.match(/Public URL:\s*(https?:\/\/[^\s]+)/i);
      const quickMatch = line.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i);
      if (publicMatch || quickMatch) {
        this.publicUrl = (publicMatch?.[1] || quickMatch?.[1] || "").replace(/[),.]+$/, "");
        this.syncCredentials();
      }
      this.addLog(line);
    }
  }

  async stop() {
    if (!this.child) return this.getState();
    const child = this.child;
    this.stateValue.service = "stopping";
    this.stateValue.health = "unknown";
    this.emitState();
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (process.platform === "win32" && child.pid) {
          spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          try { child.kill("SIGKILL"); } catch {}
        }
        resolve();
      }, 2500);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
    this.child = null;
    this.stateValue.service = "stopped";
    this.stateValue.bridge = "not-started";
    this.emitState();
    return this.getState();
  }

  async restart(options = {}) {
    await this.stop();
    return this.start({ ...this.startOptions, ...options });
  }

  async dispose() {
    await this.stop();
  }
}

function readPrivateFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function redactSecrets(value, token = "") {
  let output = String(value);
  if (token) output = output.split(token).join("[REDACTED]");
  return output
    .replace(/([?&](?:token|access_token|tunnel_token)=)[^\s&]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]");
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT;
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve({ available: false }));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve({ available: true })));
  });
}

async function waitForHealth(localUrl) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${localUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("LooPilot 服务启动超时，请检查日志和端口设置。");
}

async function inspectEnvironment() {
  const config = manager.loadConfig();
  const projectRoot = manager.projectRoot;
  const requiredFiles = [
    path.join(projectRoot, "server", "index.mjs"),
    path.join(projectRoot, "build", "index.html"),
    path.join(projectRoot, "public", "manifest.webmanifest")
  ];
  const coreReady = requiredFiles.every((file) => fs.existsSync(file));
  const stateWritable = await canWrite(manager.stateDir);
  const codexHome = config.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const codexCli = findExecutable("codex.exe") || findExecutable("codex");
  const cloudflaredPath = path.join(manager.stateDir, "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  let network = false;
  try { await dns.lookup("cloudflare.com"); network = true; } catch {}
  const checks = {
    windows: { status: process.platform === "win32" && process.arch === "x64" ? "normal" : "warning", detail: `${process.platform} / ${process.arch}` },
    runtime: { status: "normal", detail: `Electron Node ${process.versions.node}` },
    core: { status: coreReady ? "normal" : "blocked", detail: coreReady ? "server / build / public" : "核心文件不完整" },
    state: { status: stateWritable ? "normal" : "blocked", detail: manager.stateDir },
    port: { status: (await checkPortAvailable(config.port)).available || manager.stateValue.service === "running" ? "normal" : "warning", detail: String(config.port) },
    codex: { status: codexCli || fs.existsSync(codexHome) ? "normal" : "warning", detail: codexCli || codexHome },
    codexSessions: { status: hasSessionFiles(codexHome) ? "normal" : "warning", detail: hasSessionFiles(codexHome) ? "已发现 session 文件" : "未发现 session 文件" },
    network: { status: network ? "normal" : "warning", detail: network ? "网络可用" : "无法解析 cloudflare.com" },
    cloudflared: { status: fs.existsSync(cloudflaredPath) ? "normal" : "warning", detail: cloudflaredPath }
  };
  const blocking = Object.values(checks).some((item) => item.status === "blocked");
  return { checks, overall: blocking ? "blocked" : "ready", stateDir: manager.stateDir, codexHome };
}

function findExecutable(name) {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout || "").split(/\r?\n/)[0].trim() : "";
}

function hasSessionFiles(root) {
  try {
    return fs.readdirSync(root, { recursive: true }).some((item) => String(item).endsWith(".jsonl"));
  } catch {
    return false;
  }
}

function canWrite(directory) {
  return new Promise((resolve) => {
    const probe = path.join(directory, `.write-test-${process.pid}`);
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(probe, "ok", "utf8");
      fs.rmSync(probe, { force: true });
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: `${APP_NAME} ${desktopVersion()}`,
    backgroundColor: "#f2f5f7",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

function registerIpc() {
  ipcMain.handle("loopilot:get-state", () => manager.getState());
  ipcMain.handle("loopilot:get-config", () => manager.loadConfig());
  ipcMain.handle("loopilot:save-config", (_event, config) => manager.saveConfig(config));
  ipcMain.handle("loopilot:start", (_event, options) => manager.start(options));
  ipcMain.handle("loopilot:stop", () => manager.stop());
  ipcMain.handle("loopilot:restart", (_event, options) => manager.restart(options));
  ipcMain.handle("loopilot:inspect", () => inspectEnvironment());
  ipcMain.handle("loopilot:copy-text", (_event, value) => clipboard.writeText(String(value || "")));
  ipcMain.handle("loopilot:open-external", (_event, value) => isHttpUrl(value) ? shell.openExternal(value) : false);
}

app.whenReady().then(() => {
  manager = new ServiceManager();
  registerIpc();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", async (event) => {
  if (!manager || !manager.child) return;
  event.preventDefault();
  await manager.dispose();
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
