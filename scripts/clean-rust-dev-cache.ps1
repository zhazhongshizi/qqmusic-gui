[CmdletBinding()]
param(
    [switch]$Full,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# 1. Resolve paths
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $repositoryRoot 'src-tauri'
$targetRoot = Join-Path $tauriRoot 'target'
$cargoManifestPath = Join-Path $tauriRoot 'Cargo.toml'
$debugGuiPath = Join-Path $targetRoot 'debug\qqmusic-gui.exe'
$debugTuiPath = Join-Path $targetRoot 'debug\qqmusic-tui.exe'

if (-not (Test-Path -LiteralPath $cargoManifestPath)) {
    throw "Cargo manifest not found at: $cargoManifestPath"
}

# Helper: Format sizes in GiB / MiB / KiB / B
function Format-ByteSize {
    param([long]$Bytes)

    if ($Bytes -ge 1GB) {
        return ("{0:N2} GiB ({1:N0} bytes)" -f ($Bytes / 1GB), $Bytes)
    } elseif ($Bytes -ge 1MB) {
        return ("{0:N2} MiB ({1:N0} bytes)" -f ($Bytes / 1MB), $Bytes)
    } elseif ($Bytes -ge 1KB) {
        return ("{0:N2} KiB ({1:N0} bytes)" -f ($Bytes / 1KB), $Bytes)
    } else {
        return ("{0} B" -f $Bytes)
    }
}

# Helper: Recursively calculate directory size in bytes
function Get-DirectorySize {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return 0L
    }

    $measure = Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum

    if ($null -ne $measure -and $null -ne $measure.Sum) {
        return [long]$measure.Sum
    }
    return 0L
}

# Helper: Check for active build processes (cargo / rustc)
function Assert-NoActiveBuildProcesses {
    $processes = Get-Process -Name 'cargo', 'rustc' -ErrorAction SilentlyContinue
    if ($processes -and $processes.Count -gt 0) {
        $pids = ($processes | ForEach-Object { "$($_.ProcessName) (PID: $($_.Id))" }) -join ', '
        Write-Error "Active build process(es) detected: $pids. Please wait for builds to finish or stop them before cleaning cache."
        exit 1
    }
}

# Helper: Path safety check - ensure target path is strictly inside $targetRoot
function Assert-PathIsInsideTarget {
    param(
        [Parameter(Mandatory)]
        [string]$PathToValidate,

        [Parameter(Mandatory)]
        [string]$TargetRootPath
    )

    if ([string]::IsNullOrWhiteSpace($PathToValidate)) {
        throw "Path safety check failed: target path is empty."
    }

    $resolvedTargetRoot = [System.IO.Path]::GetFullPath($TargetRootPath).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $resolvedPath = [System.IO.Path]::GetFullPath($PathToValidate).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)

    if (-not (Test-Path -LiteralPath $resolvedTargetRoot)) {
        throw "Path safety check failed: target root '$resolvedTargetRoot' does not exist."
    }

    # Must be strictly inside target root (cannot be target root itself, nor outside)
    $prefix = $resolvedTargetRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path safety check failed: '$resolvedPath' is not inside '$resolvedTargetRoot'."
    }

    return $resolvedPath
}

