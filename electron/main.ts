import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from "electron";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  AppConfig,
  AppSnapshot,
  DesktopApi,
  EnvironmentCheck,
  LaunchMode,
  TunnelConfig
} from "./shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const defaultPort = 4317;
const sensitivePatterns = [/token=[^&\s]+/gi, /Bearer\s+[A-Za-z0-9._~-]+/gi, /TUNNEL_TOKEN[=:][^\s]+/gi];

let mainWindow: BrowserWindow | null = null;
let configDir = "";
let configPath = "";
let secretPath = "";
let config: AppConfig;
let serviceProcess: ChildProcess | null = null;
let tunnelProcess: ChildProcess | { kill?: () => void; on?: ChildProcess["on"] } | null = null;
let publicUrl = "";
let serviceStatus: AppSnapshot["serviceStatus"] = "offline";
let appStatus: AppSnapshot["status"] = "stopped";
let tunnelStatus: AppSnapshot["tunnelStatus"] = "disabled";
let environmentChecks: EnvironmentCheck[] = [];
let logLines: string[] = [];
let stopping = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let quitRequested = false;

const defaultTunnel = (): TunnelConfig => ({
  mode: "local",
  token: "",
  executablePath: "",
  args: [],
  cwd: "",
  env: {},
  url: "",
  urlPattern: "https?://[^\\s\"'<>]+",
  healthUrl: "",
  timeoutMs: 120000,
  autoReconnect: true,
  stopMethod: "tree"
});

function getCoreDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "loopilot")
    : path.resolve(__dirname, "..");
}

function getRuntimePath() {
  const configured = process.env.LOOPILOT_NODE_RUNTIME;
  if (configured && fs.existsSync(configured)) return configured;
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, "runtime", isWindows ? "node.exe" : "node")
    : path.join(getCoreDir(), "runtime", isWindows ? "node.exe" : "node");
  if (fs.existsSync(bundled)) return bundled;
  // Development fallback is the system Node command. Packaged builds never use Electron as Node.
  return app.isPackaged ? "" : (isWindows ? "node.exe" : "node");
}

function defaultConfig(): AppConfig {
  const home = os.homedir();
  const state = configDir;
  return {
    port: defaultPort,
    mode: "local",
    safeMode: false,
    devMode: false,
    codexHome: process.env.CODEX_HOME || path.join(home, ".codex"),
    codexCliPath: "",
    stateDir: state,
    bridgeMode: "app-server",
    logLevel: "info",
    autoStart: false,
    autoReconnect: true,
    language: "zh-CN",
    tunnel: defaultTunnel()
  };
}

function loadConfig() {
  config = defaultConfig();
  try {
    const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config = normalizeConfig({ ...config, ...stored, tunnel: { ...config.tunnel, ...(stored.tunnel || {}) } });
  } catch {
    saveConfigFile();
  }
  config.tunnel.token = readSecret();
}

function normalizeConfig(value: AppConfig): AppConfig {
  const port = Number(value.port);
  const args = Array.isArray(value.tunnel?.args) ? value.tunnel.args.map(String) : [];
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.tunnel?.env || {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = String(item);
  }
  const mode: LaunchMode = ["local", "cloudflare-temporary", "cloudflare-fixed", "custom"].includes(value.mode)
    ? value.mode
    : "local";
  return {
    ...value,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : defaultPort,
    mode,
    stateDir: path.resolve(String(value.stateDir || configDir)),
    codexHome: path.resolve(String(value.codexHome || path.join(os.homedir(), ".codex"))),
    bridgeMode: value.safeMode || value.bridgeMode === "queue" ? "queue" : "app-server",
    tunnel: {
      ...defaultTunnel(),
      ...(value.tunnel || {}),
      mode,
      token: String(value.tunnel?.token || ""),
      args,
      env,
      timeoutMs: Math.max(10000, Math.min(600000, Number(value.tunnel?.timeoutMs) || 120000))
    }
  };
}

