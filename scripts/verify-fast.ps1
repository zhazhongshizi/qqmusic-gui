[CmdletBinding()]
param(
    [ValidateSet('All','Frontend','Rust','Provider')][string]$Scope = 'All',
    [switch]$IncludeRustDefaultFeatures
)
$ErrorActionPreference = 'Stop'
if ($IncludeRustDefaultFeatures -and $Scope -notin @('All','Rust')) {
    throw 'IncludeRustDefaultFeatures requires Scope Rust or All.'
}
$repositoryRoot = Split-Path -Parent $PSScriptRoot
function Invoke-Checked([string]$Label, [scriptblock]$Command) {
    Write-Host "[$Label]"
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}
Push-Location $repositoryRoot
try {
    if ($Scope -in @('All','Frontend')) {
        $binRoot = Join-Path $repositoryRoot 'node_modules/.bin'
        foreach ($name in @('tsc','vitest','vite')) {
            if (-not (Test-Path (Join-Path $binRoot "$name.CMD"))) { throw "Local $name missing. Run pnpm install first." }
        }
        Invoke-Checked 'Frontend types' { & (Join-Path $binRoot 'tsc.CMD') -b --pretty false }
        Invoke-Checked 'E2E types' { & (Join-Path $binRoot 'tsc.CMD') -p tsconfig.e2e.json --pretty false }
        Invoke-Checked 'Frontend tests' { & (Join-Path $binRoot 'vitest.CMD') run --maxWorkers=1 }
        Invoke-Checked 'Frontend build' { & (Join-Path $binRoot 'vite.CMD') build }
        Invoke-Checked 'Remote WebUI build' { & (Join-Path $binRoot 'vite.CMD') build --config vite.remote.config.ts }
    }
    if ($Scope -in @('All','Rust')) {
        if ($Scope -eq 'Rust') {
            Invoke-Checked 'Frontend resources for Rust' { & (Join-Path $PSScriptRoot 'build-frontend.ps1') }
        }
        Invoke-Checked 'Rust format' { cargo fmt --manifest-path src-tauri/Cargo.toml -- --check }
        Invoke-Checked 'Rust clippy (all features)' { cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings }
        Invoke-Checked 'Rust tests (all features)' { cargo test --manifest-path src-tauri/Cargo.toml --all-features --locked }
        if ($IncludeRustDefaultFeatures) {
            Invoke-Checked 'Rust check (default features)' { cargo check --manifest-path src-tauri/Cargo.toml --all-targets --locked }
            Invoke-Checked 'Rust tests (default features)' { cargo test --manifest-path src-tauri/Cargo.toml --locked }
        }
    }
    if ($Scope -in @('All','Provider')) {
        $python = Join-Path $repositoryRoot 'provider/.venv/Scripts/python.exe'
        if (-not (Test-Path $python)) { throw 'Provider venv missing. Run scripts/bootstrap-provider.ps1 first.' }
        Invoke-Checked 'Provider lint' { & $python -m ruff check --no-cache provider }
        Invoke-Checked 'Provider types' { & $python -m mypy provider/qqmusic_provider }
        Invoke-Checked 'Provider tests' { & $python -m pytest provider/tests }
    }
} finally { Pop-Location }
