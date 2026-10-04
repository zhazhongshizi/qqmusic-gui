[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$binRoot = Join-Path $repositoryRoot 'node_modules\.bin'
$tsc = Join-Path $binRoot 'tsc.CMD'
$vite = Join-Path $binRoot 'vite.CMD'

foreach ($tool in @($tsc, $vite)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
        throw "Required local frontend tool is missing: '$tool'. Run pnpm install first."
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)]
        [string]$Label,

        [Parameter(Mandatory)]
        [string]$Executable,

        [Parameter(Mandatory)]
        [string[]]$ArgumentList
    )

    Write-Host "[$Label]"
    & $Executable @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

Push-Location $repositoryRoot
try {
    Invoke-Checked -Label 'Rhine scene build' -Executable $tsc -ArgumentList @('-p', 'vendor/rhine/tsconfig.json')
    Invoke-Checked -Label 'TypeScript build' -Executable $tsc -ArgumentList @('-b', '--pretty', 'false')
    Invoke-Checked -Label 'Vite production build' -Executable $vite -ArgumentList @('build')
    Invoke-Checked -Label 'Remote WebUI build' -Executable $vite -ArgumentList @('build', '--config', 'vite.remote.config.ts')
}
finally {
    Pop-Location
}
