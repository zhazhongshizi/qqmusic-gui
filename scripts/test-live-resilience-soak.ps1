[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [ValidateRange(1, 120)]
    [int]$DurationMinutes = 5,
    [string]$Target = 'x86_64-pc-windows-msvc'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$binaryPath = Join-Path $repositoryRoot "src-tauri\target\$Target\debug\qqmusic-gui.exe"
$providerPath = Join-Path $repositoryRoot 'provider\dist\qqmusic-provider\qqmusic-provider.exe'
$embeddedPort = 4445
$proxyNames = @('ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY')
$savedProxy = @{}

function Get-ExactProcess([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.Equals($resolved, [StringComparison]::OrdinalIgnoreCase) }
        catch { $false }
    })
}

if ((Get-ExactProcess $binaryPath).Count -gt 0) {
    throw 'Refusing to control an already-running resilience-soak application.'
}
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'build-provider.ps1')
    & (Join-Path $PSScriptRoot 'stage-provider-resource.ps1')
    & (Join-Path $PSScriptRoot 'build-desktop-e2e.ps1') -Target $Target
}
if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $providerPath -PathType Leaf)) {
    throw 'Resilience-soak binaries are missing.'
}
if (Get-NetTCPConnection -State Listen -LocalPort $embeddedPort -ErrorAction SilentlyContinue) {
    throw "Embedded WebDriver port $embeddedPort is already in use."
}

foreach ($name in $proxyNames) {
    $savedProxy[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
}
$env:QQ_GUI_SOAK_DURATION_MS = [string]($DurationMinutes * 60 * 1000)
$env:QQ_GUI_SOAK_FAULT_AFTER_MS = [string]([Math]::Floor($DurationMinutes * 60 * 1000 / 2))
$mochaTimeoutMs = ($DurationMinutes * 60 + 120) * 1000
$testExitCode = 1
$faultInjected = $false
$job = $null
$ownedGuiPid = $null
$ownedProviderPid = $null
$ownedRuntimeStartedAt = $null
Push-Location $repositoryRoot
try {
    $job = Start-Job -ScriptBlock {
        param($Root)
        $ErrorActionPreference = 'Continue'
        if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
            $PSNativeCommandUseErrorActionPreference = $false
        }
        Set-Location -LiteralPath $Root
        & pnpm wdio run ./wdio.conf.ts --spec ./e2e/manual/playlist-playback-live.e2e.ts --mochaOpts.grep soak --mochaOpts.timeout $using:mochaTimeoutMs 2>&1 |
            ForEach-Object { $_.ToString() }
        "SOAK_EXIT_CODE=$LASTEXITCODE"
    } -ArgumentList $repositoryRoot

    while ($job.State -eq 'Running') {
        Start-Sleep -Seconds 1
        $gui = @(Get-ExactProcess $binaryPath)
        if ($null -eq $ownedGuiPid -and $gui.Count -eq 1) {
            $ownedGuiPid = $gui[0].Id
        }
        $ownedGui = if ($null -eq $ownedGuiPid) { @() } else {
            @($gui | Where-Object { $_.Id -eq $ownedGuiPid })
        }
        if ($ownedGui.Count -eq 1) {
            $expectedProvider = (Resolve-Path -LiteralPath $providerPath).Path
            $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ownedGuiPid" | Where-Object {
                $_.ExecutablePath -and $_.ExecutablePath.Equals($expectedProvider, [StringComparison]::OrdinalIgnoreCase)
            })
            if ($null -eq $ownedRuntimeStartedAt -and $children.Count -eq 1) {
                $ownedRuntimeStartedAt = Get-Date
            }
        }
        if (-not $faultInjected -and $ownedGui.Count -eq 1 -and
            $null -ne $ownedRuntimeStartedAt -and
            ((Get-Date) - $ownedRuntimeStartedAt).TotalMinutes -ge ($DurationMinutes / 2)) {
            $expectedProvider = (Resolve-Path -LiteralPath $providerPath).Path
            $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ownedGuiPid" | Where-Object {
                $_.ExecutablePath -and $_.ExecutablePath.Equals($expectedProvider, [StringComparison]::OrdinalIgnoreCase)
            })
            if ($children.Count -ne 1) { throw 'Unable to identify exactly one owned Provider child.' }
            $ownedProviderPid = [int]$children[0].ProcessId
            Stop-Process -Id $ownedProviderPid -Force
            $faultInjected = $true
            Write-Host 'SOAK_FAULT provider_child_terminated=1'
        }
    }
    $jobOutput = @(Receive-Job -Job $job -Wait -ErrorAction Continue)
    $exitMarker = [string]($jobOutput | Select-Object -Last 1)
    if ($exitMarker -notmatch '^SOAK_EXIT_CODE=(-?\d+)$') {
        throw 'Resilience-soak job did not return a bounded exit code.'
    }
    $testExitCode = [int]$Matches[1]
    $jobOutput | Select-Object -SkipLast 1 | ForEach-Object { Write-Host ([string]$_) }
}
finally {
    Pop-Location
    if ($job) { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
    Remove-Item Env:QQ_GUI_SOAK_DURATION_MS, Env:QQ_GUI_SOAK_FAULT_AFTER_MS -ErrorAction SilentlyContinue
    foreach ($name in $proxyNames) {
        if ($null -eq $savedProxy[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        else { Set-Item -LiteralPath "Env:$name" -Value $savedProxy[$name] }
    }
    if ($null -ne $ownedGuiPid) {
        $ownedGui = Get-Process -Id $ownedGuiPid -ErrorAction SilentlyContinue
        if ($ownedGui) {
            try {
                $resolvedBinary = (Resolve-Path -LiteralPath $binaryPath).Path
                if ($ownedGui.Path.Equals($resolvedBinary, [StringComparison]::OrdinalIgnoreCase)) {
                    Stop-Process -Id $ownedGuiPid -Force
                }
            }
            catch { }
        }
    }
}
if ($testExitCode -ne 0 -or -not $faultInjected) { throw 'Live resilience soak failed.' }
if (Get-NetTCPConnection -State Listen -LocalPort $embeddedPort -ErrorAction SilentlyContinue) {
    throw "Embedded WebDriver port $embeddedPort remained open after resilience soak."
}
Write-Host 'Live resilience soak passed.'
