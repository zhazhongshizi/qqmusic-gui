[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repositoryRoot 'provider\dist\qqmusic-provider'
$resourcesRoot = Join-Path $repositoryRoot 'src-tauri\resources'
$targetRoot = Join-Path $resourcesRoot 'provider'
$temporaryRoot = Join-Path $resourcesRoot 'provider.staging'

if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'manifest.sha256') -PathType Leaf)) {
    throw 'Packaged provider manifest is missing. Run scripts/build-provider.ps1 first.'
}

& (Join-Path $PSScriptRoot 'verify-provider-manifest.ps1') -BundleRoot $sourceRoot

$resolvedResources = [System.IO.Path]::GetFullPath($resourcesRoot)
$resolvedTarget = [System.IO.Path]::GetFullPath($targetRoot)
$resolvedTemporary = [System.IO.Path]::GetFullPath($temporaryRoot)
foreach ($candidate in @($resolvedTarget, $resolvedTemporary)) {
    if (-not $candidate.StartsWith($resolvedResources + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to stage outside Tauri resources: '$candidate'."
    }
}

New-Item -ItemType Directory -Path $resourcesRoot -Force | Out-Null
if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
}
Copy-Item -LiteralPath $sourceRoot -Destination $temporaryRoot -Recurse
if (Test-Path -LiteralPath $targetRoot) {
    Remove-Item -LiteralPath $targetRoot -Recurse -Force
}
Move-Item -LiteralPath $temporaryRoot -Destination $targetRoot

& (Join-Path $PSScriptRoot 'verify-provider-manifest.ps1') -BundleRoot $targetRoot

Write-Host "Staged provider resource: $targetRoot"
