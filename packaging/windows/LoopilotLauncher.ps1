param(
  [ValidateSet("normal", "safe", "public", "custom")]
  [string]$Mode = "normal"
)

$ErrorActionPreference = "Stop"
$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$executable = Join-Path $appRoot "LooPilot.exe"
$configPath = Join-Path $env:APPDATA "LooPilot\config.json"

if (-not (Test-Path -LiteralPath $executable)) {
  throw "LooPilot.exe was not found in $appRoot"
}

$config = [pscustomobject]@{}
if (Test-Path -LiteralPath $configPath) {
  try {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  } catch {
    Write-Warning "Unable to read $configPath. Built-in defaults will be used."
  }
}

$env:LOOPILOT_HOST = if ($config.host) { [string]$config.host } else { "127.0.0.1" }
if ($config.port) { $env:PORT = [string]$config.port }
$arguments = @()
$env:LOOPILOT_BRIDGE_MODE = "app-server"

switch ($Mode) {
  "safe" {
    $env:LOOPILOT_BRIDGE_MODE = "queue"
    $arguments += "--safe"
  }
  "public" {
    $env:LOOPILOT_TUNNEL_MODE = "cloudflare"
    $arguments += "--public"
  }
  "custom" {
    $env:LOOPILOT_TUNNEL_MODE = "custom"
    if ($config.tunnelCommand) { $env:LOOPILOT_TUNNEL_COMMAND = [string]$config.tunnelCommand }
    if ($null -ne $config.tunnelArgs) { $env:LOOPILOT_TUNNEL_ARGS = ($config.tunnelArgs | ConvertTo-Json -Compress) }
    if ($config.tunnelUrl) { $env:LOOPILOT_TUNNEL_URL = [string]$config.tunnelUrl }
    if ($config.tunnelCwd) { $env:LOOPILOT_TUNNEL_CWD = [string]$config.tunnelCwd }
    $arguments += "--tunnel"
    $arguments += "custom"
  }
  default {
    $env:LOOPILOT_TUNNEL_MODE = "none"
  }
}

Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $appRoot -Wait
