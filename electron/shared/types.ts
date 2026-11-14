export type LaunchMode = "local" | "cloudflare-temporary" | "cloudflare-fixed" | "custom";
export type Severity = "ok" | "warning" | "blocked";

export interface TunnelConfig {
  mode: LaunchMode;
  token: string;
  executablePath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  url: string;
  urlPattern: string;
  healthUrl: string;
  timeoutMs: number;
  autoReconnect: boolean;
  stopMethod: "terminate" | "tree";
}

export interface AppConfig {
  port: number;
  mode: LaunchMode;
  safeMode: boolean;
  devMode: boolean;
  codexHome: string;
  codexCliPath: string;
  stateDir: string;
  bridgeMode: "app-server" | "queue";
  logLevel: "error" | "warn" | "info" | "debug";
  autoStart: boolean;
  autoReconnect: boolean;
  language: "zh-CN" | "en-US";
  tunnel: TunnelConfig;
}

export interface EnvironmentCheck {
  id: string;
  label: string;
  severity: Severity;
  detail: string;
  path?: string;
}

export interface AppSnapshot {
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  serviceStatus: "offline" | "starting" | "healthy" | "unhealthy";
  healthStatus: Severity;
  bridgeStatus: "disabled" | "queue" | "ready" | "missing";
  tunnelStatus: "disabled" | "starting" | "connected" | "disconnected" | "error";
  mode: LaunchMode;
  version: string;
  buildLabel: string;
  port: number;
  localUrl: string;
  authorizedUrl: string;
  pairingCode: string;
  publicUrl: string;
  qrPayload: string;
  qrDataUrl: string;
  envChecks: EnvironmentCheck[];
  logs: string[];
  config: Omit<AppConfig, "tunnel"> & { tunnel: Omit<TunnelConfig, "token"> };
}

export interface DesktopApi {
  getSnapshot(): Promise<AppSnapshot>;
  checkEnvironment(): Promise<EnvironmentCheck[]>;
  start(options?: { safeMode?: boolean; mode?: LaunchMode }): Promise<AppSnapshot>;
  stop(): Promise<AppSnapshot>;
  restart(): Promise<AppSnapshot>;
  regenerateTunnel(): Promise<AppSnapshot>;
  saveConfig(config: Partial<AppConfig>): Promise<AppSnapshot>;
  copyText(value: string): Promise<void>;
  openUrl(value: string): Promise<void>;
  saveQr(dataUrl: string): Promise<string>;
  chooseFile(): Promise<string>;
  chooseDirectory(): Promise<string>;
  importConfig(): Promise<AppSnapshot | null>;
  exportConfig(): Promise<string>;
  testTunnel(): Promise<{ ok: boolean; detail: string }>;
  onState(listener: (snapshot: AppSnapshot) => void): () => void;
  onLog(listener: (line: string) => void): () => void;
}

declare global {
  interface Window {
    loopilot: DesktopApi;
  }
}
