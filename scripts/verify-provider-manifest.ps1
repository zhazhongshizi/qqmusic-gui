[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$BundleRoot
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = (Resolve-Path -LiteralPath $BundleRoot -ErrorAction Stop).Path
$manifestPath = Join-Path $resolvedRoot 'manifest.sha256'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'Provider bundle manifest is missing.'
}

$expected = [System.Collections.Generic.Dictionary[string, string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
)
$lines = [System.IO.File]::ReadAllLines($manifestPath, [System.Text.Encoding]::UTF8)
if ($lines.Count -eq 0 -or $lines.Count -gt 16384) {
    throw 'Provider bundle manifest has an invalid entry count.'
}

foreach ($line in $lines) {
    if ($line -notmatch '^(?<hash>[0-9a-fA-F]{64})  (?<path>.+)$') {
        throw 'Provider bundle manifest contains an invalid line.'
    }
    $relative = $Matches.path
    if ($relative.Contains('\') -or
        [System.IO.Path]::IsPathRooted($relative) -or
        $relative -eq 'manifest.sha256' -or
        @($relative.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) {
        throw 'Provider bundle manifest contains an unsafe path.'
    }
    if ($expected.ContainsKey($relative)) {
        throw 'Provider bundle manifest contains a duplicate path.'
    }
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot $relative))
    if (-not $candidate.StartsWith(
        $resolvedRoot + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Provider bundle manifest path escapes the bundle root.'
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw 'Provider bundle manifest references a missing file.'
    }
    $actualHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
    if (-not $actualHash.Equals($Matches.hash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Provider bundle file hash mismatch.'
    }
    $expected.Add($relative, $candidate)
}

$actual = @(
    Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File |
        Where-Object { $_.FullName -ne $manifestPath } |
        ForEach-Object {
            if (-not $_.FullName.StartsWith(
                $resolvedRoot + [System.IO.Path]::DirectorySeparatorChar,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                throw 'Provider bundle enumeration escaped the bundle root.'
            }
            $_.FullName.Substring($resolvedRoot.Length + 1).Replace('\', '/')
        }
)
if ($actual.Count -ne $expected.Count) {
    throw 'Provider bundle file set does not match its manifest.'
}
foreach ($relative in $actual) {
    if (-not $expected.ContainsKey($relative)) {
        throw 'Provider bundle contains a file not listed in its manifest.'
    }
}
if (-not $expected.ContainsKey('qqmusic-provider.exe')) {
    throw 'Provider bundle manifest does not include the executable.'
}

Write-Host "Verified provider manifest: $($expected.Count) files"
