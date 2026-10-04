[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$providerRoot = Join-Path $repositoryRoot 'provider'
$providerPython = Join-Path $providerRoot '.venv\Scripts\python.exe'
$specPath = Join-Path $providerRoot 'qqmusic-provider.spec'
$distRoot = Join-Path $providerRoot 'dist'
$workRoot = Join-Path $providerRoot 'build'
$bundleRoot = Join-Path $distRoot 'qqmusic-provider'
$manifestPath = Join-Path $bundleRoot 'manifest.sha256'

if (-not (Test-Path -LiteralPath $providerPython -PathType Leaf)) {
    throw 'Provider venv is missing. Run scripts/bootstrap-provider.ps1 first.'
}

& $providerPython -m PyInstaller --noconfirm --clean --log-level WARN `
    --distpath $distRoot --workpath $workRoot $specPath
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed with exit code $LASTEXITCODE."
}

$providerExe = Join-Path $bundleRoot 'qqmusic-provider.exe'
if (-not (Test-Path -LiteralPath $providerExe -PathType Leaf)) {
    throw "Packaged provider executable is missing: '$providerExe'."
}

$bundleResolved = (Resolve-Path -LiteralPath $bundleRoot).Path
$manifestLines = @(Get-ChildItem -LiteralPath $bundleResolved -Recurse -File |
    Where-Object { $_.FullName -ne $manifestPath } |
    Sort-Object FullName |
    ForEach-Object {
        if (-not $_.FullName.StartsWith(
            $bundleResolved + [System.IO.Path]::DirectorySeparatorChar,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw "Refusing to hash a file outside the provider bundle: '$($_.FullName)'."
        }
        $relative = $_.FullName.Substring($bundleResolved.Length + 1).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $relative"
    })

[System.IO.File]::WriteAllLines($manifestPath, $manifestLines, [System.Text.UTF8Encoding]::new($false))

Write-Host "Provider bundle: $bundleRoot"
Write-Host "Provider files: $($manifestLines.Count)"