function saveConfigFile() {
  fs.mkdirSync(configDir, { recursive: true });
  const safe = { ...config, tunnel: { ...config.tunnel, token: undefined } };
  fs.writeFileSync(configPath, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  if (config.tunnel.token) writeSecret(config.tunnel.token);
  else fs.rmSync(secretPath, { force: true });
}

function readSecret() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(secretPath)) return "";
    return safeStorage.decryptString(fs.readFileSync(secretPath));
  } catch {
    return "";
  }
}

function writeSecret(value: string) {
  if (!value || !safeStorage.isEncryptionAvailable()) return;
  fs.writeFileSync(secretPath, safeStorage.encryptString(value));
}

function parseLaunchArgs() {
  const args = process.argv.slice(1);
  if (args.includes("--public")) config.mode = "cloudflare-temporary";
  if (args.includes("--safe")) config.safeMode = true;
  if (args.includes("--dev")) config.devMode = true;
  if (args.includes("--prod")) config.devMode = false;
  const portArg = args.find((arg) => arg.startsWith("--port="));
  const portIndex = args.indexOf("--port");
  const rawPort = portArg?.slice("--port=".length) || (portIndex >= 0 ? args[portIndex + 1] : "");
  if (rawPort) config.port = Number(rawPort) || config.port;
  const tunnelIndex = args.indexOf("--tunnel");
  const tunnel = args.find((arg) => arg.startsWith("--tunnel="))?.slice(9) || (tunnelIndex >= 0 ? args[tunnelIndex + 1] : "");
  if (tunnel === "custom") config.mode = "custom";
  if (["none", "off", "disabled"].includes(tunnel)) config.mode = "local";
}

function addLog(value: string) {
  const clean = redact(String(value)).trimEnd();
  if (!clean) return;
  logLines.push(clean);
  if (logLines.length > 300) logLines = logLines.slice(-300);
  mainWindow?.webContents.send("log", clean);
}

function redact(value: string) {
  let output = value;
  for (const pattern of sensitivePatterns) output = output.replace(pattern, (match) => match.startsWith("token=") ? "token=[hidden]" : "[hidden]");
  if (config?.tunnel?.token) output = output.split(config.tunnel.token).join("[hidden]");
  return output.replace(/Authorized URL:\s*\S+/gi, "Authorized URL: [hidden]").replace(/Pairing code:\s*\d{6}/gi, "Pairing code: [hidden]");
}

function attachOutput(child: ChildProcess, label: string) {
  child.stdout?.on("data", (chunk) => chunk.toString().split(/\r?\n/).forEach((line: string) => line && addLog(`[${label}] ${line}`)));
  child.stderr?.on("data", (chunk) => chunk.toString().split(/\r?\n/).forEach((line: string) => line && addLog(`[${label}] ${line}`)));
  child.on("error", (error) => addLog(`[${label}] ${error.message}`));
}

async function buildSnapshot(): Promise<AppSnapshot> {
  const localUrl = `http://127.0.0.1:${config.port}`;
  const token = readAuthToken();
  const pairingCode = readPairingCode();
  const server = publicUrl || localUrl;
  const payload = JSON.stringify({ type: "loopilot-pairing", version: 1, server, code: pairingCode });
  const bridgeStatus = config.safeMode || config.bridgeMode === "queue"
    ? (serviceStatus === "healthy" ? "queue" : "disabled")
    : serviceStatus === "healthy" ? "ready" : "missing";
  return {
    status: appStatus,
    serviceStatus,
    healthStatus: environmentChecks.some((item) => item.severity === "blocked") ? "blocked" : environmentChecks.some((item) => item.severity === "warning") ? "warning" : "ok",
    bridgeStatus,
    tunnelStatus,
    mode: config.mode,
    version: readCoreVersion(),
    buildLabel: readBuildLabel(),
    port: config.port,
    localUrl,
    authorizedUrl: token ? `${localUrl}/?token=${encodeURIComponent(token)}` : "",
    pairingCode,
    publicUrl,
    qrPayload: payload,
    qrDataUrl: "",
    envChecks: environmentChecks,
    logs: logLines.slice(-120),
    config: serializeConfig()
  };
}

