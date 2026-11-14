import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import {
  CheckCircle2, ChevronRight, Copy, FolderOpen, Globe2, HardDrive, Info, KeyRound, Link2,
  LoaderCircle, Play, Power, RefreshCw, Save, Server, Settings2, ShieldAlert, Square,
  TerminalSquare, Upload, Download, Wifi, XCircle
} from "lucide-react";
import type { AppConfig, AppSnapshot, EnvironmentCheck, LaunchMode } from "../../shared/types.js";
import "./styles.css";

type Tab = "overview" | "public" | "advanced";

const modeLabels: Record<LaunchMode, string> = {
  local: "仅本机",
  "cloudflare-temporary": "Cloudflare 临时 Tunnel",
  "cloudflare-fixed": "Cloudflare 固定域名 Tunnel",
  custom: "自定义内网穿透"
};

function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [showPairing, setShowPairing] = useState(true);
  const [message, setMessage] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");

  useEffect(() => {
    let active = true;
    window.loopilot.getSnapshot().then((value) => { if (active) { setSnapshot(value); setLogs(value.logs); } });
    const offState = window.loopilot.onState((value) => { setSnapshot(value); setLogs(value.logs); });
    const offLog = window.loopilot.onLog((line) => setLogs((current) => [...current, line].slice(-120)));
    return () => { active = false; offState(); offLog(); };
  }, []);

  useEffect(() => {
    let active = true;
    if (!snapshot?.qrPayload) {
      setQrDataUrl("");
      return () => { active = false; };
    }
    QRCode.toDataURL(snapshot.qrPayload, { width: 240, margin: 1 })
      .then((value) => { if (active) setQrDataUrl(value); })
      .catch(() => { if (active) setQrDataUrl(""); });
    return () => { active = false; };
  }, [snapshot?.qrPayload]);

  const run = async (action: () => Promise<AppSnapshot | void>, success = "操作完成") => {
    setBusy(true);
    try {
      const value = await action();
      if (value) setSnapshot(value);
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  if (!snapshot) return <div className="loading"><LoaderCircle className="spin" /> 正在读取控制面板状态...</div>;
  const mode = snapshot.mode;
  const publicMode = mode !== "local";
  const tokenUrl = snapshot.authorizedUrl;
  const maskedUrl = tokenUrl ? tokenUrl.replace(/token=[^&]+/, "token=••••••••") : "尚未生成";

  async function changeMode(next: LaunchMode) {
    await run(() => window.loopilot.saveConfig({ mode: next, tunnel: { ...snapshot.config.tunnel, mode: next } }), "模式已保存");
  }

  async function start() {
    if (publicMode && !window.confirm("公网模式会让本机服务可从互联网访问；首次使用时可能下载并校验 cloudflared。请确认已了解风险，并只分享配对码给可信设备。")) return;
    await run(() => window.loopilot.start({ mode }), "服务已启动");
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Server size={21} /></div><div><strong>LooPilot</strong><span>Windows 控制面板</span></div></div>
        <div className="top-meta"><span className={`status-dot ${snapshot.status}`}></span><span>{statusLabel(snapshot.status)}</span><span className="version">v{snapshot.version} · {snapshot.buildLabel}</span></div>
      </header>
      <nav className="tabs">
        <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><HardDrive size={16} /> 概览</button>
        <button className={tab === "public" ? "active" : ""} onClick={() => setTab("public")}><Globe2 size={16} /> 公网访问</button>
        <button className={tab === "advanced" ? "active" : ""} onClick={() => setTab("advanced")}><Settings2 size={16} /> 高级设置</button>
      </nav>
      <main className="content">
        {tab === "overview" && <ReferenceOverview snapshot={snapshot} qrDataUrl={qrDataUrl} maskedUrl={maskedUrl} showToken={showToken} showPairing={showPairing} setShowToken={setShowToken} setShowPairing={setShowPairing} busy={busy} onStart={start} onStop={() => run(() => window.loopilot.stop(), "服务已停止")} onRestart={() => run(() => window.loopilot.restart(), "服务已重启")} onCheck={() => run(async () => { await window.loopilot.checkEnvironment(); return window.loopilot.getSnapshot(); }, "环境检查已完成")} onCopy={(value) => run(() => window.loopilot.copyText(value), "已复制")} onOpen={(value) => run(() => window.loopilot.openUrl(value), "已打开浏览器")} onSaveQr={(value) => run(() => window.loopilot.saveQr(value), "二维码已保存")} />}
        {tab === "public" && <ReferencePublicAccess snapshot={snapshot} token={snapshot.config.tunnel.token || ""} onMode={changeMode} onSave={(partial) => run(() => window.loopilot.saveConfig(partial), "公网配置已保存")} onTest={() => run(async () => { const result = await window.loopilot.testTunnel(); if (!result.ok) throw new Error(result.detail); }, "连接测试成功")} onRegenerate={() => run(() => window.loopilot.regenerateTunnel(), "临时公网地址已重新生成")} />}
        {tab === "advanced" && <ReferenceAdvanced snapshot={snapshot} onSave={(partial) => run(() => window.loopilot.saveConfig(partial), "高级设置已保存")} onImport={() => run(async () => (await window.loopilot.importConfig()) || snapshot, "配置已导入")} onExport={() => run(async () => { await window.loopilot.exportConfig(); return snapshot; }, "配置已导出")} logs={logs} />}
      </main>
      {message && <button className="toast" onClick={() => setMessage("")}>{message}<XCircle size={14} /></button>}
      <footer><span><ShieldAlert size={14} /> 不修改 PATH、防火墙或管理员权限</span><span>本地状态目录：{snapshot.config.stateDir}</span></footer>
    </div>
  );
}

function Overview(props: {
  snapshot: AppSnapshot; qrDataUrl: string; maskedUrl: string; showToken: boolean; showPairing: boolean; setShowToken: (value: boolean) => void; setShowPairing: (value: boolean) => void; busy: boolean;
  onStart: () => void; onStop: () => void; onRestart: () => void; onCheck: () => void; onCopy: (value: string) => void; onOpen: (value: string) => void; onSaveQr: (value: string) => void;
}) {
  const { snapshot } = props;
  const checks = snapshot.envChecks;
  const pairingServer = snapshot.publicUrl || snapshot.localUrl;
  return <>
    <section className="hero-row"><div><p className="eyebrow">SERVICE CONTROL</p><h1>运行概览</h1><p className="subtle">从这里管理 LooPilot 服务、Codex Bridge 和远程连接。</p></div><div className="actions"><button className="primary" disabled={props.busy || snapshot.status === "running"} onClick={props.onStart}><Play size={16} /> 启动</button><button disabled={props.busy || snapshot.status === "stopped"} onClick={props.onStop}><Square size={15} /> 停止</button><button disabled={props.busy} onClick={props.onRestart}><RefreshCw size={15} /> 重启</button></div></section>
    <section className="metrics"><Metric label="服务状态" value={statusLabel(snapshot.status)} tone={snapshot.status === "running" ? "ok" : snapshot.status === "error" ? "bad" : "neutral"} /><Metric label="健康检查" value={severityLabel(snapshot.healthStatus)} tone={snapshot.healthStatus === "ok" ? "ok" : snapshot.healthStatus === "blocked" ? "bad" : "warn"} /><Metric label="启动模式" value={modeLabels[snapshot.mode]} /><Metric label="Codex Bridge" value={bridgeLabel(snapshot.bridgeStatus)} tone={snapshot.bridgeStatus === "ready" || snapshot.bridgeStatus === "queue" ? "ok" : "warn"} /></section>
    <div className="grid-two"><section className="panel"><PanelTitle icon={<Link2 size={17} />} title="连接信息" action={<span className="live"><i />{snapshot.tunnelStatus === "connected" ? "公网已连接" : "本机服务"}</span>} /><div className="connection-list"><InfoRow label="配对码"><strong className="pairing">{props.showPairing ? snapshot.pairingCode || "------" : "••••••"}</strong><IconButton title="显示/隐藏配对码" onClick={() => props.setShowPairing(!props.showPairing)}>{props.showPairing ? "隐藏" : "显示"}</IconButton><IconButton title="复制配对码" onClick={() => props.onCopy(snapshot.pairingCode)}>复制</IconButton></InfoRow><InfoRow label="本地访问地址"><CodeValue value={snapshot.localUrl} onCopy={props.onCopy} onOpen={props.onOpen} /></InfoRow><InfoRow label="本地授权地址"><CodeValue value={props.showToken ? snapshot.authorizedUrl : props.maskedUrl} copyValue={snapshot.authorizedUrl} onCopy={props.onCopy} onOpen={props.onOpen} onToggle={() => props.setShowToken(!props.showToken)} masked={!props.showToken} /></InfoRow><InfoRow label="公网访问地址"><CodeValue value={snapshot.publicUrl || "未启动公网隧道"} onCopy={props.onCopy} onOpen={props.onOpen} /></InfoRow></div><p className="hint"><Info size={14} />当前服务绑定 127.0.0.1，仅本机可访问；如需局域网访问，请在网络层配置转发并确认 Windows 防火墙规则。</p></section><section className="panel qr-panel"><PanelTitle icon={<Wifi size={17} />} title="手机配对" /><div className="qr-wrap">{props.qrDataUrl ? <img src={props.qrDataUrl} alt="LooPilot 配对二维码" /> : <div className="qr-empty">服务启动后生成</div>}</div><p className="qr-caption">二维码只包含地址和 6 位配对码，不包含长期 Token。</p><div className="qr-actions"><button disabled={!props.qrDataUrl} onClick={() => props.onSaveQr(props.qrDataUrl)}><Save size={14} />保存二维码</button><button disabled={!props.qrDataUrl} onClick={() => props.onCopy(JSON.stringify({ type: "loopilot-pairing", version: 1, server: pairingServer, code: snapshot.pairingCode }))}><Copy size={14} />复制内容</button></div></section></div>
    <section className="panel checks"><PanelTitle icon={<ShieldAlert size={17} />} title="环境检查" action={<button className="link-button" onClick={props.onCheck}><RefreshCw size={14} />重新检查</button>} /><div className="check-list">{checks.map((check) => <CheckRow key={check.id} check={check} />)}</div><p className="hint"><Info size={14} /> Codex 缺失不会阻止 Safe 模式；Safe 模式只排队手机消息，不启动 Codex Bridge。</p></section>
  </>;
}

function PublicAccess({ snapshot, token, onMode, onSave, onTest, onRegenerate }: { snapshot: AppSnapshot; token: string; onMode: (mode: LaunchMode) => void; onSave: (config: Partial<AppConfig>) => void; onTest: () => void; onRegenerate: () => void }) {
  const tunnel = snapshot.config.tunnel;
  const [tokenValue, setTokenValue] = useState(token);
  const [showTunnelToken, setShowTunnelToken] = useState(false);
  const [argsValue, setArgsValue] = useState(tunnel.args.join("\n"));
  const [envValue, setEnvValue] = useState(Object.entries(tunnel.env).map(([key, value]) => `${key}=${value}`).join("\n"));
  const [urlPattern, setUrlPattern] = useState(tunnel.urlPattern);
  const [executable, setExecutable] = useState(tunnel.executablePath);
  const isCustom = snapshot.mode === "custom";
  const save = () => {
    const env: Record<string, string> = {};
    for (const line of envValue.split(/\r?\n/)) { const index = line.indexOf("="); if (index > 0) env[line.slice(0, index).trim()] = line.slice(index + 1); }
    onSave({ tunnel: { ...tunnel, ...(tokenValue ? { token: tokenValue } : {}), executablePath: executable, args: argsValue.split(/\r?\n/).filter(Boolean), env, urlPattern } });
  };
  return <><section className="hero-row"><div><p className="eyebrow">REMOTE ACCESS</p><h1>公网访问</h1><p className="subtle">隧道由主进程创建和清理，Token 不会进入命令行、日志或二维码。</p></div><div className="actions"><button className="primary" onClick={onTest}><Wifi size={15} />连接测试</button>{snapshot.mode === "cloudflare-temporary" && <button onClick={onRegenerate}><RefreshCw size={15} />重新生成地址</button>}<button onClick={save}><Save size={15} />应用配置</button></div></section><section className="panel"><PanelTitle icon={<Globe2 size={17} />} title="连接模式" /><div className="mode-grid">{(Object.keys(modeLabels) as LaunchMode[]).map((mode) => <button key={mode} className={`mode-card ${snapshot.mode === mode ? "selected" : ""}`} onClick={() => onMode(mode)}><span className="radio" /> <span><strong>{modeLabels[mode]}</strong><small>{mode === "local" ? "不创建公网连接，仅供本机使用" : mode === "cloudflare-temporary" ? "自动生成临时 trycloudflare.com 地址" : mode === "cloudflare-fixed" ? "使用已配置的固定域名 Tunnel" : "以无 Shell 方式启动任意程序"}</small></span></button>)}</div></section>{snapshot.mode !== "local" && <section className="panel form-panel"><PanelTitle icon={<TerminalSquare size={17} />} title="Tunnel 配置" /><div className="form-grid"><Field label="公网地址"><input value={tunnel.url} onChange={(event) => onSave({ tunnel: { ...tunnel, url: event.target.value } })} placeholder="https://example.com" /></Field><Field label="Tunnel Token"><div className="input-action"><input type={showTunnelToken ? "text" : "password"} value={tokenValue} onChange={(event) => setTokenValue(event.target.value)} placeholder="固定域名模式使用；留空保持已保存值" /><button type="button" onClick={() => setShowTunnelToken(!showTunnelToken)}>{showTunnelToken ? "隐藏" : "显示"}</button></div></Field><Field label="健康检查 URL"><input value={tunnel.healthUrl} onChange={(event) => onSave({ tunnel: { ...tunnel, healthUrl: event.target.value } })} placeholder="可选，例如 https://example.com/api/health" /></Field><Field label="启动超时（毫秒）"><input type="number" min="10000" max="600000" value={tunnel.timeoutMs} onChange={(event) => onSave({ tunnel: { ...tunnel, timeoutMs: Number(event.target.value) } })} /></Field>{isCustom && <><Field label="隧道程序路径" wide><div className="input-action"><input value={executable} onChange={(event) => setExecutable(event.target.value)} placeholder="选择 .exe 文件" /><button onClick={async () => { const value = await window.loopilot.chooseFile(); if (value) setExecutable(value); }}><FolderOpen size={15} /></button></div></Field><Field label="启动参数" wide><textarea value={argsValue} onChange={(event) => setArgsValue(event.target.value)} placeholder={'每行一个参数，例如\nhttp\n${PORT}'} /><small>支持 ${"${PORT}"}、${"${LOCAL_URL}"}、${"${LOCAL_HOST}"}，不会经过 Shell。</small></Field><Field label="工作目录"><input value={tunnel.cwd} onChange={(event) => onSave({ tunnel: { ...tunnel, cwd: event.target.value } })} /></Field><Field label="环境变量"><textarea value={envValue} onChange={(event) => setEnvValue(event.target.value)} placeholder="KEY=value，每行一个" /></Field><Field label="公网地址提取规则" wide><input value={urlPattern} onChange={(event) => setUrlPattern(event.target.value)} /></Field><Field label="停止方式"><select value={tunnel.stopMethod} onChange={(event) => onSave({ tunnel: { ...tunnel, stopMethod: event.target.value as AppConfig["tunnel"]["stopMethod"] } })}><option value="tree">结束进程树</option><option value="terminate">仅结束进程</option></select></Field></>}</div><div className="form-footer"><label className="switch-row"><input type="checkbox" checked={tunnel.autoReconnect} onChange={(event) => onSave({ tunnel: { ...tunnel, autoReconnect: event.target.checked } })} /><span className="switch" /><span>自动重连</span></label><label className="switch-row"><input type="checkbox" checked={snapshot.config.autoReconnect} onChange={(event) => onSave({ autoReconnect: event.target.checked })} /><span className="switch" /><span>服务异常时自动恢复</span></label></div></section>}</>;
}

function Advanced({ snapshot, onSave, onImport, onExport, logs }: { snapshot: AppSnapshot; onSave: (config: Partial<AppConfig>) => void; onImport: () => void; onExport: () => void; logs: string[] }) {
  const [showLogs, setShowLogs] = useState(false);
  const config = snapshot.config;
  return <><section className="hero-row"><div><p className="eyebrow">DIAGNOSTICS</p><h1>高级设置</h1><p className="subtle">调整运行参数。修改会保存到 %APPDATA%\LooPilot。</p></div><div className="actions"><button onClick={onImport}><Upload size={15} />导入配置</button><button onClick={onExport}><Download size={15} />导出配置</button><button onClick={() => setShowLogs(!showLogs)}><TerminalSquare size={15} />{showLogs ? "隐藏日志" : "查看日志"}</button></div></section><section className="panel form-panel"><PanelTitle icon={<Settings2 size={17} />} title="服务与 Codex" /><div className="form-grid"><Field label="服务端口"><input type="number" value={config.port} onChange={(event) => onSave({ port: Number(event.target.value) })} /></Field><Field label="Bridge 模式"><select value={config.bridgeMode} onChange={(event) => onSave({ bridgeMode: event.target.value as AppConfig["bridgeMode"], safeMode: event.target.value === "queue" })}><option value="app-server">App Server（正常）</option><option value="queue">Queue（Safe）</option></select></Field><Field label="Codex Home"><div className="input-action"><input value={config.codexHome} onChange={(event) => onSave({ codexHome: event.target.value })} /><button onClick={async () => { const value = await window.loopilot.chooseDirectory(); if (value) onSave({ codexHome: value }); }}><FolderOpen size={15} /></button></div></Field><Field label="Codex CLI 路径"><div className="input-action"><input value={config.codexCliPath} onChange={(event) => onSave({ codexCliPath: event.target.value })} /><button onClick={async () => { const value = await window.loopilot.chooseFile(); if (value) onSave({ codexCliPath: value }); }}><FolderOpen size={15} /></button></div></Field><Field label="LooPilot 状态目录" wide><div className="input-action"><input value={config.stateDir} onChange={(event) => onSave({ stateDir: event.target.value })} /><button onClick={async () => { const value = await window.loopilot.chooseDirectory(); if (value) onSave({ stateDir: value }); }}><FolderOpen size={15} /></button></div></Field><Field label="日志级别"><select value={config.logLevel} onChange={(event) => onSave({ logLevel: event.target.value as AppConfig["logLevel"] })}><option>error</option><option>warn</option><option>info</option><option>debug</option></select></Field><Field label="界面语言"><select value={config.language} onChange={(event) => onSave({ language: event.target.value as AppConfig["language"] })}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></Field></div><div className="form-footer"><label className="switch-row"><input type="checkbox" checked={config.autoStart} onChange={(event) => onSave({ autoStart: event.target.checked })} /><span className="switch" /><span>系统启动时自动启动服务</span></label><label className="switch-row"><input type="checkbox" checked={config.autoReconnect} onChange={(event) => onSave({ autoReconnect: event.target.checked })} /><span className="switch" /><span>服务自动重连</span></label></div></section>{showLogs && <section className="panel log-panel"><PanelTitle icon={<TerminalSquare size={17} />} title="运行日志" /><pre>{logs.length ? logs.join("\n") : "暂无日志"}</pre></section>}</>;
}

type ReferenceOverviewProps = {
  snapshot: AppSnapshot;
  qrDataUrl: string;
  maskedUrl: string;
  showToken: boolean;
  showPairing: boolean;
  setShowToken: (value: boolean) => void;
  setShowPairing: (value: boolean) => void;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onCheck: () => void;
  onCopy: (value: string) => void;
  onOpen: (value: string) => void;
  onSaveQr: (value: string) => void;
};

function ReferenceOverview(props: ReferenceOverviewProps) {
  const { snapshot } = props;
  const pairingServer = snapshot.publicUrl || snapshot.localUrl;
  return <div className="reference-page">
    <fieldset className="native-group status-group">
      <legend>运行状态</legend>
      <div className="status-lines">
        <StatusLine label="服务" value={statusLabel(snapshot.status)} tone={snapshot.status === "running" ? "ok" : snapshot.status === "error" ? "bad" : ""} />
        <StatusLine label="健康检查" value={severityLabel(snapshot.healthStatus)} tone={snapshot.healthStatus === "ok" ? "ok" : snapshot.healthStatus === "blocked" ? "bad" : "warn"} />
        <StatusLine label="Codex Bridge" value={bridgeLabel(snapshot.bridgeStatus)} tone={snapshot.bridgeStatus === "ready" || snapshot.bridgeStatus === "queue" ? "ok" : "warn"} />
        <StatusLine label="版本" value={`${snapshot.version} · ${snapshot.buildLabel}`} />
      </div>
      <div className="native-actions status-actions">
        <button className="native-primary" disabled={props.busy || snapshot.status === "running"} onClick={props.onStart}><Play size={13} />启动</button>
        <button disabled={props.busy || snapshot.status === "stopped"} onClick={props.onStop}><Square size={12} />停止</button>
        <button disabled={props.busy} onClick={props.onRestart}><RefreshCw size={12} />重启</button>
        <button disabled={props.busy} onClick={props.onCheck}><RefreshCw size={12} />更新</button>
      </div>
    </fieldset>

    <fieldset className="native-group">
      <legend>连接地址</legend>
      <NativeRow label="本地服务"><CodeValue value={snapshot.localUrl} onCopy={props.onCopy} onOpen={props.onOpen} /></NativeRow>
      <NativeRow label="公网服务"><CodeValue value={snapshot.publicUrl || "未启用"} onCopy={props.onCopy} onOpen={props.onOpen} /></NativeRow>
      <NativeRow label="公网检测"><span className={`native-status ${snapshot.tunnelStatus === "connected" ? "ok" : "warn"}`}>{snapshot.tunnelStatus === "connected" ? "已连接" : snapshot.mode === "local" ? "未启用公网隧道" : "等待隧道地址..."}</span></NativeRow>
    </fieldset>

    <fieldset className="native-group">
      <legend>访问凭据</legend>
      <NativeRow label="配对码"><span className="native-pairing">{props.showPairing ? snapshot.pairingCode || "------" : "••••••"}</span><IconButton title="显示/隐藏配对码" onClick={() => props.setShowPairing(!props.showPairing)}>{props.showPairing ? "隐藏" : "显示"}</IconButton><IconButton title="复制配对码" onClick={() => props.onCopy(snapshot.pairingCode)}>复制</IconButton></NativeRow>
      <NativeRow label="本地授权地址"><CodeValue value={props.showToken ? snapshot.authorizedUrl : props.maskedUrl} copyValue={snapshot.authorizedUrl} onCopy={props.onCopy} onOpen={props.onOpen} onToggle={() => props.setShowToken(!props.showToken)} masked={!props.showToken} /></NativeRow>
    </fieldset>

    <fieldset className="native-group pairing-group">
      <legend>手机配对二维码</legend>
      <div className="pairing-layout">
        <div className="qr-wrap">{props.qrDataUrl ? <img src={props.qrDataUrl} alt="LooPilot 配对二维码" /> : <div className="qr-empty">服务启动后生成</div>}</div>
        <div className="pairing-copy"><p>二维码只包含地址和 6 位配对码，不包含长期 Token。</p><div className="native-actions"><button disabled={!props.qrDataUrl} onClick={() => props.onSaveQr(props.qrDataUrl)}><Save size={12} />保存二维码</button><button disabled={!props.qrDataUrl} onClick={() => props.onCopy(JSON.stringify({ type: "loopilot-pairing", version: 1, server: pairingServer, code: snapshot.pairingCode }))}><Copy size={12} />复制内容</button></div></div>
      </div>
    </fieldset>

    <fieldset className="native-group checks-group">
      <legend>环境检查</legend>
      <div className="native-check-list">{snapshot.envChecks.map((check) => <CheckRow key={check.id} check={check} />)}</div>
      <p className="native-note"><Info size={12} />Codex 缺失不会阻止 Safe 模式；Safe 模式只排队手机消息。</p>
    </fieldset>
  </div>;
}

function ReferencePublicAccess({ snapshot, token, onMode, onSave, onTest, onRegenerate }: { snapshot: AppSnapshot; token: string; onMode: (mode: LaunchMode) => void; onSave: (config: Partial<AppConfig>) => void; onTest: () => void; onRegenerate: () => void }) {
  const tunnel = snapshot.config.tunnel;
  const [tokenValue, setTokenValue] = useState(token);
  const [showTunnelToken, setShowTunnelToken] = useState(false);
  const [argsValue, setArgsValue] = useState(tunnel.args.join("\n"));
  const [envValue, setEnvValue] = useState(Object.entries(tunnel.env).map(([key, value]) => `${key}=${value}`).join("\n"));
  const [urlPattern, setUrlPattern] = useState(tunnel.urlPattern);
  const [executable, setExecutable] = useState(tunnel.executablePath);
  const isCustom = snapshot.mode === "custom";
  const save = () => {
    const env: Record<string, string> = {};
    for (const line of envValue.split(/\r?\n/)) { const index = line.indexOf("="); if (index > 0) env[line.slice(0, index).trim()] = line.slice(index + 1); }
    onSave({ tunnel: { ...tunnel, ...(tokenValue ? { token: tokenValue } : {}), executablePath: executable, args: argsValue.split(/\r?\n/).filter(Boolean), env, urlPattern } });
  };
  return <div className="reference-page">
    <fieldset className="native-group mode-group">
      <legend>访问模式</legend>
      {(Object.keys(modeLabels) as LaunchMode[]).map((mode) => <button type="button" key={mode} className={`mode-option ${snapshot.mode === mode ? "selected" : ""}`} onClick={() => onMode(mode)}><span className="native-radio" /><span><strong>{modeLabels[mode]}</strong><small>{mode === "local" ? "仅允许这台电脑访问，不启用公网 Tunnel。" : mode === "cloudflare-temporary" ? "通过 Cloudflare 自动生成临时公网地址，地址可能变化。" : mode === "cloudflare-fixed" ? "通过 Cloudflare Tunnel 使用固定 HTTPS 域名。" : "使用无 Shell 方式启动自定义内网穿透程序。"}</small></span></button>)}
    </fieldset>
    {snapshot.mode !== "local" && <fieldset className="native-group">
      <legend>{snapshot.mode === "cloudflare-fixed" ? "固定域名配置" : "公网连接配置"}</legend>
      <NativeField label="HTTPS 公网地址"><input value={tunnel.url} onChange={(event) => onSave({ tunnel: { ...tunnel, url: event.target.value } })} placeholder="https://example.com" /></NativeField>
      <NativeField label="Tunnel Token"><div className="input-action"><input type={showTunnelToken ? "text" : "password"} value={tokenValue} onChange={(event) => setTokenValue(event.target.value)} placeholder="固定域名模式使用；留空保持已保存值" /><button type="button" onClick={() => setShowTunnelToken(!showTunnelToken)}>{showTunnelToken ? "隐藏" : "显示"}</button></div></NativeField>
      <NativeField label="健康检查 URL"><input value={tunnel.healthUrl} onChange={(event) => onSave({ tunnel: { ...tunnel, healthUrl: event.target.value } })} placeholder="可选，例如 https://example.com/api/health" /></NativeField>
      <NativeField label="启动超时（毫秒）"><input type="number" min="10000" max="600000" value={tunnel.timeoutMs} onChange={(event) => onSave({ tunnel: { ...tunnel, timeoutMs: Number(event.target.value) } })} /></NativeField>
    </fieldset>}
    {isCustom && <fieldset className="native-group">
      <legend>自定义隧道</legend>
      <NativeField label="隧道程序路径"><div className="input-action"><input value={executable} onChange={(event) => setExecutable(event.target.value)} placeholder="选择 .exe 文件" /><button type="button" onClick={async () => { const value = await window.loopilot.chooseFile(); if (value) setExecutable(value); }}><FolderOpen size={13} /></button></div></NativeField>
      <NativeField label="启动参数"><textarea value={argsValue} onChange={(event) => setArgsValue(event.target.value)} placeholder={'每行一个参数，例如\nhttp\n${PORT}'} /><small>支持 ${"${PORT}"}、${"${LOCAL_URL}"}、${"${LOCAL_HOST}"}，不会经过 Shell。</small></NativeField>
      <NativeField label="工作目录"><input value={tunnel.cwd} onChange={(event) => onSave({ tunnel: { ...tunnel, cwd: event.target.value } })} /></NativeField>
      <NativeField label="环境变量"><textarea value={envValue} onChange={(event) => setEnvValue(event.target.value)} placeholder="KEY=value，每行一个" /></NativeField>
      <NativeField label="公网地址提取规则"><input value={urlPattern} onChange={(event) => setUrlPattern(event.target.value)} /></NativeField>
      <NativeField label="停止方式"><select value={tunnel.stopMethod} onChange={(event) => onSave({ tunnel: { ...tunnel, stopMethod: event.target.value as AppConfig["tunnel"]["stopMethod"] } })}><option value="tree">结束进程树</option><option value="terminate">仅结束进程</option></select></NativeField>
    </fieldset>}
    <div className="native-actions page-actions"><button className="native-primary" onClick={onTest}><Wifi size={12} />连接测试</button>{snapshot.mode === "cloudflare-temporary" && <button onClick={onRegenerate}><RefreshCw size={12} />重新生成临时地址</button>}<button onClick={save}><Save size={12} />应用访问模式</button></div>
  </div>;
}

function ReferenceAdvanced({ snapshot, onSave, onImport, onExport, logs }: { snapshot: AppSnapshot; onSave: (config: Partial<AppConfig>) => void; onImport: () => void; onExport: () => void; logs: string[] }) {
  const [showLogs, setShowLogs] = useState(false);
  const config = snapshot.config;
  return <div className="reference-page advanced-page">
    <fieldset className="native-group">
      <legend>基础设置</legend>
      <NativeField label="端口"><input type="number" value={config.port} onChange={(event) => onSave({ port: Number(event.target.value) })} /></NativeField>
      <NativeField label="日志级别"><select value={config.logLevel} onChange={(event) => onSave({ logLevel: event.target.value as AppConfig["logLevel"] })}><option>error</option><option>warn</option><option>info</option><option>debug</option></select></NativeField>
      <NativeField label="界面语言"><select value={config.language} onChange={(event) => onSave({ language: event.target.value as AppConfig["language"] })}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></NativeField>
      <NativeField label="Bridge 模式"><select value={config.bridgeMode} onChange={(event) => onSave({ bridgeMode: event.target.value as AppConfig["bridgeMode"], safeMode: event.target.value === "queue" })}><option value="app-server">App Server（正常）</option><option value="queue">Queue（Safe）</option></select></NativeField>
    </fieldset>
    <fieldset className="native-group">
      <legend>路径设置</legend>
      <NativeField label="Codex Home"><div className="input-action"><input value={config.codexHome} onChange={(event) => onSave({ codexHome: event.target.value })} /><button type="button" onClick={async () => { const value = await window.loopilot.chooseDirectory(); if (value) onSave({ codexHome: value }); }}><FolderOpen size={13} /></button></div></NativeField>
      <NativeField label="Codex CLI 路径"><div className="input-action"><input value={config.codexCliPath} onChange={(event) => onSave({ codexCliPath: event.target.value })} /><button type="button" onClick={async () => { const value = await window.loopilot.chooseFile(); if (value) onSave({ codexCliPath: value }); }}><FolderOpen size={13} /></button></div></NativeField>
      <NativeField label="LooPilot 状态目录"><div className="input-action"><input value={config.stateDir} onChange={(event) => onSave({ stateDir: event.target.value })} /><button type="button" onClick={async () => { const value = await window.loopilot.chooseDirectory(); if (value) onSave({ stateDir: value }); }}><FolderOpen size={13} /></button></div></NativeField>
    </fieldset>
    <fieldset className="native-group">
      <legend>启动策略</legend>
      <label className="native-check"><input type="checkbox" checked={config.autoStart} onChange={(event) => onSave({ autoStart: event.target.checked })} /><span>系统启动时自动启动服务</span></label>
      <label className="native-check"><input type="checkbox" checked={config.autoReconnect} onChange={(event) => onSave({ autoReconnect: event.target.checked })} /><span>服务异常时自动重连</span></label>
    </fieldset>
    <div className="native-actions page-actions"><button onClick={onImport}><Upload size={12} />导入配置</button><button onClick={onExport}><Download size={12} />导出配置</button><button onClick={() => setShowLogs(!showLogs)}><TerminalSquare size={12} />{showLogs ? "隐藏日志" : "查看日志"}</button></div>
    {showLogs && <fieldset className="native-group log-group"><legend>运行日志</legend><pre>{logs.length ? logs.join("\n") : "暂无日志"}</pre></fieldset>}
  </div>;
}

function StatusLine({ label, value, tone = "" }: { label: string; value: string; tone?: string }) { return <div className="status-line"><span>{label}</span><strong className={tone}>{value}</strong></div>; }
function NativeRow({ label, children }: { label: string; children: React.ReactNode }) { return <div className="native-row"><span>{label}</span><div>{children}</div></div>; }
function NativeField({ label, children }: { label: string; children: React.ReactNode }) { return <label className="native-field"><span>{label}</span>{children}</label>; }

function PanelTitle({ icon, title, action }: { icon: React.ReactNode; title: string; action?: React.ReactNode }) { return <div className="panel-title"><span>{icon}<strong>{title}</strong></span>{action}</div>; }
function Metric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: string }) { return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>; }
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) { return <div className="info-row"><span>{label}</span><div>{children}</div></div>; }
function CodeValue({ value, copyValue = value, onCopy, onOpen, onToggle, masked = false }: { value: string; copyValue?: string; onCopy: (value: string) => void; onOpen: (value: string) => void; onToggle?: () => void; masked?: boolean }) { return <div className="code-value"><code title={value}>{value || "未启动"}</code>{onToggle && <IconButton title="显示/隐藏 Token" onClick={onToggle}>{masked ? "显示" : "隐藏"}</IconButton>}<IconButton title="复制" onClick={() => onCopy(copyValue)}>复制</IconButton>{copyValue.startsWith("http") && <IconButton title="打开浏览器" onClick={() => onOpen(copyValue)}>打开</IconButton>}</div>; }
function IconButton({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) { return <button className="small-button" title={title} onClick={onClick}>{children}</button>; }
function CheckRow({ check }: { check: EnvironmentCheck }) { return <div className="check-row"><span className={`check-icon ${check.severity}`}>{check.severity === "ok" ? <CheckCircle2 size={16} /> : check.severity === "blocked" ? <XCircle size={16} /> : <Info size={16} />}</span><span><strong>{check.label}</strong><small>{check.detail}</small>{check.path && <small title={check.path}>检测路径：{check.path}</small>}</span><em>{severityLabel(check.severity)}</em></div>; }
function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) { return <label className={`field ${wide ? "wide" : ""}`}><span>{label}</span>{children}</label>; }
function statusLabel(value: AppSnapshot["status"]) { return ({ stopped: "已停止", starting: "启动中", running: "运行中", stopping: "停止中", error: "异常" })[value]; }
function severityLabel(value: EnvironmentCheck["severity"]) { return ({ ok: "正常", warning: "警告", blocked: "阻断" })[value]; }
function bridgeLabel(value: AppSnapshot["bridgeStatus"]) { return ({ disabled: "未启动", queue: "Safe 队列", ready: "已就绪", missing: "待检查" })[value]; }

createRoot(document.getElementById("root")!).render(<App />);
