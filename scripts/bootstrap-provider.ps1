[CmdletBinding()]
param(
    [string]$PythonExe = "python3.13",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$ProviderRoot = Join-Path (Split-Path -Parent $PSScriptRoot) "provider"
$VenvRoot = Join-Path $ProviderRoot ".venv"
$VenvPython = Join-Path $VenvRoot "Scripts\python.exe"
$RequirementsLock = Join-Path $ProviderRoot "requirements.lock"

function Get-PythonInfo {
    param(
        [Parameter(Mandatory)]
        [string]$Executable
    )

    $Probe = "import json, struct, sys, sysconfig; print(json.dumps({'version': list(sys.version_info[:3]), 'pointerBits': struct.calcsize('P') * 8, 'platform': sysconfig.get_platform(), 'baseExecutable': sys._base_executable}))"
    $InfoJson = & $Executable -c $Probe
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to execute Python from '$Executable'."
    }
    return $InfoJson | ConvertFrom-Json
}

function Assert-ProviderPython {
    param(
        [Parameter(Mandatory)]
        [object]$Info,

        [Parameter(Mandatory)]
        [string]$Label
    )

    if (($Info.version[0] -ne 3) -or ($Info.version[1] -ne 13)) {
        throw "Python 3.13 is required; $Label reported $($Info.version -join '.')."
    }
    if (($Info.pointerBits -ne 64) -or ($Info.platform -ne "win-amd64")) {
        throw "Windows x64 Python is required; $Label reported $($Info.pointerBits)-bit '$($Info.platform)'."
    }
}

function Get-NormalizedPackageName {
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    return ($Name.ToLowerInvariant() -replace "[-_.]+", "-")
}

$PythonCommand = Get-Command -Name $PythonExe -ErrorAction Stop
$PythonInfo = Get-PythonInfo -Executable $PythonCommand.Source
Assert-ProviderPython -Info $PythonInfo -Label "'$($PythonCommand.Source)'"

if (-not (Test-Path -LiteralPath $VenvPython -PathType Leaf)) {
    & $PythonCommand.Source -m venv $VenvRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create the provider virtual environment at '$VenvRoot'."
    }
}

$VenvInfo = Get-PythonInfo -Executable $VenvPython
Assert-ProviderPython -Info $VenvInfo -Label "provider virtual environment '$VenvRoot'"

if ($VenvInfo.baseExecutable -ne $PythonInfo.baseExecutable) {
    Write-Warning "The existing provider venv was created by '$($VenvInfo.baseExecutable)', not '$($PythonInfo.baseExecutable)'. Remove '$VenvRoot' to recreate it with -PythonExe '$PythonExe'."
}

if (-not $SkipInstall) {
    $LockLines = Get-Content -LiteralPath $RequirementsLock
    $LockEntries = @($LockLines | Where-Object { $_ -and -not $_.StartsWith("#") })
    $InvalidLockEntries = @($LockEntries | Where-Object { $_ -notmatch "^[A-Za-z0-9_.-]+==\S+$" })
    if ($InvalidLockEntries.Count -gt 0) {
        throw "requirements.lock must contain exact name==version entries only: $($InvalidLockEntries -join ', ')"
    }

    & $VenvPython -m pip install --disable-pip-version-check --no-deps --only-binary=:all: -r $RequirementsLock
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install the locked provider dependencies."
    }

    & $VenvPython -m pip install --disable-pip-version-check --no-deps --no-build-isolation -e $ProviderRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install the local provider package."
    }

    & $VenvPython -m pip check --disable-pip-version-check
    if ($LASTEXITCODE -ne 0) {
        throw "The provider virtual environment has inconsistent dependencies."
    }

    $ExpectedPackages = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($Entry in $LockEntries) {
        [void]$ExpectedPackages.Add((Get-NormalizedPackageName -Name ($Entry -split "==", 2)[0]))
    }
    [void]$ExpectedPackages.Add("qqmusic-gui-provider")

    $InstalledJson = & $VenvPython -m pip list --disable-pip-version-check --format=json
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect installed provider packages."
    }
    $UnexpectedPackages = @(
        ($InstalledJson | ConvertFrom-Json) |
            ForEach-Object { Get-NormalizedPackageName -Name $_.name } |
            Where-Object { -not $ExpectedPackages.Contains($_) } |
            Sort-Object -Unique
    )
    if ($UnexpectedPackages.Count -gt 0) {
        Write-Warning "The reused provider venv contains packages outside requirements.lock: $($UnexpectedPackages -join ', '). Remove '$VenvRoot' for a clean environment."
    }
}

Write-Host "Provider Python: $VenvPython"
Write-Host "Provider version: $($VenvInfo.version -join '.') ($($VenvInfo.pointerBits)-bit $($VenvInfo.platform))"
if ($SkipInstall) {
    Write-Host "Dependency installation skipped."
}