function serializeConfig() {
  const { token: _token, ...tunnel } = config.tunnel;
  return { ...config, tunnel };
}

function readAuthToken() {
  try { return fs.readFileSync(path.join(config.stateDir, "auth-token"), "utf8").trim(); } catch { return ""; }
}

function readPairingCode() {
  try { return fs.readFileSync(path.join(config.stateDir, "pairing-code"), "utf8").trim(); } catch { return ""; }
}

function readCoreVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(getCoreDir(), "package.json"), "utf8")).version || "unknown"; } catch { return "unknown"; }
}

function readBuildLabel() {
  try { return JSON.parse(fs.readFileSync(path.join(getCoreDir(), "desktop-version.json"), "utf8")).label || "v0.1"; } catch { return "v0.1"; }
}

async function notifyState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("state", await buildSnapshot());
}

async function checkEnvironment(): Promise<EnvironmentCheck[]> {
  const checks: EnvironmentCheck[] = [];
  const add = (id: string, label: string, severity: EnvironmentCheck["severity"], detail: string, itemPath?: string) => checks.push({ id, label, severity, detail, ...(itemPath ? { path: itemPath } : {}) });
  add("windows", "Windows 系统与架构", isWindows && ["x64", "arm64"].includes(os.arch()) ? "ok" : "warning", `${os.release()} / ${os.arch()}`);
  const runtime = getRuntimePath();
  add("runtime", "内置 Node.js Runtime", runtime && (runtime === "node.exe" || runtime === "node" || fs.existsSync(runtime)) ? "ok" : "blocked", runtime || "缺少 runtime/node.exe，请重新构建安装包", runtime || undefined);
  const missingCore = ["server/index.mjs", "bin/loopilot.mjs", "public/manifest.webmanifest", "build/index.html"].filter((item) => !fs.existsSync(path.join(getCoreDir(), item)));
  add("core", "LooPilot 文件", missingCore.length ? "blocked" : "ok", missingCore.length ? `缺少: ${missingCore.join(", ")}` : "server、build、public、bin 完整", getCoreDir());
  add("state", "状态目录读写", await canUseDirectory(config.stateDir) ? "ok" : "blocked", config.stateDir, config.stateDir);
  add("port", `端口 ${config.port}`, await isPortAvailable(config.port) || serviceStatus === "healthy" ? "ok" : "blocked", await isPortAvailable(config.port) || serviceStatus === "healthy" ? "可用" : "端口已被占用");
  const codexCandidates = codexCandidatesList();
  const codexPath = codexCandidates.find((item) => fs.existsSync(item));
  const codexOk = Boolean(codexPath) || Boolean(await findOnPath("codex.exe"));
  add("codex", "Codex CLI / Desktop", codexOk ? "ok" : "warning", codexOk ? `检测到 ${codexPath || "PATH 中的 codex.exe"}` : "未找到 Codex，可进入 Safe 模式；检测路径已列出", codexPath || config.codexCliPath || undefined);
  if (!codexOk) checks[checks.length - 1].detail = "未找到 Codex。请安装 Codex CLI/Desktop 后重新检查；可进入 Safe 模式。";
  if (codexPath && path.extname(codexPath).toLowerCase() === ".exe") {
    const probe = await runProbe(codexPath, ["--version"]);
    add("codex-start", "Codex 命令启动", probe.ok ? "ok" : "warning", probe.ok ? "Codex 可启动" : probe.detail, codexPath);
  } else {
    add("codex-start", "Codex 命令启动", "warning", "未能使用真实 .exe 完成无 Shell 启动检查");
  }
  const codexHomeOk = fs.existsSync(config.codexHome);
  const sessionFile = path.join(config.codexHome, "session_index.jsonl");
  add("codex-home", "%USERPROFILE%\\.codex", codexHomeOk ? "ok" : "warning", codexHomeOk ? config.codexHome : "目录不存在", config.codexHome);
  add("codex-session", "Codex session 文件", fs.existsSync(sessionFile) ? "ok" : "warning", fs.existsSync(sessionFile) ? sessionFile : "未找到 session_index.jsonl", sessionFile);
  const network = await checkNetwork();
  add("network", "本机网络", network.ok ? "ok" : "warning", network.detail);
  const cloudflared = path.join(config.stateDir, "bin", isWindows ? "cloudflared.exe" : "cloudflared");
  add("cloudflared", "Cloudflare Tunnel", fs.existsSync(cloudflared) ? "ok" : "warning", fs.existsSync(cloudflared) ? cloudflared : "未缓存，公网启动前可确认下载", cloudflared);
  add("custom-tunnel", "自定义隧道程序", config.mode !== "custom" ? "ok" : config.tunnel.executablePath && fs.existsSync(config.tunnel.executablePath) ? "ok" : "warning", config.mode !== "custom" ? "当前未选择自定义隧道" : config.tunnel.executablePath || "未配置可执行文件", config.tunnel.executablePath || undefined);
  add("firewall", "防火墙与端口访问风险", "warning", "桌面程序不会修改防火墙；局域网访问需用户自行放行端口");
  environmentChecks = checks;
  return checks;
}

