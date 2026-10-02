<#
.SYNOPSIS
  Builds a Wafi X release and signs the updater artifacts.

.DESCRIPTION
  `tauri.conf.json` sets bundle.createUpdaterArtifacts, so every release build
  must produce a signed latest.json (plus .sig) for the Tauri updater. Tauri
  reads the private key from TAURI_SIGNING_PRIVATE_KEY, and refuses to sign at
  all when that variable is unset - which is the current state of this machine:
  the failure is

      A public key has been found, but no private key.
      Make sure to set TAURI_SIGNING_PRIVATE_KEY environment variable.

  This script is the supported way to run a signed release build.

  The private key never lives in this repository. It is read from one of:

    - a file path given to -KeyFile, which should be outside the working tree
    - the TAURI_SIGNING_PRIVATE_KEY environment variable (key text or a path)

  ...and it is refused outright if the path is inside the repository, because a
  public repository plus a committed signing key is a permanently compromised
  updater that no amount of later rotation repairs for users who already
  installed a malicious build.

  The key must also match `plugins.updater.pubkey` in src-tauri/tauri.conf.json.
  That is checked here rather than trusted: signing with the wrong key produces
  artifacts that every installed client rejects, and the failure only shows up
  on other people's machines. The check compares minisign key IDs, which are
  derived from the public key, so a mismatch means a genuinely different key.

  Changing the pubkey is out of scope: the shipped clients trust the committed
  one, and update_identity.rs pins the artifact filenames the signature covers.
  A new key is a deliberate migration, not a side effect of running a build.

.PARAMETER KeyFile
  Path to the minisign private key. Keep it outside this repository.

.PARAMETER Password
  Private key password. Prefer TAURI_SIGNING_PRIVATE_KEY_PASSWORD in the
  environment over passing it here: this process's command line is readable by
  other processes on the machine.

