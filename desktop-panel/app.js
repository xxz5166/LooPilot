const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".tab-panel");
const toast = document.querySelector("#toast");
const desktopApi = window.loopilot;
let toastTimer;
let currentState = null;

function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function getMode() {
  return document.querySelector("input[name=mode]:checked")?.value || "local";
}

function modeLabel(mode) {
  return { local: "本地模式", quick: "Cloudflare 临时地址", fixed: "Cloudflare 固定域名", custom: "自定义隧道" }[mode] || "本地模式";
}

function setServiceState(state) {
  const running = state.service === "running";
  const starting = state.service === "starting" || state.service === "stopping";
  const startButton = document.querySelector("#startButton");
  const stopButton = document.querySelector("#stopButton");
  const restartButton = document.querySelector("#restartButton");
  startButton.disabled = running || starting;
  stopButton.disabled = !running && !starting;
  restartButton.disabled = !running;

  document.querySelector(".status-dot").classList.toggle("running", running);
  document.querySelector(".status-dot").classList.toggle("stopped", !running);
  document.querySelector("#headerStatus").textContent = running ? "运行中" : starting ? "处理中" : state.service === "error" ? "启动失败" : "已停止";
  const badge = document.querySelector("#serviceBadge");
  badge.textContent = running ? "运行中" : starting ? "处理中" : state.service === "error" ? "异常" : "未运行";
  badge.className = `mini-badge ${running ? "success" : state.service === "error" ? "warning" : "neutral"}`;
  document.querySelector("#serviceStatus").textContent = running ? "服务运行正常" : starting ? "正在处理服务进程" : state.service === "error" ? "服务启动失败" : "服务已停止";
  document.querySelector("#serviceDescription").textContent = running ? "LooPilot 与控制面板已建立连接" : "启动后将运行 LooPilot 与 Codex Bridge";
  document.querySelector("#healthStatus").textContent = state.health === "healthy" ? "正常" : state.health === "blocked" ? "阻断" : starting ? "检查中" : "等待启动";
  document.querySelector("#modeStatus").textContent = modeLabel(state.mode);
  document.querySelector("#bridgeStatus").textContent = state.bridge === "connected" ? "已连接" : state.bridge === "safe-mode" ? "Safe 模式" : state.bridge === "starting" ? "启动中" : "未启动";
  document.querySelector("#servicePort").value = state.port || 4317;
  document.querySelector("#safeModeToggle").checked = Boolean(state.safe);
}

function applyState(state) {
  currentState = state;
  setServiceState(state);
  const localInput = document.querySelector(".field input[value^='http://127.0.0.1']");
  if (localInput && state.localUrl) localInput.value = state.localUrl;
  const tokenInput = document.querySelector("#tokenUrl");
  if (tokenInput) tokenInput.dataset.authorizedUrl = state.authorizedUrl || "";
  const publicInput = document.querySelector("#publicUrl");
  if (publicInput) publicInput.value = state.publicUrl || "尚未启动公网隧道";
  const code = document.querySelector("#pairingCode");
  if (code && state.pairingCode) code.textContent = `${state.pairingCode.slice(0, 3)} ${state.pairingCode.slice(3)}`;
  const copyCode = document.querySelector("[data-copy='482917']");
  if (copyCode && state.pairingCode) copyCode.dataset.copy = state.pairingCode;
  const copyPublic = document.querySelector("#publicUrl")?.closest(".input-with-action")?.querySelector("[data-copy]");
  if (copyPublic) copyPublic.dataset.copy = state.publicUrl || "";
}

async function invoke(action, ...args) {
  if (!desktopApi) return null;
  try {
    return await desktopApi[action](...args);
  } catch (error) {
    notify(error.message || "操作失败");
    return null;
  }
}

tabs.forEach((tab) => tab.addEventListener("click", () => {
  tabs.forEach((item) => item.classList.toggle("active", item === tab));
  panels.forEach((panel) => panel.classList.toggle("active", panel.id === tab.dataset.tab));
}));

document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
  const value = button.dataset.copy;
  if (!value) return notify("当前还没有可复制的地址");
  if (desktopApi) await invoke("copyText", value);
  else await navigator.clipboard?.writeText(value);
  notify("已复制到剪贴板");
}));

document.querySelector("#startButton").addEventListener("click", async () => {
  const state = await invoke("start", { mode: getMode(), safeMode: document.querySelector("#safeModeToggle").checked, port: Number(document.querySelector("#servicePort").value) });
  if (state) notify("LooPilot 服务已启动");
});
document.querySelector("#stopButton").addEventListener("click", async () => {
  const state = await invoke("stop");
  if (state) notify("服务和隧道已停止");
});
document.querySelector("#restartButton").addEventListener("click", async () => {
  const state = await invoke("restart", { mode: getMode(), safeMode: document.querySelector("#safeModeToggle").checked, port: Number(document.querySelector("#servicePort").value) });
  if (state) notify("LooPilot 服务已重启");
});

document.querySelector("#runCheck").addEventListener("click", async (event) => {
  event.target.textContent = "检查中…";
  const result = await invoke("inspect");
  event.target.textContent = "重新检查";
  notify(result?.overall === "blocked" ? "环境检查发现阻断项" : "环境检查已完成");
});
document.querySelector("#refreshButton").addEventListener("click", async () => { await invoke("getState"); notify("状态已刷新"); });
document.querySelector("#saveQr").addEventListener("click", () => notify("二维码保存功能将在下一版接入"));
document.querySelector("#exportConfig").addEventListener("click", () => notify("配置导出功能将在下一版接入"));

document.querySelector("#revealToken").addEventListener("click", (event) => {
  const input = document.querySelector("#tokenUrl");
  const hidden = input.value.includes("••");
  const authorizedUrl = input.dataset.authorizedUrl || "";
  input.value = hidden ? authorizedUrl || "服务启动后生成" : `${currentState?.localUrl || "http://127.0.0.1:4317"}/?token=••••••••••••`;
  event.currentTarget.textContent = hidden ? "◌" : "◉";
});

document.querySelectorAll("input[name=mode]").forEach((input) => input.addEventListener("change", () => {
  document.querySelector("#modeStatus").textContent = modeLabel(input.value);
  notify(`已选择${modeLabel(input.value)}`);
}));

if (desktopApi) {
  desktopApi.onState(applyState);
  desktopApi.getState().then(applyState);
  desktopApi.getConfig().then((config) => {
    if (config?.port) document.querySelector("#servicePort").value = config.port;
    const radio = document.querySelector(`input[name=mode][value="${config?.mode || "local"}"]`);
    if (radio) radio.checked = true;
    if (config?.safe) document.querySelector("#safeModeToggle").checked = true;
  });
}
