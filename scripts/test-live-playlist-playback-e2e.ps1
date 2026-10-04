[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$Target = 'x86_64-pc-windows-msvc'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$binaryPath = Join-Path $repositoryRoot "src-tauri\target\$Target\debug\qqmusic-gui.exe"
$embeddedPort = 4445
$proxyNames = @('ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY')
$savedProxy = @{}

function Get-LiveAcceptanceProcesses {
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

if ((Get-LiveAcceptanceProcesses).Count -gt 0) {
    throw 'Refusing to control an already-running live acceptance application.'
}
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'build-provider.ps1')
    & (Join-Path $PSScriptRoot 'stage-provider-resource.ps1')
    & (Join-Path $PSScriptRoot 'build-desktop-e2e.ps1') -Target $Target
}
if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
    throw 'Live acceptance desktop application binary is missing.'
}
if ((Get-NetTCPConnection -State Listen -LocalPort $embeddedPort -ErrorAction SilentlyContinue)) {
    throw "Embedded WebDriver port $embeddedPort is already in use."
}

foreach ($name in $proxyNames) {
    $savedProxy[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
}

$testExitCode = 1
Push-Location $repositoryRoot
try {
    & pnpm wdio run ./wdio.conf.ts --spec ./e2e/manual/playlist-playback-live.e2e.ts
    $testExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
    foreach ($name in $proxyNames) {
        if ($null -eq $savedProxy[$name]) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
        else {
            Set-Item -LiteralPath "Env:$name" -Value $savedProxy[$name]
        }
    }
    Start-Sleep -Milliseconds 500
    foreach ($process in @(Get-LiveAcceptanceProcesses)) {
        Stop-Process -Id $process.Id -Force
    }
}

if ($testExitCode -ne 0) {
    throw "Live playlist/playback desktop acceptance failed with exit code $testExitCode."
}
if ((Get-NetTCPConnection -State Listen -LocalPort $embeddedPort -ErrorAction SilentlyContinue)) {
    throw "Embedded WebDriver port $embeddedPort remained open after live acceptance."
}

Write-Host 'Live playlist/playback desktop acceptance passed and the application process closed.'
