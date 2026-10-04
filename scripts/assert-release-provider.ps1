[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$BundleRoot,

    [switch]$AllowFixtureProviderForSpike
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = (Resolve-Path -LiteralPath $BundleRoot -ErrorAction Stop).Path
$providerExe = Join-Path $resolvedRoot 'qqmusic-provider.exe'
if (-not (Test-Path -LiteralPath $providerExe -PathType Leaf)) {
    throw 'Release provider executable is missing.'
}

$guardRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'qqmusic-provider-release-guard-' + [System.Guid]::NewGuid().ToString('N')
)
$guardDevicePath = Join-Path $guardRoot 'qq-device.json'
[void](New-Item -ItemType Directory -Path $guardRoot)

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $providerExe
$startInfo.WorkingDirectory = $resolvedRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
$startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
$escapedGuardDevicePath = $guardDevicePath.Replace('"', '\"')
$startInfo.Arguments = "--device-path `"$escapedGuardDevicePath`""

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$responseLine = $null
$started = $false
try {
    if (-not $process.Start()) {
        throw 'Unable to start the release provider guard process.'
    }
    $started = $true
    $request = '{"v":1,"id":"release-guard","method":"system.handshake","params":{"protocolVersion":1}}'
    $process.StandardInput.WriteLine($request)
    $process.StandardInput.Flush()
    $process.StandardInput.Close()

    $readTask = $process.StandardOutput.ReadLineAsync()
    if (-not $readTask.Wait([System.TimeSpan]::FromSeconds(10))) {
        throw 'Release provider handshake timed out.'
    }
    $responseLine = $readTask.Result
    if (-not $process.WaitForExit(10000)) {
        throw 'Release provider did not stop after the handshake input closed.'
    }
}
finally {
    if ($started -and -not $process.HasExited) {
        $process.Kill()
        [void]$process.WaitForExit(5000)
    }
    $process.Dispose()
    $resolvedGuardRoot = [System.IO.Path]::GetFullPath($guardRoot)
    $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedGuardRoot.StartsWith(
        $resolvedTempRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -and (Test-Path -LiteralPath $resolvedGuardRoot)) {
        Remove-Item -LiteralPath $resolvedGuardRoot -Recurse -Force
    }
}

try {
    $response = $responseLine | ConvertFrom-Json -ErrorAction Stop
}
catch {
    throw 'Release provider returned an invalid handshake frame.'
}
if ($response.v -ne 1 -or $response.id -ne 'release-guard' -or $response.ok -ne $true) {
    throw 'Release provider returned an unexpected handshake frame.'
}
$mode = $response.result.provider.mode
if ($mode -eq 'live') {
    Write-Host 'Release provider mode: live'
    return
}
if ($mode -eq 'fixture' -and $AllowFixtureProviderForSpike) {
    Write-Warning 'Fixture provider accepted only because -AllowFixtureProviderForSpike was explicitly supplied.'
    return
}

throw "Release builds require provider mode 'live'; received '$mode'."