function codexCandidatesList() {
  const list = [config.codexCliPath];
  if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.exe"));
  if (process.env.APPDATA) list.push(path.join(process.env.APPDATA, "npm", "codex.exe"));
  if (process.env.ProgramFiles) list.push(path.join(process.env.ProgramFiles, "Codex", "codex.exe"));
  return list.filter(Boolean);
}

function findOnPath(command: string) {
  return new Promise<string>((resolve) => {
    const probe = spawn(isWindows ? "where.exe" : "which", [command], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    probe.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    probe.on("close", (code) => resolve(code === 0 ? output.split(/\r?\n/).find(Boolean) || "" : ""));
    probe.on("error", () => resolve(""));
  });
}

function runProbe(file: string, args: string[]) {
  return new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, detail: "Codex 启动超时" }); }, 10000);
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, detail: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, detail: code === 0 ? output.trim().slice(0, 120) : `退出码 ${code}` }); });
  });
}

function canUseDirectory(dir: string) {
  return new Promise<boolean>((resolve) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe, { force: true });
      resolve(true);
    } catch { resolve(false); }
  });
}

function isPortAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function checkNetwork() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: controller.signal });
    clearTimeout(timer);
    return { ok: response.ok, detail: response.ok ? "HTTPS 网络可用" : `HTTPS 返回 ${response.status}` };
  } catch (error) {
    return { ok: false, detail: `网络检查失败: ${error instanceof Error ? error.message : "unknown"}` };
  }
}

function serviceEnv() {
  return {
    ...process.env,
    PORT: String(config.port),
    CODEX_HOME: config.codexHome,
    LOOPILOT_STATE_DIR: config.stateDir,
    LOOPILOT_BRIDGE_MODE: config.safeMode ? "queue" : config.bridgeMode,
    LOOPILOT_TUNNEL_MODE: "none",
    LOOPILOT_DESKTOP_MODE: "1",
    LOOPILOT_HOST: "127.0.0.1",
    ...(config.codexCliPath ? { LOOPILOT_CODEX_COMMAND: config.codexCliPath } : {})
  };
}

