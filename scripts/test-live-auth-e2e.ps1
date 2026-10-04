[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$Target = 'x86_64-pc-windows-msvc'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$binaryPath = Join-Path $repositoryRoot "src-tauri\target\$Target\debug\qqmusic-gui.exe"
$embeddedPort = 4445

function Get-LiveAuthProcesses {
    if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
        return @()
    }
    $resolvedBinary = (Resolve-Path -LiteralPath $binaryPath).Path
    return @(
        Get-Process -ErrorAction SilentlyContinue |
            Where-Object {
                try {
                    $_.Path -and $_.Path.Equals($resolvedBinary, [System.StringComparison]::OrdinalIgnoreCase)
                }
                catch {
                    $false
                }
            }
    )
}

if ((Get-LiveAuthProcesses).Count -gt 0) {
    throw 'Refusing to control an already-running live-auth application.'
}
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'build-desktop-e2e.ps1') -Target $Target
}
if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
    throw 'Live-auth desktop application binary is missing.'
}
if ((Get-NetTCPConnection -State Listen -LocalPort $embeddedPort -ErrorAction SilentlyContinue)) {
    throw "Embedded WebDriver port $embeddedPort is already in use."
}

$testExitCode = 1
Push-Location $repositoryRoot
try {
    & pnpm wdio run ./wdio.conf.ts --spec ./e2e/manual/auth-live.e2e.ts
    $testExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
    Start-Sleep -Milliseconds 500
    foreach ($process in @(Get-LiveAuthProcesses)) {
        Stop-Process -Id $process.Id -Force
    }
}

if ($testExitCode -ne 0) {
    throw "Live-auth desktop acceptance failed with exit code $testExitCode."
}
if ((Get-NetTCPConnection -State Listen -LocalPort $embeddedPort -ErrorAction SilentlyContinue)) {
    throw "Embedded WebDriver port $embeddedPort remained open after live-auth acceptance."
}

Write-Host 'Live-auth desktop acceptance passed and the application process closed.'
