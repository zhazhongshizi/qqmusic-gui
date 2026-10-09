[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [switch]$AllowDebugForValidation
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $PackageRoot
$sourceExecutable = Join-Path (Resolve-Path -LiteralPath $PackageRoot).Path 'qqmusic-gui.exe'
# Older binaries ignore unknown arguments and would start with real account data.
# Refuse to launch them: this marker belongs to the isolated-mode implementation.
if (-not [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($sourceExecutable)).Contains('QQMusicGUI/IsolatedSmoke/v1')) {
    throw 'This executable does not support the isolated package-check protocol. Rebuild it first; no program was launched.'
}
if (@(Get-CimInstance Win32_Process -Filter "Name='qqmusic-gui.exe'").Count) {
    throw 'Close the running QQMusic GUI before the isolated package check. No process was stopped.'
}
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$reviewRoot = Join-Path $repositoryRoot ('output/validation/release-smoke-' + (New-Guid).Guid)
New-Item -ItemType Directory -Path $reviewRoot | Out-Null
Get-ChildItem -LiteralPath (Resolve-Path -LiteralPath $PackageRoot).Path -Force |
    Copy-Item -Destination $reviewRoot -Recurse
$executable = Join-Path $reviewRoot 'qqmusic-gui.exe'
$resultPath = Join-Path $reviewRoot '.release-smoke/data/result.json'
$process = Start-Process -FilePath $executable -ArgumentList '--release-smoke' -WorkingDirectory $reviewRoot -WindowStyle Hidden -PassThru
try {
    if (-not $process.WaitForExit(45000)) { throw 'Isolated package check timed out.' }
    if ($process.ExitCode -ne 0) { throw "Isolated package check exited with code $($process.ExitCode)." }
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if ($result.protocol -ne 'QQMusicGUI/IsolatedSmoke/v1' -or -not $result.passed -or -not $result.isolatedData -or $result.accountCredentialsAccessed) {
        throw 'Package startup/core checks failed.'
    }
    if ($result.channel -ne 'Release' -and -not $AllowDebugForValidation) { throw 'A Debug build cannot be published as a Release package.' }
    Write-Host "Isolated $($result.channel) startup/core check passed: $resultPath"
    Write-Host 'Actual audio playback, account login and visual acceptance still require manual review.'
}
finally {
    $running = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
    if ($running -and $running.ExecutablePath -eq $executable) {
        # Only the exact copied process owned by this check may be stopped.
        Stop-Process -Id $process.Id -Force
    }
    $providerExecutable = Join-Path $reviewRoot 'provider/qqmusic-provider.exe'
    foreach ($child in @(Get-CimInstance Win32_Process -Filter "Name='qqmusic-provider.exe'")) {
        if ($child.ExecutablePath -eq $providerExecutable -and $child.ParentProcessId -eq $process.Id) {
            Stop-Process -Id $child.ProcessId -Force
        }
    }
}
