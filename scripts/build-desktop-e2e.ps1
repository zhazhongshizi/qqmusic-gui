[CmdletBinding()]
param(
    [string]$Target = 'x86_64-pc-windows-msvc'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
if ($Target -ne 'x86_64-pc-windows-msvc') {
    throw "Only the approved Windows x64 target is supported; received '$Target'."
}

Push-Location $repositoryRoot
try {
    & pnpm typecheck:e2e
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop E2E typecheck failed with exit code $LASTEXITCODE."
    }
    & pnpm tauri build --debug --target $Target --no-bundle --features desktop-e2e `
        --config src-tauri/tauri.e2e.conf.json
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop E2E application build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$binaryPath = Join-Path $repositoryRoot "src-tauri\target\$Target\debug\qqmusic-gui.exe"
if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
    throw 'Desktop E2E application binary is missing.'
}

Write-Host "Desktop E2E application: $binaryPath"
