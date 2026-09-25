<#
.SYNOPSIS
    Builds ClaudePlus_prod.js: a minified, comment-stripped copy of ClaudePlus.js for injection/distribution.
#>
param(
    [string]$InputFile = "ClaudePlus.js",
    [string]$OutputFile = "ClaudePlus_prod.js"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$inputPath = Join-Path $scriptDir $InputFile
$outputPath = Join-Path $scriptDir $OutputFile

if (-not (Test-Path $inputPath)) {
    Write-Error "Input file not found: $inputPath"
    exit 1
}

Write-Host "Minifying $InputFile -> $OutputFile ..."

# Tampermonkey requires the // ==UserScript== ... // ==/UserScript== metadata block to be present
# verbatim to recognize and install the script -- terser's --comments false strips ALL comments,
# including that block, leaving a file Tampermonkey can no longer read. So: pull the header out
# first, minify the rest with comments stripped, then stitch the header back on top.
$sourceText = Get-Content -Path $inputPath -Raw
$headerMatch = [regex]::Match($sourceText, '(?s)^\s*//\s*==UserScript==.*?//\s*==/UserScript==')
if (-not $headerMatch.Success) {
    Write-Error "Could not find a // ==UserScript== ... // ==/UserScript== header in $InputFile"
    exit 1
}
$header = $headerMatch.Value.Trim()

npx --yes terser $inputPath --compress --mangle --comments false -o $outputPath

if ($LASTEXITCODE -ne 0) {
    Write-Error "terser failed with exit code $LASTEXITCODE"
    exit 1
}

$minified = Get-Content -Path $outputPath -Raw
Set-Content -Path $outputPath -Value "$header`n$minified" -NoNewline

$inSize = (Get-Item $inputPath).Length
$outSize = (Get-Item $outputPath).Length
$pct = [math]::Round((1 - ($outSize / $inSize)) * 100, 1)
Write-Host "Done: $inSize bytes -> $outSize bytes ($pct% smaller)"
