<#
.SYNOPSIS
    Builds ClaudePlus from src/ into build/dev/ClaudePlus.js (readable, documented) and
    build/prod/ClaudePlus.js (minified, comment-free). Requires PowerShell 7 and Node.js.
#>
param(
    [string]$RollupVersion = "4.24.0",
    [string]$TerserVersion = "5.36.0"
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$devOutput = Join-Path $repositoryRoot "build/dev/ClaudePlus.js"
$prodOutput = Join-Path $repositoryRoot "build/prod/ClaudePlus.js"
$headerPath = Join-Path $repositoryRoot "src/header.js"

Write-Host "Building dev: src/ -> build/dev/ClaudePlus.js ..."
npx --yes "rollup@$RollupVersion" --config (Join-Path $PSScriptRoot "rollup.config.mjs")
if ($LASTEXITCODE -ne 0) { Write-Error "rollup failed with exit code $LASTEXITCODE"; exit 1 }

Write-Host "Building prod: build/dev -> build/prod/ClaudePlus.js ..."
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $prodOutput) | Out-Null
npx --yes "terser@$TerserVersion" $devOutput --compress --mangle --comments false -o $prodOutput
if ($LASTEXITCODE -ne 0) { Write-Error "terser failed with exit code $LASTEXITCODE"; exit 1 }

$header = (Get-Content -Path $headerPath -Raw).Trim()
$minified = Get-Content -Path $prodOutput -Raw
Set-Content -Path $prodOutput -Value "$header`n$minified" -NoNewline

$devSize = (Get-Item $devOutput).Length
$prodSize = (Get-Item $prodOutput).Length
Write-Host "Done: dev $devSize bytes, prod $prodSize bytes"
