package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows"
)

var BuildLabel = "v0.1"

type App struct {
	ctx        context.Context
	mu         sync.Mutex
	process    *exec.Cmd
	config     Config
	logs       []string
	publicURL  string
	trayMu     sync.Mutex
	tray       *trayController
	allowClose bool
}

type Config struct {
	Port          int          `json:"port"`
	Mode          string       `json:"mode"`
	SafeMode      bool         `json:"safeMode"`
	DevMode       bool         `json:"devMode"`
	CodexHome     string       `json:"codexHome"`
	CodexCLIPath  string       `json:"codexCliPath"`
	StateDir      string       `json:"stateDir"`
	BridgeMode    string       `json:"bridgeMode"`
	LogLevel      string       `json:"logLevel"`
	AutoStart     bool         `json:"autoStart"`
	AutoReconnect bool         `json:"autoReconnect"`
	TrayEnabled   bool         `json:"trayEnabled"`
	Language      string       `json:"language"`
	Tunnel        TunnelConfig `json:"tunnel"`
}

type TunnelConfig struct {
	Mode           string            `json:"mode"`
	Token          string            `json:"-"`
	ExecutablePath string            `json:"executablePath"`
	Args           []string          `json:"args"`
	CWD            string            `json:"cwd"`
	Env            map[string]string `json:"env"`
	URL            string            `json:"url"`
	URLPattern     string            `json:"urlPattern"`
	HealthURL      string            `json:"healthUrl"`
	TimeoutMS      int               `json:"timeoutMs"`
	AutoReconnect  bool              `json:"autoReconnect"`
	StopMethod     string            `json:"stopMethod"`
}

type StartOptions struct {
	Mode     string `json:"mode"`
	SafeMode bool   `json:"safeMode"`
}

func NewApp() *App { return &App{config: defaultConfig()} }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	if err := a.prepareRuntime(); err != nil {
		_ = os.WriteFile(filepath.Join(os.TempDir(), "LooPilot-go-runtime-error.log"), []byte(err.Error()+"\n"), 0600)
	}
	a.loadConfig()
	a.startTray()
	if a.config.AutoStart {
		go func() { _, _ = a.startService(StartOptions{Mode: a.config.Mode, SafeMode: a.config.SafeMode}) }()
	}
}

func defaultConfig() Config {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		appData, _ = os.UserConfigDir()
	}
	return Config{
		Port: 4317, Mode: "local", CodexHome: filepath.Join(os.Getenv("USERPROFILE"), ".codex"),
		StateDir: filepath.Join(appData, "LooPilot"), BridgeMode: "app-server", LogLevel: "info", Language: "zh-CN", AutoReconnect: true, TrayEnabled: true,
		Tunnel: TunnelConfig{Mode: "local", URLPattern: `https?://[^\s"'<>]+`, TimeoutMS: 120000, AutoReconnect: true, StopMethod: "tree"},
	}
}

func (a *App) runtimeDir() string {
	localData := os.Getenv("LOCALAPPDATA")
	if localData == "" {
		localData = os.TempDir()
	}
	return filepath.Join(localData, "LooPilot", "runtime")
}
func (a *App) configPath() string { return filepath.Join(a.config.StateDir, "config.json") }
func (a *App) secretPath() string { return filepath.Join(a.config.StateDir, "secret.bin") }

