//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"sync"
	"time"
	"unsafe"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows"
)

const (
	wmDestroy       = 0x0002
	wmClose         = 0x0010
	wmCommand       = 0x0111
	wmNull          = 0x0000
	wmLButtonUp     = 0x0202
	wmLButtonDblClk = 0x0203
	wmRButtonUp     = 0x0205
	wmTrayCallback  = 0x8000 + 1

	trayOpen = iota + 1001
	trayHide
	trayStart
	trayStop
	trayDisable
	trayQuit

	mfString       = 0x0000
	mfSeparator    = 0x0800
	tpmReturnCmd   = 0x0100
	tpmRightButton = 0x0002
	nimAdd         = 0x00000000
	nimDelete      = 0x00000002
	nifMessage     = 0x00000001
	nifIcon        = 0x00000002
	nifTip         = 0x00000004

	idiApplication = 32512
	idcArrow       = 32512
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	shell32  = windows.NewLazySystemDLL("shell32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")

	procRegisterClassEx = user32.NewProc("RegisterClassExW")
	procUnregisterClass = user32.NewProc("UnregisterClassW")
	procCreateWindowEx  = user32.NewProc("CreateWindowExW")
	procDestroyWindow   = user32.NewProc("DestroyWindow")
	procDefWindowProc   = user32.NewProc("DefWindowProcW")
	procGetMessage      = user32.NewProc("GetMessageW")
	procTranslate       = user32.NewProc("TranslateMessage")
	procDispatch        = user32.NewProc("DispatchMessageW")
	procPostQuit        = user32.NewProc("PostQuitMessage")
	procPostMessage     = user32.NewProc("PostMessageW")
	procGetModuleHandle = kernel32.NewProc("GetModuleHandleW")
	procLoadIcon        = user32.NewProc("LoadIconW")
	procLoadCursor      = user32.NewProc("LoadCursorW")
	procCreatePopup     = user32.NewProc("CreatePopupMenu")
	procAppendMenu      = user32.NewProc("AppendMenuW")
	procDestroyMenu     = user32.NewProc("DestroyMenu")
	procGetCursorPos    = user32.NewProc("GetCursorPos")
	procSetForeground   = user32.NewProc("SetForegroundWindow")
	procTrackPopup      = user32.NewProc("TrackPopupMenu")
	procNotifyIcon      = shell32.NewProc("Shell_NotifyIconW")
)

type trayPoint struct {
	X int32
	Y int32
}

type trayMessage struct {
	HWnd    windows.Handle
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Point   trayPoint
	Private uint32
}

type trayWndClass struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	SmallIcon  windows.Handle
}

type trayNotifyIconData struct {
	Size             uint32
	HWnd             windows.Handle
	ID               uint32
	Flags            uint32
	CallbackMessage  uint32
	Icon             windows.Handle
	Tip              [128]uint16
	State            uint32
	StateMask        uint32
	Info             [256]uint16
	TimeoutOrVersion uint32
	InfoTitle        [64]uint16
	InfoFlags        uint32
	Guid             [16]byte
	BalloonIcon      windows.Handle
}

type trayController struct {
	app       *App
	mu        sync.Mutex
	hwnd      windows.Handle
	visible   bool
	ready     chan struct{}
	done      chan struct{}
	className *uint16
}

var trayWindows sync.Map
var trayWndProc = windows.NewCallback(trayWndProcHandler)

func (a *App) startTray() {
	a.trayMu.Lock()
	if a.tray != nil {
		a.trayMu.Unlock()
		return
	}
	a.tray = &trayController{app: a, visible: a.config.TrayEnabled, ready: make(chan struct{}), done: make(chan struct{})}
	tray := a.tray
	a.trayMu.Unlock()
	go tray.run()
}

func (a *App) setTrayVisible(visible bool) {
	a.trayMu.Lock()
	tray := a.tray
	a.trayMu.Unlock()
	if tray != nil {
		tray.setVisible(visible)
	}
}

func (a *App) stopTray() {
	a.trayMu.Lock()
	tray := a.tray
	a.tray = nil
	a.trayMu.Unlock()
	if tray != nil {
		tray.stop()
	}
}

