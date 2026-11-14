package main

import (
	"embed"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"os"
	"path/filepath"
)

//go:embed all:frontend/dist resources
var assets embed.FS

func main() {
	app := NewApp()
	err := wails.Run(&options.App{
		Title: "LooPilot-go " + BuildLabel, Width: 1220, Height: 820, MinWidth: 960, MinHeight: 680,
		AssetServer:      &assetserver.Options{Assets: assets},
		BackgroundColour: &options.RGBA{R: 242, G: 245, B: 247, A: 1}, OnStartup: app.startup, OnShutdown: app.shutdown, OnBeforeClose: app.beforeClose,
		SingleInstanceLock: &options.SingleInstanceLock{UniqueId: "LooPilotGo-single-instance", OnSecondInstanceLaunch: func(options.SecondInstanceData) { app.showWindow() }},
		Bind:               []interface{}{app},
	})
	if err != nil {
		_ = os.WriteFile(filepath.Join(os.TempDir(), "LooPilot-go-error.log"), []byte(err.Error()+"\n"), 0600)
		println("Error:", err.Error())
	}
}
