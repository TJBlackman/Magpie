# Ships a new version of Magpie: typecheck and unit tests, version bump, both
# browser builds, Mozilla signing for Firefox, and a deploy of magpie.trevorblackman.dev.
# Needs the AMO key stored once with `pnpm amo:key`.
#
#   pnpm release                  # 0.2.1 -> 0.2.2
#   pnpm release -Bump minor      # 0.2.1 -> 0.3.0
#   pnpm release -Version 0.2.2   # exact version, e.g. to rerun one that failed before signing
param([string]$Version, [ValidateSet("patch", "minor", "major")][string]$Bump = "patch")
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
$root = Split-Path $PSScriptRoot -Parent
$pkgPath = Join-Path $root "extension\package.json"

Push-Location $root
try {
  pnpm typecheck
  pnpm test:unit

  $pkg = Get-Content $pkgPath -Raw
  $current = ($pkg | ConvertFrom-Json).version
  if (-not $Version) {
    $v = [version]$current
    $Version = switch ($Bump) {
      "patch" { "$($v.Major).$($v.Minor).$($v.Build + 1)" }
      "minor" { "$($v.Major).$($v.Minor + 1).0" }
      "major" { "$($v.Major + 1).0.0" }
    }
  }
  if ($Version -ne $current) {
    Set-Content $pkgPath ($pkg -replace '"version": "[^"]+"', "`"version`": `"$Version`"") -NoNewline
  }
  Write-Host "Releasing $Version (was $current)"

  pnpm --dir extension zip
  pnpm --dir extension zip:firefox
  # The same checks AMO runs on upload; a warning stops the release here instead.
  pnpm --dir extension exec web-ext lint --source-dir dist/firefox-mv2 --warnings-as-errors
  pnpm --dir extension sign:firefox
  pnpm site:deploy
} finally { Pop-Location }

Write-Host "Released $Version. Commit extension/package.json, website/site/index.html and website/site/version.json."
