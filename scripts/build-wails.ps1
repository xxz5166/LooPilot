param(
    [switch]$NoBump
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Project = Join-Path $Root "wails-app\LooPilotGo"
$VersionPath = Join-Path $Root "wails-version.json"
$Go = Join-Path $Root ".tools\go\bin\go.exe"
$Wails = Join-Path $Root ".tools\bin\wails.exe"
if (-not (Test-Path $Go)) { $Go = (Get-Command go -ErrorAction Stop).Source }
if (-not (Test-Path $Wails)) { $Wails = (Get-Command wails -ErrorAction Stop).Source }

$Version = Get-Content -Raw -LiteralPath $VersionPath | ConvertFrom-Json
$Label = "v{0}.{1}" -f ([int]$Version.major), ([int]$Version.minor)
$ResourceRoot = Join-Path $Project "resources"
New-Item -ItemType Directory -Force -Path $ResourceRoot | Out-Null
foreach ($Name in @("server", "bin", "build", "public", "runtime", "node_modules")) {
    if ($Name -eq "node_modules" -and (Test-Path (Join-Path $Root ".tmp\core-runtime\node_modules"))) {
        $Source = Join-Path $Root ".tmp\core-runtime\node_modules"
        $Target = Join-Path $ResourceRoot "node_modules"
        if (Test-Path $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
        Copy-Item -LiteralPath $Source -Destination $Target -Recurse -Force
    }
    else {
        Copy-Item -LiteralPath (Join-Path $Root $Name) -Destination $ResourceRoot -Recurse -Force
    }
}
Copy-Item -LiteralPath (Join-Path $Root "package.json") -Destination $ResourceRoot -Force

Push-Location (Join-Path $Project "frontend")
try {
    npm install --no-audit --no-fund
    npm run build
}
finally { Pop-Location }

Push-Location $Project
try {
    $env:Path = "$(Split-Path $Go);$(Split-Path $Wails);$env:Path"
    & $Go fmt ./...
    & $Go test ./...
    $OutputName = "LooPilot-go {0}.exe" -f $Label
    & $Wails build -clean -s -m -platform windows/amd64 -o $OutputName -ldflags ("-H=windowsgui -X main.BuildLabel={0}" -f $Label)
    if ($LASTEXITCODE -ne 0) { throw "Wails build failed" }
    $Output = Join-Path $Project "build\bin\$OutputName"
    if (-not (Test-Path $Output)) { throw "Wails output was not found: $Output" }
    Copy-Item -LiteralPath $Output -Destination (Join-Path $Root $OutputName) -Force
    $Iscc = Get-Command iscc -ErrorAction SilentlyContinue
    if ($Iscc) {
        & $Iscc.Source "/DAppVersion=$($Label.TrimStart('v'))" (Join-Path $Root "installer\LooPilot-go.iss")
    }
    else {
        $InstallerVersion = $Label.TrimStart('v')
        Write-Warning ("Inno Setup was not found. Portable EXE generated. Use iscc /DAppVersion={0} installer\LooPilot-go.iss to build the installer." -f $InstallerVersion)
    }
}
finally { Pop-Location }

if (-not $NoBump) {
    $NextMinor = [int]$Version.minor + 1
    $NextLabel = "v{0}.{1}" -f ([int]$Version.major), $NextMinor
    $Next = [ordered]@{ major = [int]$Version.major; minor = $NextMinor; build = [int]$Version.build + 1; label = $NextLabel }
    $Next | ConvertTo-Json | Set-Content -LiteralPath $VersionPath -Encoding ascii
}
$OutputFileName = "LooPilot-go {0}.exe" -f $Label
Write-Host ("Generated {0}" -f (Join-Path $Root $OutputFileName))
