[CmdletBinding()]
param(
    [switch]$SkipReleaseBuild,
    [string]$ArtifactTag,
    [string]$Target = 'x86_64-pc-windows-msvc'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $repositoryRoot 'src-tauri'
& (Join-Path $PSScriptRoot 'assert-version-sources.ps1') -RepositoryRoot $repositoryRoot
$targetReleaseRoot = Join-Path $tauriRoot "target\$Target\release"
$applicationPath = Join-Path $targetReleaseRoot 'qqmusic-gui.exe'
$releaseProviderRoot = Join-Path $targetReleaseRoot 'provider'
$outputRoot = Join-Path $repositoryRoot 'output\releases'
$tauriConfig = Get-Content -LiteralPath (Join-Path $tauriRoot 'tauri.conf.json') -Raw |
    ConvertFrom-Json
$version = [string]$tauriConfig.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw 'Tauri configuration contains an invalid application version.'
}
if ([string]::IsNullOrWhiteSpace($ArtifactTag)) {
    $ArtifactTag = "{0}_{1}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), (New-Guid).Guid.Substring(0, 8)
}
if ($ArtifactTag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw 'ArtifactTag must contain only letters, numbers, dots, underscores, or hyphens.'
}
$portableName = "QQ-Music-GUI_${version}_x64-portable_${ArtifactTag}"
$portableRoot = Join-Path $outputRoot $portableName
$archivePath = Join-Path $outputRoot "$portableName.zip"

if ($Target -ne 'x86_64-pc-windows-msvc') {
    throw "Only the approved Windows x64 target is supported; received '$Target'."
}

if (-not $SkipReleaseBuild) {
    & (Join-Path $PSScriptRoot 'build-release.ps1') -Target $Target
}

if (-not (Test-Path -LiteralPath $applicationPath -PathType Leaf)) {
    throw 'Release application executable is missing. Run scripts/build-release.ps1 first.'
}
& (Join-Path $PSScriptRoot 'verify-provider-manifest.ps1') -BundleRoot $releaseProviderRoot
& (Join-Path $PSScriptRoot 'assert-release-provider.ps1') -BundleRoot $releaseProviderRoot

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

if ((Get-PeMachine -Path $applicationPath) -ne 0x8664) {
    throw "Release application is not an x64 PE image: '$applicationPath'."
}

$resolvedOutput = [System.IO.Path]::GetFullPath($outputRoot)
$resolvedPortable = [System.IO.Path]::GetFullPath($portableRoot)
$resolvedArchive = [System.IO.Path]::GetFullPath($archivePath)
foreach ($candidate in @($resolvedPortable, $resolvedArchive)) {
    if (-not $candidate.StartsWith(
        $resolvedOutput + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Refusing to package outside the approved output directory: '$candidate'."
    }
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
if (Test-Path -LiteralPath $portableRoot) {
    throw "Refusing to overwrite an existing portable directory: '$portableRoot'."
}
if (Test-Path -LiteralPath $archivePath) {
    throw "Refusing to overwrite an existing portable archive: '$archivePath'."
}
New-Item -ItemType Directory -Path $portableRoot | Out-Null

Copy-Item -LiteralPath $applicationPath -Destination $portableRoot
Copy-Item -LiteralPath $releaseProviderRoot -Destination $portableRoot -Recurse
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'LICENSE') -Destination $portableRoot
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'THIRD_PARTY_NOTICES.md') -Destination $portableRoot
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'README.md') -Destination $portableRoot
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'UPGRADE.md') -Destination $portableRoot

$portableProviderRoot = Join-Path $portableRoot 'provider'
& (Join-Path $PSScriptRoot 'verify-provider-manifest.ps1') -BundleRoot $portableProviderRoot
& (Join-Path $PSScriptRoot 'assert-release-provider.ps1') -BundleRoot $portableProviderRoot
& (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $portableRoot
& (Join-Path $PSScriptRoot 'test-release-smoke.ps1') -PackageRoot $portableRoot

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $portableRoot,
    $archivePath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
)
$archive = Get-Item -LiteralPath $archivePath
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
Write-Host "Portable directory: $portableRoot"
Write-Host "Portable archive: $archivePath"
Write-Host "Portable archive size: $($archive.Length) bytes"
Write-Host "Portable SHA-256: $archiveHash"
Write-Host 'Runtime requirement: Microsoft Edge WebView2 Runtime'