func (a *App) normalizeConfig() {
	if a.config.Port < 1024 || a.config.Port > 65535 {
		a.config.Port = 4317
	}
	validMode := map[string]bool{"local": true, "cloudflare-temporary": true, "cloudflare-fixed": true, "custom": true}
	if !validMode[a.config.Mode] {
		a.config.Mode = "local"
	}
	if a.config.StateDir == "" {
		a.config.StateDir = defaultConfig().StateDir
	}
	if a.config.CodexHome == "" {
		a.config.CodexHome = defaultConfig().CodexHome
	}
	if a.config.BridgeMode != "queue" {
		a.config.BridgeMode = "app-server"
	}
	if a.config.Tunnel.Mode == "" {
		a.config.Tunnel.Mode = a.config.Mode
	}
	if a.config.Tunnel.Args == nil {
		a.config.Tunnel.Args = []string{}
	}
	if a.config.Tunnel.Env == nil {
		a.config.Tunnel.Env = map[string]string{}
	}
	if a.config.Tunnel.TimeoutMS < 10000 {
		a.config.Tunnel.TimeoutMS = 120000
	}
	if a.config.Tunnel.URLPattern == "" {
		a.config.Tunnel.URLPattern = `https?://[^\s"'<>]+`
	}
}
func (a *App) loadConfig() {
	if data, err := os.ReadFile(a.configPath()); err == nil {
		_ = json.Unmarshal(data, &a.config)
	}
	if data, err := os.ReadFile(a.secretPath()); err == nil {
		if value, err := unprotect(data); err == nil {
			a.config.Tunnel.Token = string(value)
		}
	}
	a.normalizeConfig()
	_ = a.saveConfig()
}
func (a *App) saveConfig() error {
	a.normalizeConfig()
	if err := os.MkdirAll(a.config.StateDir, 0700); err != nil {
		return err
	}
	safe := a.config
	safe.Tunnel.Token = ""
	data, err := json.MarshalIndent(safe, "", "  ")
	if err != nil {
		return err
	}
	if err = os.WriteFile(a.configPath(), append(data, '\n'), 0600); err != nil {
		return err
	}
	if a.config.Tunnel.Token == "" {
		return nil
	}
	secret, err := protect([]byte(a.config.Tunnel.Token))
	if err != nil {
		return err
	}
	return os.WriteFile(a.secretPath(), secret, 0600)
}

func (a *App) prepareRuntime() error {
	return fs.WalkDir(assets, "resources", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(path, "resources/")
		if rel == "resources" || rel == "" {
			return nil
		}
		if strings.HasPrefix(rel, "runtime/") {
			rel = strings.TrimPrefix(rel, "runtime/")
		}
		target := filepath.Join(a.runtimeDir(), filepath.FromSlash(rel))
		if entry.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if old, statErr := os.Stat(target); statErr == nil && old.Size() == info.Size() {
			return nil
		}
		data, err := fs.ReadFile(assets, path)
		if err != nil {
			return err
		}
		if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		return os.WriteFile(target, data, 0755)
	})
}

func (a *App) StartService(options StartOptions) (map[string]any, error) {
	return a.startService(options)
}
func (a *App) StartLocalMode() (map[string]any, error) {
	return a.startService(StartOptions{Mode: "local"})
}
func (a *App) StartPublicMode() (map[string]any, error) {
	return a.startService(StartOptions{Mode: "cloudflare-temporary"})
}
func (a *App) StartSafeMode() (map[string]any, error) {
	return a.startService(StartOptions{Mode: "local", SafeMode: true})
}

func (a *App) SetLaunchMode(mode string) (map[string]any, error) {
	valid := map[string]bool{"local": true, "cloudflare-temporary": true, "cloudflare-fixed": true, "custom": true}
	if !valid[mode] {
		return nil, fmt.Errorf("不支持的启动模式: %s", mode)
	}
	a.mu.Lock()
	a.config.Mode = mode
	a.config.Tunnel.Mode = mode
	a.normalizeConfig()
	err := a.saveConfig()
	a.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return a.GetRuntimeStatus(), nil
}

