package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRedactHidesCredentials(t *testing.T) {
	tmp := t.TempDir()
	app := &App{config: Config{StateDir: tmp}}
	if err := os.WriteFile(filepath.Join(tmp, "auth-token"), []byte("secret-token"), 0600); err != nil {
		t.Fatal(err)
	}
	value := app.redact("Authorized URL: http://127.0.0.1:4317/?token=secret-token Bearer secret-token")
	if value == "" || contains(value, "secret-token") {
		t.Fatalf("credentials were not redacted: %q", value)
	}
}

func TestExpandArgsUsesArgumentPlaceholders(t *testing.T) {
	app := &App{config: Config{Port: 4567, Tunnel: TunnelConfig{Args: []string{"http", "${LOCAL_URL}", "--port", "${PORT}"}}}}
	got := app.expandArgs()
	want := []string{"http", "http://127.0.0.1:4567", "--port", "4567"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("arg %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestPrepareRuntimeCopiesEmbeddedFiles(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	app := NewApp()
	if err := app.prepareRuntime(); err != nil {
		t.Fatal(err)
	}
	if !fileExists(filepath.Join(app.runtimeDir(), "node.exe")) {
		t.Fatal("embedded node.exe was not released")
	}
	if !fileExists(filepath.Join(app.runtimeDir(), "server", "index.mjs")) {
		t.Fatal("embedded server was not released")
	}
}

func TestSetLaunchModePersistsBothModes(t *testing.T) {
	app := NewApp()
	app.config.StateDir = t.TempDir()

	if _, err := app.SetLaunchMode("cloudflare-fixed"); err != nil {
		t.Fatal(err)
	}
	if app.config.Mode != "cloudflare-fixed" || app.config.Tunnel.Mode != "cloudflare-fixed" {
		t.Fatalf("modes were not updated: config=%q tunnel=%q", app.config.Mode, app.config.Tunnel.Mode)
	}

	data, err := os.ReadFile(filepath.Join(app.config.StateDir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved Config
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Mode != "cloudflare-fixed" || saved.Tunnel.Mode != "cloudflare-fixed" {
		t.Fatalf("persisted modes were not updated: config=%q tunnel=%q", saved.Mode, saved.Tunnel.Mode)
	}
}

func TestReadOutputCapturesPublicURL(t *testing.T) {
	app := &App{}
	app.readOutput(strings.NewReader("Public URL: https://demo.trycloudflare.com\n"), "node")
	if app.publicURL != "https://demo.trycloudflare.com" {
		t.Fatalf("public URL = %q", app.publicURL)
	}
}

func contains(value, part string) bool {
	for i := 0; i+len(part) <= len(value); i++ {
		if value[i:i+len(part)] == part {
			return true
		}
	}
	return false
}
