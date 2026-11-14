const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("loopilot", {
  getState: () => ipcRenderer.invoke("loopilot:get-state"),
  getConfig: () => ipcRenderer.invoke("loopilot:get-config"),
  saveConfig: (config) => ipcRenderer.invoke("loopilot:save-config", config),
  start: (options) => ipcRenderer.invoke("loopilot:start", options),
  stop: () => ipcRenderer.invoke("loopilot:stop"),
  restart: (options) => ipcRenderer.invoke("loopilot:restart", options),
  inspect: () => ipcRenderer.invoke("loopilot:inspect"),
  copyText: (value) => ipcRenderer.invoke("loopilot:copy-text", value),
  openExternal: (url) => ipcRenderer.invoke("loopilot:open-external", url),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("loopilot:state", listener);
    return () => ipcRenderer.removeListener("loopilot:state", listener);
  }
});
