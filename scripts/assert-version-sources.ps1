[CmdletBinding()]
param([string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$package = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw | ConvertFrom-Json
$tauri = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$cargo = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'src-tauri/Cargo.toml') -Raw
$lock = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'src-tauri/Cargo.lock') -Raw
$cargoVersion = [regex]::Match($cargo, '(?ms)^\[package\]\s*.*?^version\s*=\s*"([^"]+)"').Groups[1].Value
$lockVersion = [regex]::Match($lock, '(?m)^name = "qqmusic-gui"\r?\nversion = "([^"]+)"').Groups[1].Value
$versions = @([string]$package.version, [string]$tauri.version, $cargoVersion, $lockVersion)
if ($versions[0] -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or
    @($versions | Where-Object { $_ -ne $versions[0] }).Count -gt 0) {
    throw "Application version sources disagree: package=$($versions[0]), Tauri=$($versions[1]), Cargo=$cargoVersion, lock=$lockVersion"
}
Write-Host "Application source version: $($versions[0])"
