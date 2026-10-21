# Publishes https://magpie.trevorblackman.dev (Cloudflare Worker static assets).
# Copies the built extension zips into site/, points index.html at them,
# removes zips from older versions, and runs wrangler deploy.
#
# Usage, from anywhere:
#   pnpm --dir extension zip; pnpm --dir extension zip:firefox
#   .\website\deploy.ps1                 # version from extension/package.json
#   .\website\deploy.ps1 -Version 0.2.1  # or an explicit one
param([string]$Version)
$ErrorActionPreference = "Stop"
$site = Join-Path $PSScriptRoot "site"
$ext = Join-Path (Split-Path $PSScriptRoot -Parent) "extension"
if (-not $Version) { $Version = (Get-Content (Join-Path $ext "package.json") -Raw | ConvertFrom-Json).version }

$dist = Join-Path $ext "dist"
foreach ($b in "chrome", "firefox") {
  $src = Join-Path $dist "magpie-extension-$Version-$b.zip"
  if (-not (Test-Path $src)) { throw "Missing $src. Run: pnpm --dir extension zip; pnpm --dir extension zip:firefox" }
  Copy-Item $src (Join-Path $site "magpie-$Version-$b.zip") -Force
}
Get-ChildItem $site -Filter "magpie-*.zip" | Where-Object { $_.Name -notlike "magpie-$Version-*" } | Remove-Item -Confirm:$false
Copy-Item (Join-Path $ext "public\icon\128.png") (Join-Path $site "icon.png") -Force

$index = Join-Path $site "index.html"
$html = Get-Content $index -Raw
$html = $html -replace 'magpie-\d+\.\d+\.\d+-(chrome|firefox)\.zip', "magpie-$Version-`$1.zip"
$html = $html -replace 'v<b>\d+\.\d+\.\d+</b>', "v<b>$Version</b>"
Set-Content $index $html -NoNewline

Push-Location $PSScriptRoot
try { wrangler deploy } finally { Pop-Location }
