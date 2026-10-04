$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('qq-debug-lock-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts') -Force | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'debug-review.ps1') (Join-Path $fixture 'scripts/debug-review.ps1')
$script = Join-Path $fixture 'scripts/debug-review.ps1'
function Assert-Rejected([scriptblock]$Command) {
    $rejected=$false
    try { & $Command | Out-Null } catch { $rejected=$true }
    if (-not $rejected) { throw 'Expected rejection.' }
}
try {
    & $script -Action Status | Out-Null
    if (Test-Path (Join-Path $fixture '.workflow')) { throw 'Status wrote state.' }
    # Missing CLI produces failure; ordinary Run must not leave a reservation.
    Assert-Rejected { & $script }
    if ((& $script -Action Status) -ne 'Debug review: none') { throw 'Run leaked a lock.' }
    & $script -Action Hold -Owner 'test'
    Assert-Rejected { & $script -Action Hold -Owner 'other' }
    Assert-Rejected { & $script -Action Release -Owner 'other' }
    Assert-Rejected { & $script -Action Run -Owner 'other' }
    $guard=[IO.File]::Open((Join-Path $fixture '.workflow/debug-review.guard'),'Open','ReadWrite','None')
    try {
        Assert-Rejected { & $script -Action Run -Owner 'test' }
        if ((& $script -Action Status) -notmatch 'running') { throw 'Status failed during Run.' }
    } finally { $guard.Dispose() }
    Assert-Rejected { & $script -Action Run -Owner 'test' }
    if (-not (Test-Path (Join-Path $fixture '.workflow/debug-review.json'))) { throw 'Explicit hold lost.' }
    & $script -Action Release -Owner 'test'
    if ((& $script -Action Status) -ne 'Debug review: none') { throw 'Release failed.' }
    Write-Output 'PASS: read-only status, failure release, owner isolation, concurrent rejection, explicit hold.'
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if (-not $resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'qq-debug-lock-test-*') { throw 'Unsafe fixture path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
