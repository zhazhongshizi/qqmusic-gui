[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Join-Path (Split-Path -Parent $PSScriptRoot) ('output/validation/release-tools-' + (New-Guid).Guid)
$package = Join-Path $root 'package'
New-Item -ItemType Directory -Path (Join-Path $package 'provider') -Force | Out-Null
foreach ($name in @('qqmusic-gui.exe', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'UPGRADE.md')) {
    [IO.File]::WriteAllText((Join-Path $package $name), 'fixture')
}
[IO.File]::WriteAllText((Join-Path $package 'provider/payload.bin'), 'fixture')
[IO.File]::WriteAllText((Join-Path $package 'provider/manifest.sha256'), (('0' * 64) + '  payload.bin'))
function Assert-Rejected([scriptblock]$Action, [string]$Name, [string]$Message) {
    $rejected = $false
    try { & $Action | Out-Null } catch {
        if ($Message -and $_.Exception.Message -notlike $Message) { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw "Expected rejection: $Name" }
}
& (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $package
Assert-Rejected { & (Join-Path $PSScriptRoot 'test-release-smoke.ps1') -PackageRoot $package } 'old executable without isolated mode' 'This executable does not support the isolated package-check protocol*'
[IO.File]::WriteAllText((Join-Path $package 'debug.log'), 'fixture')
Assert-Rejected { & (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $package } 'runtime log'
Remove-Item -LiteralPath (Join-Path $package 'debug.log')
[IO.File]::WriteAllText((Join-Path $package 'provider/unlisted.sqlite3'), 'fixture')
Assert-Rejected { & (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $package } 'unlisted Provider file'
Remove-Item -LiteralPath (Join-Path $package 'provider/unlisted.sqlite3')
Remove-Item -LiteralPath (Join-Path $package 'provider/payload.bin')
Assert-Rejected { & (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $package } 'missing Provider file'
[IO.File]::WriteAllText((Join-Path $package 'provider/manifest.sha256'), (('0' * 64) + '  ../outside.bin'))
Assert-Rejected { & (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $package } 'inventory traversal'
$source = Join-Path $root 'sources'
New-Item -ItemType Directory -Path (Join-Path $source 'src-tauri') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $source 'package.json'), '{"version":"1.0.1"}')
[IO.File]::WriteAllText((Join-Path $source 'src-tauri/tauri.conf.json'), '{"version":"1.0.1"}')
[IO.File]::WriteAllText((Join-Path $source 'src-tauri/Cargo.toml'), "[package]`nname = `"qqmusic-gui`"`nversion = `"1.0.1`"")
[IO.File]::WriteAllText((Join-Path $source 'src-tauri/Cargo.lock'), "[[package]]`nname = `"qqmusic-gui`"`nversion = `"1.0.1`"")
& (Join-Path $PSScriptRoot 'assert-version-sources.ps1') -RepositoryRoot $source
[IO.File]::WriteAllText((Join-Path $source 'package.json'), '{"version":"1.0.2"}')
Assert-Rejected { & (Join-Path $PSScriptRoot 'assert-version-sources.ps1') -RepositoryRoot $source } 'version mismatch'
Write-Host "Release tools: 8 checks passed. Fixtures: $root"
