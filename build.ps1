param(
    [switch]$NoBump
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VersionPath = Join-Path $ProjectDir "VERSION"
$MainPath = Join-Path $ProjectDir "main.py"

if (-not (Test-Path -LiteralPath $VersionPath)) {
    Set-Content -LiteralPath $VersionPath -Value "0.1" -Encoding ascii
}

$CurrentVersion = (Get-Content -LiteralPath $VersionPath -Raw -Encoding ascii).Trim()
if ($CurrentVersion -notmatch '^(\d+)\.(\d+)$') {
    throw "VERSION must use major.minor format, for example 0.1"
}

$Major = [int]$Matches[1]
$Minor = [int]$Matches[2]
if (-not $NoBump) {
    $Minor++
    if ($Minor -ge 100) {
        $Major++
        $Minor = 0
    }
}
$NextVersion = "{0}.{1}" -f $Major, $Minor

# Keep the displayed version in the single-file source synchronized with the build.
$MainText = Get-Content -LiteralPath $MainPath -Raw -Encoding utf8
$UpdatedMainText = [regex]::Replace(
    $MainText,
    '(?m)^(APP_VERSION\s*=\s*)["''][^"'']+["'']',
    ('$1"' + $NextVersion + '"'),
    1
)
if ($UpdatedMainText -eq $MainText) {
    throw "APP_VERSION definition was not found in main.py"
}
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($MainPath, $UpdatedMainText, $Utf8NoBom)
[IO.File]::WriteAllText($VersionPath, $NextVersion, [Text.Encoding]::ASCII)

$ExeName = "LooPilotLauncher-v$NextVersion"
Push-Location $ProjectDir
try {
    & py -3 -m py_compile main.py
    if ($LASTEXITCODE -ne 0) {
        throw "Python syntax check failed"
    }
    & py -3 -m PyInstaller --noconfirm --clean --onefile --windowed `
        --name $ExeName `
        --hidden-import=qrcode `
        --hidden-import=PIL `
        --hidden-import=PIL.ImageTk `
        main.py
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller build failed"
    }
}
finally {
    Pop-Location
}

Write-Host "Build complete: dist\$ExeName.exe"
