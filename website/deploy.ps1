# Publishes https://magpie.trevorblackman.dev (Cloudflare Worker static assets).
# Copies the Chrome zip and the signed Firefox xpi into site/, points index.html
# at them, writes version.json (read by the extension's update check), removes
# files from older versions, and runs wrangler deploy.
#
# Usually run by `pnpm release`. By hand, after the zips and `pnpm sign:firefox`:
#   .\website\deploy.ps1                 # version from extension/package.json
#   .\website\deploy.ps1 -Version 0.2.2  # or an explicit one
param([string]$Version)
$ErrorActionPreference = "Stop"
$site = Join-Path $PSScriptRoot "site"
$ext = Join-Path (Split-Path $PSScriptRoot -Parent) "extension"
if (-not $Version) { $Version = (Get-Content (Join-Path $ext "package.json") -Raw | ConvertFrom-Json).version }

$dist = Join-Path $ext "dist"
foreach ($file in "chrome.zip", "firefox.xpi") {
  $src = Join-Path $dist "magpie-extension-$Version-$file"
  if (-not (Test-Path $src)) { throw "Missing $src. Run: pnpm release" }
  Copy-Item $src (Join-Path $site "magpie-$Version-$file") -Force
}
Get-ChildItem $site -File | Where-Object { $_.Name -match '^magpie-.*\.(zip|xpi)$' -and $_.Name -notlike "magpie-$Version-*" } | Remove-Item -Confirm:$false
Copy-Item (Join-Path $ext "public\icon\128.png") (Join-Path $site "icon.png") -Force

$index = Join-Path $site "index.html"
$html = Get-Content $index -Raw
$html = $html -replace 'magpie-\d+\.\d+\.\d+-chrome\.zip', "magpie-$Version-chrome.zip"
$html = $html -replace 'magpie-\d+\.\d+\.\d+-firefox\.(zip|xpi)', "magpie-$Version-firefox.xpi"
$html = $html -replace 'v<b>\d+\.\d+\.\d+</b>', "v<b>$Version</b>"
Set-Content $index $html -NoNewline
Set-Content (Join-Path $site "version.json") (@{ version = $Version } | ConvertTo-Json -Compress) -NoNewline

Push-Location $PSScriptRoot
try { wrangler deploy } finally { Pop-Location }

# Firefox installs an xpi on click only when it is served as application/x-xpinstall.
$type = "$((Invoke-WebRequest "https://magpie.trevorblackman.dev/magpie-$Version-firefox.xpi" -Method Head).Headers['Content-Type'])"
if ($type -notmatch "x-xpinstall") { Write-Warning "The xpi is served as '$type'. Firefox will download it instead of offering to install." }
