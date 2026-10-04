[CmdletBinding()]
param(
    [switch]$Live,
    [ValidateSet('0.6.9', '0.7.1')]
    [string[]]$Version = @('0.6.9', '0.7.1'),
    [string]$PythonExe = 'python3.13',
    [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repositoryRoot 'provider\tools\compatibility_matrix.py'
$lock = Join-Path $repositoryRoot 'provider\requirements.lock'
$python = (Get-Command -Name $PythonExe -ErrorAction Stop).Source
$results = [System.Collections.Generic.List[object]]::new()

function Add-ProbeResult {
    param([Parameter(Mandatory)][string]$Json)
    $parsed = $Json | ConvertFrom-Json -ErrorAction Stop
    if ($parsed.formatVersion -ne 1 -or -not $parsed.targetVersion -or -not $parsed.checks) {
        throw 'Compatibility probe returned an invalid result shape.'
    }
    [void]$results.Add($parsed)
}

if (-not $Live) {
    foreach ($candidate in $Version) {
        $json = & $python $tool --mode offline --target-version $candidate
        if ($LASTEXITCODE -ne 0) { throw "Offline probe failed for $candidate." }
        Add-ProbeResult -Json ($json -join '')
    }
}
else {
    $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $experimentRoot = Join-Path $tempBase ("qqmusic-provider-compat-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $experimentRoot | Out-Null
    try {
        foreach ($candidate in $Version) {
            $venv = Join-Path $experimentRoot ("venv-" + $candidate.Replace('.', '-'))
            & $python -m venv $venv
            if ($LASTEXITCODE -ne 0) { throw "Unable to create isolated venv for $candidate." }
            $venvPython = Join-Path $venv 'Scripts\python.exe'
            & $venvPython -m pip install --disable-pip-version-check -r $lock
            if ($LASTEXITCODE -ne 0) { throw "Dependency install blocked for $candidate." }
            & $venvPython -m pip install --disable-pip-version-check --upgrade "qqmusic-api-python==$candidate"
            if ($LASTEXITCODE -ne 0) { throw "Candidate $candidate is unavailable." }
            $devicePath = Join-Path $venv 'qq-device.json'
            $json = & $venvPython $tool --mode live --target-version $candidate --device-path $devicePath
            Add-ProbeResult -Json ($json -join '')
        }
    }
    catch {
        [void]$results.Add([pscustomobject]@{
            formatVersion = 1
            mode = 'live'
            targetVersion = 'matrix'
            overall = 'blocked'
            checks = @([pscustomobject]@{
                name = 'environment-setup'
                status = 'blocked'
                detail = 'candidate installation or network unavailable'
            })
        })
    }
    finally {
        $resolved = [System.IO.Path]::GetFullPath($experimentRoot)
        if ($resolved.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolved).StartsWith('qqmusic-provider-compat-')) {
            Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$document = [pscustomobject]@{
    formatVersion = 1
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    live = [bool]$Live
    results = $results
} | ConvertTo-Json -Depth 8

if ($ResultPath) {
    $parent = Split-Path -Parent ([System.IO.Path]::GetFullPath($ResultPath))
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($ResultPath), $document)
}
$document
