import { contextBridge, ipcRenderer } from "electron";
import type { AppConfig, DesktopApi } from "./shared/types.js";

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke("snapshot"),
  checkEnvironment: () => ipcRenderer.invoke("check-environment"),
  start: (options) => ipcRenderer.invoke("start", options),
  stop: () => ipcRenderer.invoke("stop"),
  restart: () => ipcRenderer.invoke("restart"),
  regenerateTunnel: () => ipcRenderer.invoke("regenerate-tunnel"),
  saveConfig: (config: Partial<AppConfig>) => ipcRenderer.invoke("save-config", config),
  copyText: (value) => ipcRenderer.invoke("copy-text", value),
  openUrl: (value) => ipcRenderer.invoke("open-url", value),
  saveQr: (dataUrl) => ipcRenderer.invoke("save-qr", dataUrl),
  chooseFile: () => ipcRenderer.invoke("choose-file"),
  chooseDirectory: () => ipcRenderer.invoke("choose-directory"),
  importConfig: () => ipcRenderer.invoke("import-config"),
  exportConfig: () => ipcRenderer.invoke("export-config"),
  testTunnel: () => ipcRenderer.invoke("test-tunnel"),
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) => listener(snapshot);
    ipcRenderer.on("state", handler);
    return () => ipcRenderer.removeListener("state", handler);
  },
  onLog: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, line: string) => listener(line);
    ipcRenderer.on("log", handler);
    return () => ipcRenderer.removeListener("log", handler);
  }
};

contextBridge.exposeInMainWorld("loopilot", api);