func (a *App) beforeClose(ctx context.Context) bool {
	a.mu.Lock()
	allowClose := a.allowClose
	if allowClose {
		a.allowClose = false
	}
	trayEnabled := a.config.TrayEnabled
	a.mu.Unlock()
	if allowClose || !trayEnabled {
		return false
	}
	wailsruntime.WindowHide(ctx)
	return true
}

func (t *trayController) run() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(t.done)
	defer close(t.ready)

	className, _ := windows.UTF16PtrFromString(fmt.Sprintf("LooPilotTray-%d", os.Getpid()))
	t.className = className
	instance, _, _ := procGetModuleHandle.Call(0)
	icon, _, _ := procLoadIcon.Call(0, idiApplication)
	cursor, _, _ := procLoadCursor.Call(0, idcArrow)
	class := trayWndClass{
		Size:      uint32(unsafe.Sizeof(trayWndClass{})),
		WndProc:   trayWndProc,
		Instance:  windows.Handle(instance),
		Icon:      windows.Handle(icon),
		Cursor:    windows.Handle(cursor),
		ClassName: className,
		SmallIcon: windows.Handle(icon),
	}
	if atom, _, _ := procRegisterClassEx.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		return
	}
	defer procUnregisterClass.Call(uintptr(unsafe.Pointer(className)), instance)

	hwnd, _, _ := procCreateWindowEx.Call(0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(className)), 0, 0, 0, 0, 0, 0, 0, instance, 0)
	if hwnd == 0 {
		return
	}
	t.mu.Lock()
	t.hwnd = windows.Handle(hwnd)
	visible := t.visible
	t.mu.Unlock()
	trayWindows.Store(windows.Handle(hwnd), t)
	if visible {
		t.addIcon()
	}

	var message trayMessage
	for {
		result, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			break
		}
		procTranslate.Call(uintptr(unsafe.Pointer(&message)))
		procDispatch.Call(uintptr(unsafe.Pointer(&message)))
	}
	t.removeIcon()
	trayWindows.Delete(windows.Handle(hwnd))
	procDestroyWindow.Call(hwnd)
}

func (t *trayController) stop() {
	t.mu.Lock()
	hwnd := t.hwnd
	t.mu.Unlock()
	if hwnd == 0 {
		select {
		case <-t.ready:
		case <-time.After(2 * time.Second):
			return
		}
		t.mu.Lock()
		hwnd = t.hwnd
		t.mu.Unlock()
	}
	if hwnd != 0 {
		procPostMessage.Call(uintptr(hwnd), wmClose, 0, 0)
	}
	select {
	case <-t.done:
	case <-time.After(2 * time.Second):
	}
}

func (t *trayController) setVisible(visible bool) {
	t.mu.Lock()
	t.visible = visible
	hwnd := t.hwnd
	t.mu.Unlock()
	if hwnd == 0 {
		return
	}
	if visible {
		t.addIcon()
	} else {
		t.removeIcon()
	}
}

func (t *trayController) addIcon() {
	t.mu.Lock()
	hwnd := t.hwnd
	t.mu.Unlock()
	if hwnd == 0 {
		return
	}
	data := trayNotifyIconData{
		Size:            uint32(unsafe.Sizeof(trayNotifyIconData{})),
		HWnd:            hwnd,
		ID:              1,
		Flags:           nifMessage | nifIcon | nifTip,
		CallbackMessage: wmTrayCallback,
	}
	trayIcon, _, _ := procLoadIcon.Call(0, idiApplication)
	data.Icon = windows.Handle(trayIcon)
	tip, _ := windows.UTF16FromString("LooPilot-go")
	copy(data.Tip[:], tip)
	procNotifyIcon.Call(nimAdd, uintptr(unsafe.Pointer(&data)))
}

func (t *trayController) removeIcon() {
	t.mu.Lock()
	hwnd := t.hwnd
	t.mu.Unlock()
	if hwnd == 0 {
		return
	}
	data := trayNotifyIconData{Size: uint32(unsafe.Sizeof(trayNotifyIconData{})), HWnd: hwnd, ID: 1}
	procNotifyIcon.Call(nimDelete, uintptr(unsafe.Pointer(&data)))
}

