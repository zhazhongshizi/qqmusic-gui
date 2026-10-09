[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageRoot)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $PackageRoot).Path
$allowed = @('qqmusic-gui.exe', 'provider', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'UPGRADE.md')
$entries = @(Get-ChildItem -LiteralPath $root -Force)
foreach ($entry in $entries) {
    if ($entry.Name -notin $allowed -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Unexpected portable entry: $($entry.Name)"
    }
    if (($entry.Name -eq 'provider') -ne $entry.PSIsContainer) { throw "Unexpected entry type: $($entry.Name)" }
}
foreach ($name in $allowed) {
    if ($name -notin $entries.Name) { throw "Missing portable entry: $name" }
}
$provider = Join-Path $root 'provider'
$manifest = Join-Path $provider 'manifest.sha256'
$expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
[void]$expected.Add('manifest.sha256')
foreach ($line in Get-Content -LiteralPath $manifest) {
    if ($line -notmatch '^[0-9a-fA-F]{64}  (.+)$') { throw 'Invalid Provider inventory.' }
    $relative = $Matches[1]
    if ($relative -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or -not $expected.Add($relative)) {
        throw "Unsafe or duplicate Provider inventory entry: $relative"
    }
}
$actual = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
# Do not traverse junctions or symlinks.
$pending = [Collections.Generic.Stack[string]]::new()
$pending.Push($provider)
while ($pending.Count) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Provider contains a reparse point.' }
        if ($entry.PSIsContainer) { $pending.Push($entry.FullName); continue }
        $relative = $entry.FullName.Substring($provider.Length + 1).Replace('\', '/')
        if (-not $expected.Contains($relative)) { throw "Unlisted Provider file: $relative" }
        [void]$actual.Add($relative)
    }
}
if (-not $actual.SetEquals($expected)) { throw 'Provider inventory has missing files.' }
Write-Host "Portable contents passed: $($actual.Count) Provider files; no runtime directories packaged."
