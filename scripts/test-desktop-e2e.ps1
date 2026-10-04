[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$Target = 'x86_64-pc-windows-msvc'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$binaryPath = Join-Path $repositoryRoot "src-tauri\target\$Target\debug\qqmusic-gui.exe"
$embeddedPort = 4445

function Get-E2EProcesses {
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

if ((Get-E2EProcesses).Count -gt 0) {
    throw 'Refusing to overwrite or control an already-running desktop E2E application.'
}
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'build-desktop-e2e.ps1') -Target $Target
}
if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
    throw 'Desktop E2E application binary is missing. Run scripts/build-desktop-e2e.ps1 first.'
}
if ((Get-NetTCPConnection -State Listen -LocalPort $embeddedPort -ErrorAction SilentlyContinue)) {
    throw "Embedded WebDriver port $embeddedPort is already in use."
}

$testExitCode = 1
$leakedProcess = $false
Push-Location $repositoryRoot
try {
    & pnpm wdio run ./wdio.conf.ts
    $testExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
    Start-Sleep -Milliseconds 500
    $remaining = @(Get-E2EProcesses)
    if ($remaining.Count -gt 0) {
        $leakedProcess = $true
        foreach ($process in $remaining) {
            Stop-Process -Id $process.Id -Force
        }
    }
}

if ($testExitCode -ne 0) {
    throw "Desktop E2E smoke failed with exit code $testExitCode."
}
if ($leakedProcess) {
    throw 'Desktop E2E service left the test application running; the script cleaned it up.'
}
if ((Get-NetTCPConnection -State Listen -LocalPort $embeddedPort -ErrorAction SilentlyContinue)) {
    throw "Embedded WebDriver port $embeddedPort remained open after the test."
}

Write-Host 'Desktop E2E smoke passed and the application process closed.'
