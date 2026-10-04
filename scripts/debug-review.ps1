[CmdletBinding()]
param(
    [ValidateSet('Run', 'Status', 'Hold', 'Release')][string]$Action = 'Run',
    [string]$Owner = 'current task'
)
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $repositoryRoot '.workflow'
$guardPath = Join-Path $stateRoot 'debug-review.guard'
$holdPath = Join-Path $stateRoot 'debug-review.json'

# Status must not create directories or files.
if ($Action -eq 'Status') {
    if (-not (Test-Path -LiteralPath $guardPath)) {
        if (Test-Path -LiteralPath $holdPath) {
            Get-Content -LiteralPath $holdPath -Raw | ConvertFrom-Json |
                Select-Object owner, heldAt, acquiredAt | ConvertTo-Json
        }
        else { Write-Output 'Debug review: none' }
        return
    }
    try { $probe = [IO.File]::Open($guardPath, 'Open', 'ReadWrite', 'None') }
    catch [IO.IOException] { Write-Output 'Debug session or review operation is running.'; return }
    try {
        if (Test-Path -LiteralPath $holdPath) {
            $hold = Get-Content -LiteralPath $holdPath -Raw | ConvertFrom-Json
            $hold | Select-Object owner, heldAt, acquiredAt | ConvertTo-Json
        } else { Write-Output 'Debug review: none' }
    } finally { $probe.Dispose() }
    return
}

New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
try { $guard = [IO.File]::Open($guardPath, 'OpenOrCreate', 'ReadWrite', 'None') }
catch [IO.IOException] { throw 'A Debug session or review operation is already running.' }
try {
    $hold = $null
    if (Test-Path -LiteralPath $holdPath) {
        $hold = Get-Content -LiteralPath $holdPath -Raw | ConvertFrom-Json
        if ($hold.PSObject.Properties.Name -contains 'token') {
            throw 'Legacy token reservation found. Confirm the previous review has ended before removing the local debug-review.json and using this entry.'
        }
    }
    if ($Action -eq 'Hold') {
        if (-not $PSBoundParameters.ContainsKey('Owner') -or [string]::IsNullOrWhiteSpace($Owner)) { throw 'Hold requires an explicit task owner.' }
        if ($null -ne $hold) { throw "Review already held by '$($hold.owner)'." }
        [ordered]@{ owner=$Owner; heldAt=[DateTime]::UtcNow.ToString('o') } |
            ConvertTo-Json | Set-Content -LiteralPath $holdPath -Encoding UTF8
        Write-Output "Review held by '$Owner'. Release when review ends."
        return
    }
    if ($Action -eq 'Release') {
        if ($null -eq $hold) { Write-Output 'Debug review: none'; return }
        if (-not $PSBoundParameters.ContainsKey('Owner') -or $hold.owner -cne $Owner) { throw "Review belongs to '$($hold.owner)'." }
        Remove-Item -LiteralPath $holdPath
        Write-Output 'Debug review released.'
        return
    }
    if ($null -ne $hold -and (-not $PSBoundParameters.ContainsKey('Owner') -or $hold.owner -cne $Owner)) {
        throw "Review is held by '$($hold.owner)'. Use that Owner only when continuing its review."
    }
    if ($env:CARGO_TARGET_DIR -or $env:CARGO_BUILD_TARGET) { throw 'Unset custom Cargo target variables for the canonical Debug entry.' }
    $tauri = Join-Path $repositoryRoot 'node_modules\.bin\tauri.CMD'
    if (-not (Test-Path -LiteralPath $tauri)) { throw 'Local Tauri CLI missing. Run pnpm install first.' }
    Push-Location $repositoryRoot
    try {
        & $tauri dev
        if ($LASTEXITCODE -ne 0) { throw "Tauri dev failed with exit code $LASTEXITCODE." }
    } finally { Pop-Location }
} finally { $guard.Dispose() }