func (t *trayController) showMenu() {
	t.mu.Lock()
	hwnd := t.hwnd
	t.mu.Unlock()
	if hwnd == 0 {
		return
	}
	menu, _, _ := procCreatePopup.Call()
	if menu == 0 {
		return
	}
	defer procDestroyMenu.Call(menu)
	appendTrayMenuItem(menu, trayOpen, "打开控制面板")
	appendTrayMenuItem(menu, trayHide, "隐藏窗口")
	appendTraySeparator(menu)
	appendTrayMenuItem(menu, trayStart, "启动服务")
	appendTrayMenuItem(menu, trayStop, "停止服务")
	appendTraySeparator(menu)
	appendTrayMenuItem(menu, trayDisable, "关闭托盘图标")
	appendTrayMenuItem(menu, trayQuit, "退出程序")
	var point trayPoint
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&point)))
	procSetForeground.Call(uintptr(hwnd))
	command, _, _ := procTrackPopup.Call(menu, tpmReturnCmd|tpmRightButton, uintptr(point.X), uintptr(point.Y), 0, uintptr(hwnd), 0)
	procPostMessage.Call(uintptr(hwnd), wmNull, 0, 0)
	if command != 0 {
		t.handleCommand(uint32(command))
	}
}

func appendTrayMenuItem(menu uintptr, id uint32, label string) {
	text, _ := windows.UTF16PtrFromString(label)
	procAppendMenu.Call(menu, mfString, uintptr(id), uintptr(unsafe.Pointer(text)))
}

func appendTraySeparator(menu uintptr) {
	procAppendMenu.Call(menu, mfSeparator, 0, 0)
}

func (t *trayController) handleCommand(command uint32) {
	switch command {
	case trayOpen:
		go t.app.showWindow()
	case trayHide:
		go t.app.hideWindow()
	case trayStart:
		go t.app.startFromTray()
	case trayStop:
		go func() { _, _ = t.app.StopService() }()
	case trayDisable:
		go func() { _, _ = t.app.SaveSettings(map[string]any{"trayEnabled": false}) }()
	case trayQuit:
		go t.app.quitFromTray()
	}
}

func (a *App) showWindow() {
	if a.ctx != nil {
		wailsruntime.WindowShow(a.ctx)
		wailsruntime.WindowUnminimise(a.ctx)
	}
}

func (a *App) hideWindow() {
	if a.ctx != nil {
		wailsruntime.WindowHide(a.ctx)
	}
}

func (a *App) startFromTray() {
	a.mu.Lock()
	options := StartOptions{Mode: a.config.Mode, SafeMode: a.config.SafeMode}
	a.mu.Unlock()
	if _, err := a.startService(options); err != nil {
		a.addLog("[tray] " + err.Error())
	}
}

func (a *App) quitFromTray() {
	a.mu.Lock()
	a.allowClose = true
	ctx := a.ctx
	a.mu.Unlock()
	if ctx != nil {
		wailsruntime.Quit(ctx)
	}
}

func trayWndProcHandler(hwnd uintptr, message uint32, wParam uintptr, lParam uintptr) uintptr {
	value, ok := trayWindows.Load(windows.Handle(hwnd))
	if !ok {
		result, _, _ := procDefWindowProc.Call(hwnd, uintptr(message), wParam, lParam)
		return result
	}
	tray := value.(*trayController)
	switch message {
	case wmTrayCallback:
		switch uint32(lParam) {
		case wmLButtonUp, wmLButtonDblClk:
			go tray.app.showWindow()
		case wmRButtonUp:
			tray.showMenu()
		}
		return 0
	case wmCommand:
		tray.handleCommand(uint32(wParam & 0xffff))
		return 0
	case wmClose:
		procDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		procPostQuit.Call(0)
		return 0
	}
	result, _, _ := procDefWindowProc.Call(hwnd, uintptr(message), wParam, lParam)
	return result
}
