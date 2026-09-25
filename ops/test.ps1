<#
.SYNOPSIS
    Runs the smoke tests in tests/smoke against build/dev/ClaudePlus.js and build/prod/ClaudePlus.js
    in headless Chromium, with claude.ai and its API mocked. Playwright and its Chromium are
    installed into ops/node_modules on first use. Build first with ops/build.ps1. Requires
    PowerShell 7 and Node.js.
#>
param(
    [string]$PlaywrightVersion = "1.56.1"
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$toolModules = Join-Path $PSScriptRoot "node_modules"

if (-not (Test-Path (Join-Path $toolModules "playwright"))) {
    Write-Host "Installing playwright@$PlaywrightVersion and Chromium into ops/node_modules ..."
    npm install --prefix $PSScriptRoot --no-save --no-package-lock "playwright@$PlaywrightVersion"
    if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed with exit code $LASTEXITCODE"; exit 1 }
    node (Join-Path $toolModules "playwright/cli.js") install chromium
    if ($LASTEXITCODE -ne 0) { Write-Error "installing Chromium failed with exit code $LASTEXITCODE"; exit 1 }
}

$env:NODE_PATH = $toolModules
$failedBuilds = 0
Push-Location $repositoryRoot
try {
    foreach ($build in "dev", "prod") {
        node (Join-Path $repositoryRoot "tests/smoke/smoke.cjs") (Join-Path $repositoryRoot "build/$build/ClaudePlus.js")
        if ($LASTEXITCODE -ne 0) { $failedBuilds += 1 }
    }
}
finally {
    Pop-Location
}

if ($failedBuilds -gt 0) { Write-Error "smoke tests failed for $failedBuilds build(s)"; exit 1 }
Write-Host "Smoke tests passed for the dev and prod builds."
