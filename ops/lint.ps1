<#
.SYNOPSIS
    Lints src/, tests/ and ops/ with ops/eslint.config.mjs: full JSDoc coverage, JSDoc as the only comments, one
    export per module, complexity and nesting limits and descriptive names. ESLint and its JSDoc
    plugin are installed into ops/node_modules on first use. Requires PowerShell 7 and Node.js.
#>
param(
    [string]$EslintVersion = "10.11.0",
    [string]$JsdocPluginVersion = "64.5.4"
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$toolModules = Join-Path $PSScriptRoot "node_modules"

if (-not (Test-Path (Join-Path $toolModules "eslint-plugin-jsdoc"))) {
    Write-Host "Installing eslint@$EslintVersion and eslint-plugin-jsdoc@$JsdocPluginVersion into ops/node_modules ..."
    npm install --prefix $PSScriptRoot --no-save --no-package-lock "eslint@$EslintVersion" "eslint-plugin-jsdoc@$JsdocPluginVersion"
    if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed with exit code $LASTEXITCODE"; exit 1 }
}

Push-Location $repositoryRoot
try {
    node (Join-Path $toolModules "eslint/bin/eslint.js") --config (Join-Path $PSScriptRoot "eslint.config.mjs") src tests ops
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
