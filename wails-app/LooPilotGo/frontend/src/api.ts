import { EventsOn, EventsOff } from "../wailsjs/runtime/runtime";
import type { AppConfig, AppSnapshot, DesktopApi, EnvironmentCheck, LaunchMode, TunnelTestResult } from "./types";

const APP = () => window.go.main.App as Record<string, (value?: unknown) => Promise<unknown>>;

export const loopilot: DesktopApi = {
  getSnapshot: () => APP().GetRuntimeStatus() as Promise<AppSnapshot>,
  checkEnvironment: () => APP().CheckEnvironment() as Promise<EnvironmentCheck[]>,
  start: (options) => APP().StartService(options || {}) as Promise<AppSnapshot>,
  stop: () => APP().StopService() as Promise<AppSnapshot>,
  restart: () => APP().RestartService() as Promise<AppSnapshot>,
  saveConfig: (config: Partial<AppConfig>) => APP().SaveSettings(config) as Promise<AppSnapshot>,
  setMode: (mode: LaunchMode) => APP().SetLaunchMode(mode) as Promise<AppSnapshot>,
  copyText: (value: string) => APP().CopyText(value) as Promise<void>,
  openUrl: (value: string) => APP().OpenBrowser(value) as Promise<void>,
  saveQr: (dataUrl: string) => APP().SaveQr(dataUrl) as Promise<string>,
  chooseFile: () => APP().SelectFile() as Promise<string>,
  chooseDirectory: () => APP().SelectDirectory() as Promise<string>,
  importConfig: () => APP().ImportConfig() as Promise<AppSnapshot | null>,
  exportConfig: () => APP().ExportConfig() as Promise<string>,
  testTunnel: () => APP().TestTunnel() as Promise<TunnelTestResult>,
  onState: (listener) => { EventsOn("state", listener); return () => EventsOff("state"); },
  onLog: (listener) => { EventsOn("log-line", listener); return () => EventsOff("log-line"); }
};

declare global {
  interface Window { go: { main: { App: Record<string, unknown> } } }
}

export type { AppConfig, AppSnapshot, EnvironmentCheck, LaunchMode } from "./types";