func (a *App) startService(options StartOptions) (map[string]any, error) {
	a.mu.Lock()
	running := a.process != nil
	a.mu.Unlock()
	if running {
		_, _ = a.StopService()
	}
	a.cleanupRecordedService()
	a.mu.Lock()
	a.config.Mode, a.config.Tunnel.Mode, a.config.SafeMode = options.Mode, options.Mode, options.SafeMode
	if options.SafeMode {
		a.config.BridgeMode = "queue"
	}
	a.normalizeConfig()
	if !a.portAvailable(a.config.Port) {
		a.mu.Unlock()
		return nil, fmt.Errorf("端口 %d 已被占用，请修改高级设置中的端口", a.config.Port)
	}
	if err := a.prepareRuntime(); err != nil {
		a.mu.Unlock()
		return nil, err
	}
	node, server := filepath.Join(a.runtimeDir(), "node.exe"), filepath.Join(a.runtimeDir(), "server", "index.mjs")
	if _, err := os.Stat(node); err != nil {
		a.mu.Unlock()
		return nil, fmt.Errorf("内置 node.exe 不存在: %w", err)
	}
	env := os.Environ()
	env = append(env, "LOOPILOT_STATE_DIR="+a.config.StateDir, "LOOPILOT_DESKTOP_MODE=1", "PORT="+strconv.Itoa(a.config.Port), "CODEX_HOME="+a.config.CodexHome)
	if options.SafeMode {
		env = append(env, "LOOPILOT_BRIDGE_MODE=queue")
	} else {
		env = append(env, "LOOPILOT_BRIDGE_MODE="+a.config.BridgeMode)
	}
	args := []string{server, "--prod"}
	if options.Mode == "cloudflare-temporary" {
		args = append(args, "--public")
	}
	if options.Mode == "custom" {
		args = append(args, "--tunnel", "custom")
		env = append(env, "LOOPILOT_TUNNEL_MODE=custom", "LOOPILOT_TUNNEL_COMMAND="+a.config.Tunnel.ExecutablePath, "LOOPILOT_TUNNEL_CWD="+a.config.Tunnel.CWD, "LOOPILOT_TUNNEL_ARGS="+mustJSON(a.expandArgs()), "LOOPILOT_TUNNEL_URL="+a.config.Tunnel.URL)
	}
	cmd := exec.CommandContext(context.Background(), node, args...)
	cmd.Dir, cmd.Env = a.runtimeDir(), env
	cmd.SysProcAttr = &windows.SysProcAttr{HideWindow: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		a.mu.Unlock()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		a.mu.Unlock()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		a.mu.Unlock()
		return nil, err
	}
	a.writeServicePID(cmd.Process.Pid)
	a.process, a.publicURL, a.logs = cmd, "", nil
	a.mu.Unlock()
	go a.readOutput(stdout, "node")
	go a.readOutput(stderr, "node")
	go a.watchProcess(cmd)
	if err = a.waitHealth(12 * time.Second); err != nil {
		_, _ = a.StopService()
		return nil, err
	}
	a.emit("service-status", "running")
	return a.GetRuntimeStatus(), nil
}
func (a *App) expandArgs() []string {
	localURL := fmt.Sprintf("http://127.0.0.1:%d", a.config.Port)
	result := make([]string, len(a.config.Tunnel.Args))
	for i, value := range a.config.Tunnel.Args {
		result[i] = strings.NewReplacer("${PORT}", strconv.Itoa(a.config.Port), "${LOCAL_HOST}", "127.0.0.1", "${LOCAL_URL}", localURL, "{PORT}", strconv.Itoa(a.config.Port), "{LOCAL_URL}", localURL, "{LOCAL_HOST}", "127.0.0.1").Replace(value)
	}
	return result
}
func mustJSON(value any) string { data, _ := json.Marshal(value); return string(data) }
func (a *App) readOutput(reader io.Reader, label string) {
	scanner := bufio.NewScanner(reader)
	pattern := regexp.MustCompile(`(?i)Public URL:\s*(https?://[^\s]+)`)
	for scanner.Scan() {
		line := scanner.Text()
		a.addLog("[" + label + "] " + line)
		if match := pattern.FindStringSubmatch(line); len(match) == 2 {
			a.mu.Lock()
			a.publicURL = strings.TrimRight(match[1], ".),")
			publicURL := a.publicURL
			a.mu.Unlock()
			a.emit("public-url", publicURL)
			a.emit("state", a.GetRuntimeStatus())
		}
	}
}
func (a *App) watchProcess(cmd *exec.Cmd) {
	if err := cmd.Wait(); err != nil {
		a.addLog("[node] 服务进程已退出: " + err.Error())
		a.emit("service-status", "error")
	} else {
		a.emit("service-status", "stopped")
	}
	a.clearServicePID(cmd.Process.Pid)
	a.mu.Lock()
	a.process = nil
	a.mu.Unlock()
}
func (a *App) StopService() (map[string]any, error) {
	a.mu.Lock()
	cmd := a.process
	port := a.config.Port
	a.process = nil
	a.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = exec.Command("taskkill.exe", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run()
		a.clearServicePID(cmd.Process.Pid)
	}
	waitPortAvailable(port, 5*time.Second)
	a.emit("service-status", "stopped")
	return a.GetRuntimeStatus(), nil
}
func (a *App) RestartService() (map[string]any, error) {
	_, _ = a.StopService()
	return a.startService(StartOptions{Mode: a.config.Mode, SafeMode: a.config.SafeMode})
}
func (a *App) shutdown(_ context.Context) {
	_, _ = a.StopService()
	a.stopTray()
}