.PARAMETER DryRun
  Resolve and verify the key, print what would run, and stop.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/build-signed.ps1 -DryRun

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/build-signed.ps1 `
    -KeyFile D:\keys\wafix-updater.key
#>
[CmdletBinding()]
param(
  [string]$KeyFile,
  [string]$Password,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot/..").Path

function Get-PubkeyIdFromConfig {
  $confPath = Join-Path $repo 'src-tauri/tauri.conf.json'
  $conf = Get-Content $confPath -Raw | ConvertFrom-Json
  if (-not $conf.plugins -or -not $conf.plugins.updater -or -not $conf.plugins.updater.pubkey) {
    throw "No plugins.updater.pubkey in $confPath. Without it the updater trusts nothing and signing is pointless."
  }
  $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($conf.plugins.updater.pubkey))
  # First line is: untrusted comment: minisign public key: <KEYID>
  if ($decoded -notmatch 'minisign public key:\s*([0-9A-Fa-f]+)') {
    throw 'plugins.updater.pubkey does not look like a minisign public key.'
  }
  return @($Matches[1], $decoded)
}

function Get-PrivateKeyId {
  param([string[]]$Lines)

  # A minisign secret key is four lines: comment, base64 payload, checksum and
  # the global signature. The key ID is the last 8 bytes of the decoded payload,
  # i.e. bytes 64..72.
  if ($Lines.Count -lt 2) {
    throw 'That does not look like a minisign private key: fewer than two lines.'
  }
  $comment = $Lines[0].Trim()
  if ($comment -notmatch 'minisign (encrypted )?secret key') {
    throw "Line 1 of a minisign private key carries the comment 'minisign secret key' or 'minisign encrypted secret key'. Found: $comment"
  }
  $payload = $Lines[1].Trim()
  if ($payload -notmatch '^[A-Za-z0-9+/=]+$') {
    throw "Line 2 of the private key is not base64. Found: $payload"
  }
  $bytes = $null
  try { $bytes = [Convert]::FromBase64String($payload) } catch { throw 'Line 2 of the private key is not valid base64.' }
  if ($bytes.Length -lt 72) {
    throw "Private key payload is $($bytes.Length) bytes; a minisign secret key needs at least 72."
  }
  $id = ($bytes[64..71] | ForEach-Object { $_.ToString('X2') }) -join ''
  return $id
}

# ---------------------------------------------------------------------------
# 1. Resolve the key from outside the repository.
# ---------------------------------------------------------------------------

if (-not $KeyFile) {
  $fromEnv = $env:TAURI_SIGNING_PRIVATE_KEY
  if ([string]::IsNullOrWhiteSpace($fromEnv)) {
    throw @"
TAURI_SIGNING_PRIVATE_KEY is not set, and -KeyFile was not given.

There is no private key in this repository and there should not be one. Keep the
minisign key outside the working tree and point at it:

  powershell -ExecutionPolicy Bypass -File scripts/build-signed.ps1 -KeyFile <path>

To check the setup without building anything, add -DryRun.
"@
  }
  # Tauri accepts either the key text or a path here, so handle both.
  if ($fromEnv -match '^\s*(untrusted comment|RWY)' -or $fromEnv -match "`n") {
    Write-Host 'Key read from TAURI_SIGNING_PRIVATE_KEY (inline text).'
    $keyText = $fromEnv
  }
  else {
    $KeyFile = $fromEnv
    if (-not (Test-Path $KeyFile)) {
      throw "TAURI_SIGNING_PRIVATE_KEY looks like a path but the file does not exist: $KeyFile"
    }
    $keyText = Get-Content $KeyFile -Raw
  }
}
else {
  if (-not (Test-Path $KeyFile)) { throw "Key file not found: $KeyFile" }
  $resolved = (Resolve-Path $KeyFile).Path
  $KeyFile = $resolved
  $keyText = Get-Content $KeyFile -Raw

  # A key inside the repository would be caught by .gitignore on commit, but it
  # still has no business being read from here.
  $repoPrefix = $repo.TrimEnd('\') + '\'
  if ($resolved.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw @"
The private key is inside this repository:

  $resolved

Move it out first. A signing key that lives next to the source is a key that will
eventually be committed, and this repository is public.
"@
  }
}

# ---------------------------------------------------------------------------
# 2. Prove the key is the one the shipped clients trust.
# ---------------------------------------------------------------------------

$configId, $pubkeyText = Get-PubkeyIdFromConfig
$keyId = Get-PrivateKeyId -Lines ($keyText -split "`r?`n")

Write-Host ''
Write-Host 'Updater signing key'
Write-Host ("  committed pubkey id : {0}" -f $configId)
Write-Host ("  private key id      : {0}" -f $keyId)

if ($keyId -ne $configId) {
  throw @"
These do not match.

Signing with this key would produce a latest.json that every installed client
rejects, because update_identity.rs and plugins.updater.pubkey pin the key that
was shipped with the app. The failure would only appear on user machines.

The committed pubkey is part of the app's updater identity, so it is not changed
here. Either point -KeyFile at the key that matches it, or treat rotating to a
new key as its own deliberate change.
"@
}
Write-Host '  match               : yes'

if ($DryRun) {
  Write-Host ''
  Write-Host '-DryRun: key resolved and verified. Not building.'
  exit 0
}

# ---------------------------------------------------------------------------
# 3. Build.
# ---------------------------------------------------------------------------

# Tauri reads both variables; set them for this process and its children only, so
# nothing lands in a shell profile or a checked-in file.
$env:TAURI_SIGNING_PRIVATE_KEY = $keyText
if ($Password) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $Password }

Write-Host ''
Write-Host 'Building signed release artifacts...'
Write-Host ''

Push-Location $repo
try {
  & npm.cmd run tauri build
  $code = $LASTEXITCODE
}
finally {
  # Do not leave the key in the environment of this shell either.
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
  Pop-Location
}

if ($code -ne 0) {
  throw "`npm run tauri build` failed with exit code $code."
}

Write-Host ''
Write-Host 'Build finished. Verify before publishing:'
Write-Host '  scripts/verify-installers.ps1 -Path src-tauri/target/release/bundle'
Write-Host '  node scripts/make-latest-json.mjs <release-notes.md>'
Write-Host 'See RELEASING.md for the rest of the sequence.'