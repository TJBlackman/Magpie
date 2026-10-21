# Has Mozilla sign the Firefox build so it installs permanently, and saves it as
# dist/magpie-extension-<version>-firefox.xpi. The channel is unlisted: AMO signs
# it automatically and never publishes it.
#
# The AMO API key lives in Windows Credential Manager under "magpie/addons.mozilla.org",
# encrypted to this Windows account. It only reaches web-ext through environment
# variables of this one process. Nothing secret goes to disk, the repo, or the command line.
#
#   pnpm amo:key                       # once: prompt for the key, store it, test it
#   pnpm sign:firefox                  # after pnpm zip:firefox (pnpm release does both)
#   .\sign-firefox.ps1 -Check          # test the stored key against AMO
#   .\sign-firefox.ps1 -Forget         # delete the stored key
param([switch]$SaveKey, [switch]$Check, [switch]$Forget)
$ErrorActionPreference = "Stop"
$target = "magpie/addons.mozilla.org"

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class CredMan {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  const int Generic = 1, PersistLocalMachine = 2;

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr cred);

  // Returns { user, secret }, or null when nothing is stored under target.
  public static string[] Read(string target) {
    IntPtr p;
    if (!CredRead(target, Generic, 0, out p)) return null;
    try {
      var c = Marshal.PtrToStructure<CREDENTIAL>(p);
      return new[] { c.UserName, Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2) };
    } finally { CredFree(p); }
  }

  public static void Write(string target, string user, string secret) {
    var bytes = Encoding.Unicode.GetBytes(secret);
    var c = new CREDENTIAL { Type = Generic, TargetName = target, UserName = user,
      CredentialBlobSize = bytes.Length, Persist = PersistLocalMachine };
    c.CredentialBlob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
      if (!CredWrite(ref c, 0)) throw new Win32Exception();
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }

  public static bool Delete(string target) { return CredDelete(target, Generic, 0); }
}
"@

# AMO auth header from a JWT that lives 60 seconds. iat and exp come from one clock
# reading: AMO rejects exp - iat > 300, and web-ext 10.8.0 reads the clock twice for a
# 300 second token, so now and then one of its requests goes out at 301 and fails.
function New-AmoAuth {
  $utf8 = [Text.Encoding]::UTF8
  $b64 = { param($bytes) [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_") }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $claims = @{ iss = $issuer; jti = [guid]::NewGuid().ToString(); iat = $now; exp = $now + 60 } | ConvertTo-Json -Compress
  $unsigned = (& $b64 $utf8.GetBytes('{"alg":"HS256","typ":"JWT"}')) + "." + (& $b64 $utf8.GetBytes($claims))
  $sig = & $b64 ([Security.Cryptography.HMACSHA256]::new($utf8.GetBytes($secret)).ComputeHash($utf8.GetBytes($unsigned)))
  @{ Authorization = "JWT $unsigned.$sig" }
}

function Test-AmoKey {
  try {
    $me = Invoke-RestMethod "https://addons.mozilla.org/api/v5/accounts/profile/" -Headers (New-AmoAuth)
  } catch {
    throw "AMO rejected the stored key: $($_.ErrorDetails.Message ?? $_.Exception.Message). Run pnpm amo:key again."
  }
  if ($me.name) { $me.name } else { $me.username }
}

if ($Forget) {
  if ([CredMan]::Delete($target)) { Write-Host "Removed $target from Windows Credential Manager." }
  else { Write-Host "Nothing stored under $target." }
  exit 0
}

if ($SaveKey) {
  Write-Host "Paste the values from https://addons.mozilla.org/developers/addon/api/key/"
  $issuer = (Read-Host "JWT issuer").Trim()
  if ($issuer -notmatch "^user:\d+:\d+$") { throw "The JWT issuer looks like user:12345:678. Got something else, nothing stored." }
  $secret = [Net.NetworkCredential]::new("", (Read-Host "JWT secret" -AsSecureString)).Password.Trim()
  if (-not $secret) { throw "Empty JWT secret, nothing stored." }
  [CredMan]::Write($target, $issuer, $secret)
  Write-Host "Stored in Windows Credential Manager as $target."
}

$cred = [CredMan]::Read($target)
if (-not $cred) { throw "No AMO key in Windows Credential Manager. Run: pnpm amo:key" }
$issuer, $secret = $cred

if ($SaveKey -or $Check) {
  Write-Host "Key works. AMO account: $(Test-AmoKey)"
  exit 0
}

$ext = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $ext "dist"
$src = Join-Path $dist "firefox-mv2"
$version = (Get-Content (Join-Path $ext "package.json") -Raw | ConvertFrom-Json).version
$built = (Get-Content (Join-Path $src "manifest.json") -Raw | ConvertFrom-Json).version
if ($built -ne $version) { throw "dist/firefox-mv2 is $built but package.json is $version. Run: pnpm zip:firefox" }
# AMO keeps the readable source next to the bundled build in case a reviewer asks for it.
$sources = Join-Path $dist "magpie-extension-$version-sources.zip"
if (-not (Test-Path $sources)) { throw "Missing $sources. Run: pnpm zip:firefox" }

$guid = (Get-Content (Join-Path $src "manifest.json") -Raw | ConvertFrom-Json).browser_specific_settings.gecko.id
$amoVersion = "https://addons.mozilla.org/api/v5/addons/addon/$guid/versions/v$version/"
function Get-AmoVersion {
  try { Invoke-RestMethod $amoVersion -Headers (New-AmoAuth) }
  catch { if ($_.Exception.Response.StatusCode -eq 404) { $null } else { throw } }
}

# web-ext only uploads and creates the version, which keeps its own requests few.
# Waiting for approval and the download happen below with our own auth. If AMO already
# has this version (a rerun after a failure), skip the upload and pick that one up.
if (-not (Get-AmoVersion)) {
  $out = Join-Path $dist "amo-upload"
  $env:WEB_EXT_API_KEY = $issuer
  $env:WEB_EXT_API_SECRET = $secret
  Push-Location $ext
  try {
    pnpm exec web-ext sign --channel=unlisted --source-dir $src --artifacts-dir $out --upload-source-code $sources --approval-timeout 0
    $uploadFailed = $LASTEXITCODE
  } finally {
    Pop-Location
    Remove-Item Env:WEB_EXT_API_KEY, Env:WEB_EXT_API_SECRET
    if (Test-Path $out) { Remove-Item $out -Recurse -Force -Confirm:$false }
  }
}

$v = Get-AmoVersion
if (-not $v) { throw "web-ext sign failed before AMO created $version. Nothing was used up; rerun pnpm sign:firefox." }
if ($uploadFailed) { Write-Host "web-ext reported an error, but AMO has $version. Continuing." }

$deadline = (Get-Date).AddMinutes(30)
while ($v.file.status -ne "public") {
  if ($v.file.status -eq "disabled") { throw "AMO rejected $version. Details: https://addons.mozilla.org/developers/addon/$guid/versions" }
  if ((Get-Date) -gt $deadline) { throw "AMO has not signed $version after 30 minutes. Rerun pnpm sign:firefox later to pick it up." }
  Write-Host "Waiting for AMO to sign $version (status: $($v.file.status))"
  Start-Sleep -Seconds 15
  $v = Get-AmoVersion
}

$final = Join-Path $dist "magpie-extension-$version-firefox.xpi"
Invoke-WebRequest $v.file.url -Headers (New-AmoAuth) -OutFile $final
$hash = "sha256:" + (Get-FileHash $final -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $v.file.hash) { Remove-Item $final; throw "Downloaded file does not match the hash AMO reported." }
Write-Host "Signed: $final"