func (a *App) waitHealth(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	url := fmt.Sprintf("http://127.0.0.1:%d/api/health", a.config.Port)
	for time.Now().Before(deadline) {
		response, err := http.Get(url)
		if err == nil {
			response.Body.Close()
			if response.StatusCode < 500 {
				return nil
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	return errors.New("LooPilot 服务启动超时，请检查日志和端口设置")
}
func (a *App) portAvailable(port int) bool {
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	_ = listener.Close()
	return true
}

func (a *App) servicePIDPath() string { return filepath.Join(a.config.StateDir, "service.pid") }

func (a *App) writeServicePID(pid int) {
	_ = os.MkdirAll(a.config.StateDir, 0700)
	_ = os.WriteFile(a.servicePIDPath(), []byte(strconv.Itoa(pid)), 0600)
}

func (a *App) clearServicePID(pid int) {
	data, err := os.ReadFile(a.servicePIDPath())
	if err != nil {
		return
	}
	recorded, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err == nil && recorded == pid {
		_ = os.Remove(a.servicePIDPath())
	}
}

func (a *App) cleanupRecordedService() {
	data, err := os.ReadFile(a.servicePIDPath())
	if err != nil {
		return
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		_ = os.Remove(a.servicePIDPath())
		return
	}
	expected, _ := filepath.Abs(filepath.Join(a.runtimeDir(), "node.exe"))
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		_ = os.Remove(a.servicePIDPath())
		return
	}
	defer windows.CloseHandle(handle)
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		return
	}
	actual := filepath.Clean(windows.UTF16ToString(buffer[:size]))
	if !strings.EqualFold(actual, expected) {
		return
	}
	_ = exec.Command("taskkill.exe", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
	_ = os.Remove(a.servicePIDPath())
	waitPortAvailable(a.config.Port, 5*time.Second)
}

func waitPortAvailable(port int, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			_ = listener.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (a *App) GetRuntimeStatus() map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	running := a.process != nil
	local := fmt.Sprintf("http://127.0.0.1:%d", a.config.Port)
	token, code := a.readState("auth-token"), a.readState("pairing-code")
	public := a.publicURL
	server := public
	if server == "" {
		server = local
	}
	status := "stopped"
	if running {
		status = "running"
	}
	bridge := "disabled"
	if running && a.config.SafeMode {
		bridge = "queue"
	} else if running {
		bridge = "ready"
	}
	safeConfig := a.config
	safeConfig.Tunnel.Token = ""
	logs := append([]string{}, a.logs...)
	return map[string]any{"status": status, "serviceStatus": map[bool]string{true: "healthy", false: "offline"}[running], "healthStatus": map[bool]string{true: "ok", false: "warning"}[running], "bridgeStatus": bridge, "tunnelStatus": map[bool]string{true: "connected", false: "disabled"}[public != ""], "mode": a.config.Mode, "version": strings.TrimPrefix(BuildLabel, "v"), "buildLabel": BuildLabel, "port": a.config.Port, "localUrl": local, "authorizedUrl": local + "/?token=" + token, "pairingCode": code, "publicUrl": public, "qrPayload": mustJSON(map[string]any{"type": "loopilot-pairing", "version": 1, "server": server, "code": code}), "envChecks": a.environmentChecks(), "logs": logs, "config": safeConfig}
}
func (a *App) readState(name string) string {
	data, _ := os.ReadFile(filepath.Join(a.config.StateDir, name))
	return strings.TrimSpace(string(data))
}
func (a *App) addLog(line string) {
	clean := a.redact(strings.TrimSpace(line))
	if clean == "" {
		return
	}
	a.mu.Lock()
	a.logs = append(a.logs, clean)
	if len(a.logs) > 300 {
		a.logs = a.logs[len(a.logs)-300:]
	}
	a.mu.Unlock()
	a.emit("log-line", clean)
}
func (a *App) redact(value string) string {
	token := a.readState("auth-token")
	if token != "" {
		value = strings.ReplaceAll(value, token, "[hidden]")
	}
	value = regexp.MustCompile(`(?i)(token=|Bearer\s+|TUNNEL_TOKEN[=:])[^\s&]+`).ReplaceAllString(value, "[hidden]")
	return regexp.MustCompile(`(?i)(Authorized URL:|Pairing code:)\s*[^\s]+`).ReplaceAllString(value, "$1 [hidden]")
}
func (a *App) emit(name string, value any) {
	if a.ctx != nil {
		wailsruntime.EventsEmit(a.ctx, name, value)
	}
}

func (a *App) CheckEnvironment() []map[string]any {
	checks := a.environmentChecks()
	a.emit("environment-check", checks)
	return checks
}
func (a *App) GetEnvironmentReport() []map[string]any { return a.CheckEnvironment() }
func (a *App) environmentChecks() []map[string]any {
	checks := []map[string]any{}
	add := func(id, label, severity, detail string) {
		checks = append(checks, map[string]any{"id": id, "label": label, "severity": severity, "detail": detail})
	}
	add("windows", "Windows", map[bool]string{true: "ok", false: "warning"}[goruntime.GOOS == "windows" && goruntime.GOARCH == "amd64"], goruntime.GOOS+"/"+goruntime.GOARCH)
	nodeOK := fileExists(filepath.Join(a.runtimeDir(), "node.exe"))
	add("node", "内置 Node.js", map[bool]string{true: "ok", false: "blocked"}[nodeOK], a.runtimeDir())
	coreOK := fileExists(filepath.Join(a.runtimeDir(), "server", "index.mjs")) && fileExists(filepath.Join(a.runtimeDir(), "build", "index.html"))
	add("core", "LooPilot 文件", map[bool]string{true: "ok", false: "blocked"}[coreOK], "server / build / public / bin")
	add("webview2", "WebView2 Runtime", "warning", "由 Wails 使用系统 WebView2；缺失时请安装 Microsoft Edge WebView2 Runtime")
	add("port", "端口", map[bool]string{true: "ok", false: "warning"}[a.portAvailable(a.config.Port) || a.process != nil], strconv.Itoa(a.config.Port))
	add("codex", "Codex", map[bool]string{true: "ok", false: "warning"}[fileExists(a.config.CodexHome)], a.config.CodexHome)
	add("network", "网络", "warning", "公网 Tunnel 启动时检查 HTTPS 连接")
	return checks
}
func fileExists(path string) bool { _, err := os.Stat(path); return err == nil }

func (a *App) SaveSettings(value map[string]any) (map[string]any, error) {
	a.mu.Lock()
	trayChanged := false
	trayEnabled := a.config.TrayEnabled
	if item, ok := value["port"].(float64); ok {
		a.config.Port = int(item)
	}
	if item, ok := value["mode"].(string); ok {
		a.config.Mode = item
	}
	if item, ok := value["safeMode"].(bool); ok {
		a.config.SafeMode = item
	}
	if item, ok := value["bridgeMode"].(string); ok {
		a.config.BridgeMode = item
	}
	if item, ok := value["codexHome"].(string); ok {
		a.config.CodexHome = item
	}
	if item, ok := value["codexCliPath"].(string); ok {
		a.config.CodexCLIPath = item
	}
	if item, ok := value["stateDir"].(string); ok {
		a.config.StateDir = item
	}
	if item, ok := value["autoStart"].(bool); ok {
		a.config.AutoStart = item
	}
	if item, ok := value["autoReconnect"].(bool); ok {
		a.config.AutoReconnect = item
	}
	if item, ok := value["trayEnabled"].(bool); ok {
		a.config.TrayEnabled = item
		trayChanged = true
		trayEnabled = item
	}
	if tunnel, ok := value["tunnel"].(map[string]any); ok {
		data, _ := json.Marshal(tunnel)
		_ = json.Unmarshal(data, &a.config.Tunnel)
		if item, ok := tunnel["token"].(string); ok {
			a.config.Tunnel.Token = item
		}
	}
	a.normalizeConfig()
	err := a.saveConfig()
	a.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if trayChanged {
		a.setTrayVisible(trayEnabled)
	}
	return a.GetRuntimeStatus(), nil
}
func (a *App) LoadSettings() map[string]any { return a.GetRuntimeStatus() }
func (a *App) ResetSettings() (map[string]any, error) {
	a.mu.Lock()
	a.config = defaultConfig()
	err := a.saveConfig()
	a.mu.Unlock()
	a.setTrayVisible(a.config.TrayEnabled)
	return a.GetRuntimeStatus(), err
}
func (a *App) GetLogs() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.logs...)
}
func (a *App) GetConnectionInfo() map[string]string {
	snapshot := a.GetRuntimeStatus()
	return map[string]string{"localUrl": snapshot["localUrl"].(string), "authorizedUrl": snapshot["authorizedUrl"].(string), "publicUrl": snapshot["publicUrl"].(string), "pairingCode": snapshot["pairingCode"].(string)}
}