async function startService() {
  const runtime = getRuntimePath();
  if (!runtime) throw new Error("内置 Node.js Runtime 缺失");
  const entry = path.join(getCoreDir(), "bin", "loopilot.mjs");
  const args = [entry, config.devMode ? "--dev" : "--prod"];
  if (config.safeMode) args.push("--safe");
  serviceProcess = spawn(runtime, args, { cwd: getCoreDir(), env: serviceEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  attachOutput(serviceProcess, "LooPilot");
  serviceProcess.on("close", (code) => {
    addLog(`[LooPilot] 服务退出，代码 ${code}`);
    if (!stopping) {
      serviceStatus = "offline";
      appStatus = "error";
      void notifyState();
    }
  });
  await waitForHealth();
}

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  serviceStatus = "starting";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/api/health`);
      if (response.ok) { serviceStatus = "healthy"; return; }
    } catch { /* process may still be loading */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("LooPilot 服务启动超时，请检查端口或日志");
}

async function startTunnel() {
  publicUrl = "";
  if (config.mode === "local") { tunnelStatus = "disabled"; return; }
  tunnelStatus = "starting";
  reconnectAttempts = 0;
  if (config.mode === "custom") {
    tunnelProcess = startCustomTunnel();
  } else if (config.mode === "cloudflare-fixed") {
    tunnelProcess = await startFixedCloudflareTunnel();
  } else {
    process.env.LOOPILOT_STATE_DIR = config.stateDir;
    process.env.LOOPILOT_CLOUDFLARED_DIR = path.join(config.stateDir, "bin");
    const module = await import(pathToFileURL(path.join(getCoreDir(), "server", "tunnel.mjs")).href);
    tunnelProcess = await module.startConfiguredTunnel(config.port, { mode: "cloudflare", onUrl: (url: string) => setPublicUrl(url) });
    if (tunnelProcess) attachOutput(tunnelProcess as ChildProcess, "Cloudflare");
  }
  if (!tunnelProcess) throw new Error("隧道进程未启动");
  attachTunnelLifecycle(tunnelProcess);
  if (config.mode === "cloudflare-fixed" && config.tunnel.url) setPublicUrl(config.tunnel.url);
  tunnelStatus = publicUrl || config.mode === "custom" && config.tunnel.url ? "connected" : "starting";
  await waitForTunnelReady();
  await waitForTunnelHealth();
}

async function waitForTunnelReady() {
  if (config.mode === "cloudflare-fixed") return;
  const deadline = Date.now() + config.tunnel.timeoutMs;
  while (Date.now() < deadline) {
    if (publicUrl) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("隧道启动超时，未检测到公网地址；请检查隧道日志和地址提取规则");
}

async function waitForTunnelHealth() {
  const healthUrl = normalizeUrl(config.tunnel.healthUrl);
  if (!healthUrl) return;
  const deadline = Date.now() + config.tunnel.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(healthUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) return;
    } catch {
      // The tunnel may need a few seconds before its public endpoint is reachable.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`隧道健康检查超时: ${healthUrl}`);
}

function startCustomTunnel() {
  const executable = path.resolve(config.tunnel.executablePath);
  if (!fs.existsSync(executable)) throw new Error("自定义隧道可执行文件不存在");
  if (/\.(cmd|bat|ps1)$/i.test(executable)) throw new Error("自定义隧道必须是可执行文件，不能使用 Shell 包装脚本");
  const localUrl = `http://127.0.0.1:${config.port}`;
  const args = config.tunnel.args.map((item) => String(item).replaceAll("${PORT}", String(config.port)).replaceAll("${LOCAL_URL}", localUrl).replaceAll("${LOCAL_HOST}", "127.0.0.1"));
  const child = spawn(executable, args, {
    cwd: config.tunnel.cwd ? path.resolve(config.tunnel.cwd) : path.dirname(executable),
    env: { ...process.env, ...config.tunnel.env, LOOPILOT_LOCAL_URL: localUrl },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  attachOutput(child, "Custom tunnel");
  const pattern = new RegExp(config.tunnel.urlPattern || "https?://[^\\s\"'<>]+", "i");
  const parse = (chunk: Buffer) => { const match = chunk.toString().match(pattern)?.[0]; if (match) setPublicUrl(normalizeUrl(match)); };
  child.stdout?.on("data", parse);
  child.stderr?.on("data", parse);
  if (config.tunnel.url) setPublicUrl(normalizeUrl(config.tunnel.url));
  return child;
}

async function startFixedCloudflareTunnel() {
  if (!config.tunnel.token) throw new Error("固定域名 Tunnel 需要 Tunnel Token");
  process.env.LOOPILOT_STATE_DIR = config.stateDir;
  process.env.LOOPILOT_CLOUDFLARED_DIR = path.join(config.stateDir, "bin");
  const module = await import(pathToFileURL(path.join(getCoreDir(), "server", "tunnel.mjs")).href);
  const executable = await module.ensureCloudflaredBinary();
  // The token is passed through an environment variable, never as a command-line argument or log value.
  const child = spawn(executable, ["tunnel", "--no-autoupdate", "run"], {
    env: { ...process.env, TUNNEL_TOKEN: config.tunnel.token },
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  attachOutput(child, "Cloudflare fixed");
  return child;
}

function normalizeUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString().replace(/\/$/, "") : "";
  } catch { return ""; }
}

function setPublicUrl(value: string) {
  const normalized = normalizeUrl(value);
  if (!normalized) return;
  publicUrl = normalized;
  tunnelStatus = "connected";
  void notifyState();
}

function attachTunnelLifecycle(child: ChildProcess | { on?: ChildProcess["on"] }) {
  child.on?.("close", (code: number | null) => {
    if (stopping) return;
    tunnelStatus = "disconnected";
    addLog(`[Tunnel] 隧道退出，代码 ${code}`);
    void notifyState();
    if (config.autoReconnect && config.tunnel.autoReconnect && reconnectAttempts < 3) {
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => { void startTunnel().catch((error) => addLog(`[Tunnel] 重连失败: ${error.message}`)); }, Math.min(30000, reconnectAttempts * 5000));
    }
  });
}

async function stop() {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  appStatus = serviceProcess || tunnelProcess ? "stopping" : "stopped";
  tunnelStatus = "disabled";
  await killProcess(tunnelProcess, config.tunnel.stopMethod === "tree");
  tunnelProcess = null;
  await killProcess(serviceProcess, true);
  serviceProcess = null;
  serviceStatus = "offline";
  publicUrl = "";
  appStatus = "stopped";
  stopping = false;
  await notifyState();
  return buildSnapshot();
}

async function regenerateTunnel() {
  if (config.mode !== "cloudflare-temporary") throw new Error("只有 Cloudflare 临时 Tunnel 支持重新生成地址");
  if (serviceStatus !== "healthy") throw new Error("请先启动 LooPilot 服务");
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  await killProcess(tunnelProcess, true);
  tunnelProcess = null;
  publicUrl = "";
  tunnelStatus = "disabled";
  stopping = false;
  await startTunnel();
  await notifyState();
  return buildSnapshot();
}

function killProcess(child: ChildProcess | { kill?: () => void } | null, tree: boolean) {
  if (!child) return Promise.resolve();
  const pid = (child as ChildProcess).pid;
  try { child.kill?.(); } catch { /* already exited */ }
  if (!isWindows || !tree || !pid) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("close", () => resolve());
    killer.on("error", () => resolve());
    setTimeout(resolve, 3000).unref();
  });
}

