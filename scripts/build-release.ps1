[CmdletBinding()]
param(
    [switch]$SkipProviderBuild,
    [switch]$AllowFixtureProviderForSpike,
    [switch]$Installer,
    [string]$Target = 'x86_64-pc-windows-msvc'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $repositoryRoot 'src-tauri'
& (Join-Path $PSScriptRoot 'assert-version-sources.ps1') -RepositoryRoot $repositoryRoot
$tauriCli = Join-Path $repositoryRoot 'node_modules\.bin\tauri.CMD'
$tauriConfig = Get-Content -LiteralPath (Join-Path $tauriRoot 'tauri.conf.json') -Raw |
    ConvertFrom-Json
$version = [string]$tauriConfig.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw 'Tauri configuration contains an invalid application version.'
}
$targetReleaseRoot = Join-Path $tauriRoot "target\$Target\release"
$releaseProviderRoot = Join-Path $targetReleaseRoot 'provider'
$stagedProviderRoot = Join-Path $tauriRoot 'resources\provider'

if ($Target -ne 'x86_64-pc-windows-msvc') {
    throw "Only the approved Windows x64 target is supported; received '$Target'."
}
if (-not (Test-Path -LiteralPath $tauriCli -PathType Leaf)) {
    throw "Local Tauri CLI is missing: '$tauriCli'. Run pnpm install first."
}

if (-not $SkipProviderBuild) {
    & (Join-Path $PSScriptRoot 'build-provider.ps1')
    & (Join-Path $PSScriptRoot 'stage-provider-resource.ps1')
}
else {
    & (Join-Path $PSScriptRoot 'verify-provider-manifest.ps1') -BundleRoot $stagedProviderRoot
}

if ($AllowFixtureProviderForSpike) {
    & (Join-Path $PSScriptRoot 'assert-release-provider.ps1') `
        -BundleRoot $stagedProviderRoot `
        -AllowFixtureProviderForSpike
}
else {
    & (Join-Path $PSScriptRoot 'assert-release-provider.ps1') -BundleRoot $stagedProviderRoot
}

$resolvedTargetRelease = [System.IO.Path]::GetFullPath($targetReleaseRoot)
$resolvedReleaseProvider = [System.IO.Path]::GetFullPath($releaseProviderRoot)
if (-not $resolvedReleaseProvider.StartsWith(
    $resolvedTargetRelease + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw "Refusing to clean a provider directory outside the target release root: '$resolvedReleaseProvider'."
}
if (Test-Path -LiteralPath $releaseProviderRoot) {
    Remove-Item -LiteralPath $releaseProviderRoot -Recurse -Force
}

Push-Location $repositoryRoot
try {
    $tauriArguments = @('build', '--target', $Target, '--config', 'src-tauri/tauri.release.conf.json')
    if ($Installer) {
        $tauriArguments += @('--bundles', 'nsis')
        Write-Host 'Release mode: NSIS installer'
    }
    else {
        $tauriArguments += '--no-bundle'
        Write-Host 'Release mode: portable executable (--no-bundle)'
    }
    & $tauriCli @tauriArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri release build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

& (Join-Path $PSScriptRoot 'verify-provider-manifest.ps1') -BundleRoot $releaseProviderRoot

$applicationPath = Join-Path $targetReleaseRoot 'qqmusic-gui.exe'

function Get-PeMachine {
    param([Parameter(Mandatory)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $reader = [System.IO.BinaryReader]::new($stream)
        if ($stream.Length -lt 0x40 -or $reader.ReadUInt16() -ne 0x5A4D) {
            throw "Executable is not a valid MZ image: '$Path'."
        }
        $stream.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0 -or $peOffset + 6 -gt $stream.Length) {
            throw "Executable contains an invalid PE header offset: '$Path'."
        }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            throw "Executable is missing the PE signature: '$Path'."
        }
        return $reader.ReadUInt16()
    }
    finally {
        $stream.Dispose()
    }
}

if (-not (Test-Path -LiteralPath $applicationPath -PathType Leaf)) {
    throw "Release application executable is missing: '$applicationPath'."
}
$machine = Get-PeMachine -Path $applicationPath
if ($machine -ne 0x8664) {
    throw ("Release application is not an x64 PE image (machine 0x{0:X4}): '{1}'" -f $machine, $applicationPath)
}
Write-Host "Release application x64 PE: $applicationPath"

Write-Host "Release application: $applicationPath"
if ($Installer) {
    $installerPath = Join-Path $targetReleaseRoot "bundle\nsis\QQ Music GUI_${version}_x64-setup.exe"
    if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
        throw 'NSIS installer is missing.'
    }
    $installerHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
    Write-Host "NSIS installer: $installerPath"
    Write-Host "NSIS SHA-256: $installerHash"
}