func (a *App) CopyText(value string) { wailsruntime.ClipboardSetText(a.ctx, value) }
func (a *App) OpenBrowser(value string) error {
	if !strings.HasPrefix(value, "http://") && !strings.HasPrefix(value, "https://") {
		return errors.New("仅允许打开 HTTP/HTTPS 地址")
	}
	wailsruntime.BrowserOpenURL(a.ctx, value)
	return nil
}
func (a *App) SelectFile() (string, error) {
	return wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{})
}
func (a *App) SelectDirectory() (string, error) {
	return wailsruntime.OpenDirectoryDialog(a.ctx, wailsruntime.OpenDialogOptions{})
}
func (a *App) SaveQr(dataURL string) (string, error) {
	result, err := wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{DefaultFilename: "LooPilot-pairing.png"})
	if err != nil || result == "" {
		return result, err
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(dataURL, "data:image/png;base64,"))
	if err != nil {
		return "", err
	}
	return result, os.WriteFile(result, data, 0600)
}
func (a *App) ExportConfig() (string, error) {
	result, err := wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{DefaultFilename: "LooPilot-config.json"})
	if err != nil || result == "" {
		return result, err
	}
	a.mu.Lock()
	safe := a.config
	safe.Tunnel.Token = ""
	data, _ := json.MarshalIndent(safe, "", "  ")
	a.mu.Unlock()
	return result, os.WriteFile(result, append(data, '\n'), 0600)
}
func (a *App) ImportConfig() (map[string]any, error) {
	result, err := wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{})
	if err != nil || result == "" {
		return nil, err
	}
	data, err := os.ReadFile(result)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if err = json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	return a.SaveSettings(value)
}
func (a *App) TestTunnel() map[string]any {
	if a.config.Mode == "local" {
		return map[string]any{"ok": true, "detail": "当前为仅本机模式"}
	}
	if a.config.Mode == "custom" && a.config.Tunnel.ExecutablePath == "" {
		return map[string]any{"ok": false, "detail": "请先选择自定义隧道程序"}
	}
	return map[string]any{"ok": true, "detail": "配置可用，启动服务时将验证公网地址"}
}
func (a *App) InstallCloudflared() map[string]any {
	return map[string]any{"ok": false, "detail": "请在公网访问页确认后，由 LooPilot Node 服务通过 HTTPS 下载并校验 cloudflared"}
}

func protect(value []byte) ([]byte, error) {
	if len(value) == 0 {
		return nil, errors.New("empty secret")
	}
	input := windows.DataBlob{Size: uint32(len(value)), Data: &value[0]}
	var output windows.DataBlob
	if err := windows.CryptProtectData(&input, nil, nil, 0, nil, 0, &output); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(output.Data))))
	return unsafe.Slice(output.Data, output.Size), nil
}
func unprotect(value []byte) ([]byte, error) {
	if len(value) == 0 {
		return nil, errors.New("empty secret")
	}
	input := windows.DataBlob{Size: uint32(len(value)), Data: &value[0]}
	var output windows.DataBlob
	if err := windows.CryptUnprotectData(&input, nil, nil, 0, nil, 0, &output); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(output.Data))))
	return unsafe.Slice(output.Data, output.Size), nil
}