async function start(options: { safeMode?: boolean; mode?: LaunchMode } = {}) {
  if (appStatus === "running" || appStatus === "starting") return buildSnapshot();
  if (options.safeMode !== undefined) config.safeMode = Boolean(options.safeMode);
  if (options.mode) { config.mode = options.mode; config.tunnel.mode = options.mode; }
  config.bridgeMode = config.safeMode ? "queue" : "app-server";
  config.tunnel.mode = config.mode;
  saveConfigFile();
  await checkEnvironment();
  const blockers = environmentChecks.filter((item) => item.severity === "blocked");
  if (blockers.length) {
    appStatus = "error";
    addLog(`[Startup] 启动阻断: ${blockers.map((item) => item.label).join(", ")}`);
    return buildSnapshot();
  }
  stopping = false;
  appStatus = "starting";
  await notifyState();
  try {
    await startService();
    appStatus = "running";
    if (config.mode !== "local") await startTunnel();
    await notifyState();
  } catch (error) {
    addLog(`[Startup] ${error instanceof Error ? error.message : String(error)}`);
    await stop();
    appStatus = "error";
  }
  return buildSnapshot();
}

function registerIpc() {
  ipcMain.handle("snapshot", () => buildSnapshot());
  ipcMain.handle("check-environment", async () => { const result = await checkEnvironment(); await notifyState(); return result; });
  ipcMain.handle("start", (_event, options) => start(options || {}));
  ipcMain.handle("stop", () => stop());
  ipcMain.handle("restart", async () => { await stop(); return start(); });
  ipcMain.handle("regenerate-tunnel", () => regenerateTunnel());
  ipcMain.handle("save-config", async (_event, partial: Partial<AppConfig>) => {
    const next = normalizeConfig({ ...config, ...partial, tunnel: { ...config.tunnel, ...(partial.tunnel || {}) } });
    config = next;
    saveConfigFile();
    await checkEnvironment();
    return buildSnapshot();
  });
  ipcMain.handle("copy-text", (_event, value: string) => clipboard.writeText(String(value || "")));
  ipcMain.handle("open-url", async (_event, value: string) => {
    const url = normalizeUrl(value);
    if (!url) throw new Error("只允许打开 http 或 https 地址");
    await shell.openExternal(url);
  });
  ipcMain.handle("save-qr", async (_event, dataUrl: string) => {
    const result = await dialog.showSaveDialog({ defaultPath: "LooPilot-pairing.png", filters: [{ name: "PNG", extensions: ["png"] }] });
    if (result.canceled || !result.filePath) return "";
    const match = String(dataUrl).match(/^data:image\/png;base64,(.+)$/);
    if (!match) throw new Error("二维码格式无效");
    fs.writeFileSync(result.filePath, Buffer.from(match[1], "base64"));
    return result.filePath;
  });
  ipcMain.handle("choose-file", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openFile"] });
    return result.canceled ? "" : result.filePaths[0] || "";
  });
  ipcMain.handle("choose-directory", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? "" : result.filePaths[0] || "";
  });
  ipcMain.handle("import-config", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const imported = JSON.parse(fs.readFileSync(result.filePaths[0], "utf8"));
    config = normalizeConfig({ ...config, ...imported, tunnel: { ...config.tunnel, ...(imported.tunnel || {}) } });
    saveConfigFile();
    await checkEnvironment();
    return buildSnapshot();
  });
  ipcMain.handle("export-config", async () => {
    const result = await dialog.showSaveDialog({ defaultPath: "LooPilot-config.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (result.canceled || !result.filePath) return "";
    fs.writeFileSync(result.filePath, `${JSON.stringify(serializeConfig(), null, 2)}\n`, "utf8");
    return result.filePath;
  });
  ipcMain.handle("test-tunnel", async () => {
    const target = normalizeUrl(config.tunnel.healthUrl || publicUrl || config.tunnel.url);
    if (!target) return { ok: false, detail: "尚未配置可测试的公网或健康检查地址" };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(target, { signal: controller.signal });
      clearTimeout(timer);
      return { ok: response.ok, detail: response.ok ? `连接正常: ${target}` : `远端返回 HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: `连接失败: ${error instanceof Error ? error.message : "unknown"}` };
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "LooPilot 控制面板",
    width: 860,
    height: 760,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: "#eef3f5",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  if (!app.isPackaged) void mainWindow.loadURL("http://127.0.0.1:5174");
  else void mainWindow.loadFile(path.join(__dirname, "..", "renderer-dist", "index.html"));
}

async function main() {
  await app.whenReady();
  configDir = path.join(app.getPath("appData"), "LooPilot");
  configPath = path.join(configDir, "config.json");
  secretPath = path.join(configDir, "secret.bin");
  loadConfig();
  parseLaunchArgs();
  registerIpc();
  createWindow();
  environmentChecks = await checkEnvironment();
  if (config.autoStart || process.argv.some((arg) => ["--public", "--safe"].includes(arg))) {
    setTimeout(() => { void start({}); }, 400);
  }
  app.on("activate", () => { if (!mainWindow) createWindow(); });
}

app.on("before-quit", (event) => {
  if (quitRequested) return;
  quitRequested = true;
  event.preventDefault();
  void stop().finally(() => app.exit(0));
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
void main();

export { normalizeConfig, redact };