# 2. Execution logic
if (-not $Full) {
    $modeName = if ($DryRun) { "Incremental (DryRun)" } else { "Incremental (Default)" }
    Write-Host "=== Rust Dev Cache Clean [$modeName] ===" -ForegroundColor Cyan
    Write-Host "Scope: Releasing incremental build caches while preserving debug binaries."
    Write-Host ""

    Assert-NoActiveBuildProcesses

    if (-not (Test-Path -LiteralPath $targetRoot)) {
        Write-Host "Target directory not found: $targetRoot" -ForegroundColor Yellow
        $targetBeforeBytes = 0L
        $targetAfterBytes = 0L
        $freedBytes = 0L
        $removedSummary = "0 incremental directory(ies)"
    } else {
        $targetBeforeBytes = Get-DirectorySize -Path $targetRoot
        Write-Host ("Current target size: {0}" -f (Format-ByteSize -Bytes $targetBeforeBytes))

        # Find all incremental directories under target
        $targetFullRoot = [System.IO.Path]::GetFullPath($targetRoot)
        $incrementalDirs = Get-ChildItem -LiteralPath $targetFullRoot -Recurse -Force -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq 'incremental' }

        $dirsToClean = @()
        $totalIncrementalBytes = 0L

        foreach ($dir in $incrementalDirs) {
            $validatedPath = Assert-PathIsInsideTarget -PathToValidate $dir.FullName -TargetRootPath $targetFullRoot
            $dirSize = Get-DirectorySize -Path $validatedPath
            $totalIncrementalBytes += $dirSize
            $dirsToClean += [PSCustomObject]@{
                Path = $validatedPath
                Size = $dirSize
            }
        }

        if ($dirsToClean.Count -eq 0) {
            Write-Host "No incremental cache directories found in $targetRoot." -ForegroundColor Green
            $removedSummary = "0 incremental directory(ies)"
            $freedBytes = 0L
            $targetAfterBytes = $targetBeforeBytes
        } else {
            Write-Host ("Found {0} incremental cache directory(ies) to clean ({1}):" -f $dirsToClean.Count, (Format-ByteSize -Bytes $totalIncrementalBytes))
            foreach ($item in $dirsToClean) {
                Write-Host ("  - {0} [{1}]" -f $item.Path, (Format-ByteSize -Bytes $item.Size))
            }

            if ($DryRun) {
                Write-Host ""
                Write-Host "[DryRun] No files were deleted." -ForegroundColor Yellow
                $removedSummary = ("{0} incremental directory(ies) (dry run)" -f $dirsToClean.Count)
                $freedBytes = $totalIncrementalBytes
                $targetAfterBytes = [Math]::Max(0L, ($targetBeforeBytes - $freedBytes))
            } else {
                Assert-NoActiveBuildProcesses

                Write-Host ""
                Write-Host "Removing incremental cache directories..." -ForegroundColor Cyan
                $removedCount = 0
                foreach ($item in $dirsToClean) {
                    $safePath = Assert-PathIsInsideTarget -PathToValidate $item.Path -TargetRootPath $targetFullRoot
                    if ((Split-Path -Leaf $safePath) -ne 'incremental') {
                        throw "Safety check violation: '$safePath' is not an incremental directory!"
                    }
                    if (Test-Path -LiteralPath $safePath) {
                        Remove-Item -LiteralPath $safePath -Recurse -Force -ErrorAction Stop
                        $removedCount++
                    }
                }

                $targetAfterBytes = Get-DirectorySize -Path $targetRoot
                $freedBytes = [Math]::Max(0L, ($targetBeforeBytes - $targetAfterBytes))
                $removedSummary = ("{0} incremental directory(ies)" -f $removedCount)
                Write-Host "Cleanup completed." -ForegroundColor Green
            }
        }
    }
} else {
    $modeName = if ($DryRun) { "Full (DryRun)" } else { "Full" }
    Write-Host "=== Rust Dev Cache Clean [$modeName] ===" -ForegroundColor Cyan
    Write-Host "WARNING: Full mode will remove all target artifacts including current Debug binaries (qqmusic-gui.exe, qqmusic-tui.exe)." -ForegroundColor Yellow

    Assert-NoActiveBuildProcesses

    if (-not (Test-Path -LiteralPath $targetRoot)) {
        Write-Host "Target directory not found: $targetRoot (already clean)." -ForegroundColor Yellow
        $targetBeforeBytes = 0L
        $targetAfterBytes = 0L
        $freedBytes = 0L
        $removedSummary = "Target already clean"
    } else {
        $targetBeforeBytes = Get-DirectorySize -Path $targetRoot
        Write-Host ("Current target size: {0}" -f (Format-ByteSize -Bytes $targetBeforeBytes))

        if ($DryRun) {
            Write-Host ""
            Write-Host "[DryRun] Would execute: cargo clean --manifest-path $cargoManifestPath" -ForegroundColor Yellow
            Write-Host "[DryRun] Would delete target directory and all built artifacts." -ForegroundColor Yellow
            $removedSummary = "Full target directory (dry run)"
            $freedBytes = $targetBeforeBytes
            $targetAfterBytes = 0L
        } else {
            Write-Host ""
            Write-Host "Executing: cargo clean --manifest-path $cargoManifestPath" -ForegroundColor Cyan
            & cargo clean --manifest-path $cargoManifestPath
            if ($LASTEXITCODE -ne 0) {
                throw "cargo clean failed with exit code $LASTEXITCODE"
            }

            $targetAfterBytes = if (Test-Path -LiteralPath $targetRoot) { Get-DirectorySize -Path $targetRoot } else { 0L }
            $freedBytes = [Math]::Max(0L, ($targetBeforeBytes - $targetAfterBytes))
            $removedSummary = "Full target directory (cargo clean)"
            Write-Host "Full clean completed." -ForegroundColor Green
        }
    }
}

# 3. Final summary report
$guiExists = Test-Path -LiteralPath $debugGuiPath
$tuiExists = Test-Path -LiteralPath $debugTuiPath

Write-Host ""
Write-Host "Mode: $modeName"
Write-Host ("Target before: {0}" -f (Format-ByteSize -Bytes $targetBeforeBytes))
Write-Host ("Removed: {0}" -f $removedSummary)
Write-Host ("Freed: {0}" -f (Format-ByteSize -Bytes $freedBytes))
Write-Host ("Target after: {0}" -f (Format-ByteSize -Bytes $targetAfterBytes))
Write-Host ("Debug GUI exists: {0}" -f $guiExists)
Write-Host ("Debug TUI exists: {0}" -f $tuiExists)
