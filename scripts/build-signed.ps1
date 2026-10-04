<#
.SYNOPSIS
  Builds a Wafi X release and signs the updater artifacts.

.DESCRIPTION
  `tauri.conf.json` sets bundle.createUpdaterArtifacts, so every release build
  must produce a signed latest.json (plus .sig) for the Tauri updater.

  The private key never lives in this repository. It is read from:

    - a file path given to -KeyFile
    - the TAURI_SIGNING_PRIVATE_KEY_PATH environment variable

  ...and it is refused outright if the path is inside the repository, because a
  public repository plus a committed signing key is a permanently compromised
  updater that no amount of later rotation repairs for users who already
  installed a malicious build.

  The key must also match `plugins.updater.pubkey` in src-tauri/tauri.conf.json,
  and this script proves it rather than trusting it. The proof is a signature:
  a throwaway probe is signed with the real Tauri signer using the local key,
  and the result is verified with Ed25519 against the committed public key.
  Signing with the wrong key produces artifacts every installed client rejects,
  and that failure only shows up on other people's machines.

  An earlier version of this check compared a key ID read from fixed byte
  offsets in the private key. That cannot work: `tauri signer generate` writes
  an encrypted rsign key whose payload is a scrypt-encrypted blob, so the key ID
  is not in the file to be read and no offset recovers it. It also only compared
  strings, which shows a resemblance rather than a relationship. Verifying a real
  signature holds for any key format and any encryption.

  Verification uses Tauri's own signer plus Node's built-in Ed25519. No minisign
  CLI is required.

  Nothing here prints the private key or its password, writes either to a file,
  or accepts either as a command-line argument.

.PARAMETER KeyFile
  Path to the minisign/rsign private key. Keep it outside this repository.

.PARAMETER Password
  Private key password. Required for an encrypted key. Prefer
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD in the environment over passing it here.
  Either way it reaches the signer through the environment, never through a
  command line that other processes on this machine can read.

.PARAMETER DryRun
  Verify the key, print what would run, and stop.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/build-signed.ps1 -DryRun

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/build-signed.ps1 `
    -KeyFile C:\Users\Wafi\.wafix\updater.key
#>
[CmdletBinding()]
param(
  [string]$KeyFile,
  [string]$Password,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path "$PSScriptRoot/..").Path

# `tauri signer sign` asks the terminal for a password whenever it has none,
# which in a build script means a release waits on a keyboard that is not there.
# Verified on tauri-cli 2.11.4: with no password anywhere it blocks indefinitely,
# even with stdin closed. Supplying one through the environment avoids the
# prompt entirely. Everything below goes through Invoke-TauriSigner so that can
# never happen by accident.
$script:SignerTimeoutSeconds = 180

function Get-KeyPath {
  param([string]$Explicit)

  if ($Explicit) { return $Explicit }

  $fromPath = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
  if (-not [string]::IsNullOrWhiteSpace($fromPath)) { return $fromPath }

  $fromKey = $env:TAURI_SIGNING_PRIVATE_KEY
  if (-not [string]::IsNullOrWhiteSpace($fromKey)) {
    if ($fromKey.Contains("`n") -or $fromKey.Contains("`r")) {
      throw @"
TAURI_SIGNING_PRIVATE_KEY holds key text rather than a path.

This script will not use it. The key would have to travel to the signer as a
command-line argument, where other processes on this machine can read it. Point
the script at the file instead:

  -KeyFile <path>
or
  set TAURI_SIGNING_PRIVATE_KEY_PATH=<path>
"@
    }
    return $fromKey
  }

  throw @"
No private key was given.

There is no private key in this repository and there should not be one. Keep the
minisign key outside the working tree and point at it:

  powershell -ExecutionPolicy Bypass -File scripts/build-signed.ps1 -KeyFile <path>

or set TAURI_SIGNING_PRIVATE_KEY_PATH. To check the setup without building
anything, add -DryRun.
"@
}

# Whether the key is encrypted, read without printing or decrypting anything.
# rsign writes the armored key wrapped in base64 on a single line, so unwrap it
# first; the header is a comment and carries no key material.
function Test-KeyIsEncrypted {
  param([string]$Path)

  $text = [System.IO.File]::ReadAllText($Path)
  if ($text.Contains('encrypted secret key')) { return $true }

  $trimmed = $text.Trim()
  if (-not $trimmed.Contains("`n") -and $trimmed -match '^[A-Za-z0-9+/]+={0,2}$') {
    try {
      $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($trimmed))
      return $decoded.Contains('encrypted secret key')
    } catch {
      return $false
    }
  }
  return $false
}

function Get-TauriCliScript {
  $cli = Join-Path $repo 'node_modules\@tauri-apps\cli\tauri.js'
  if (Test-Path $cli) { return $cli }
  throw @"
Could not find the Tauri CLI at

  $cli

Run `npm install` before building. The signer is invoked through node rather
than a .cmd shim so that the child process can be given an exact environment and
a hard timeout.
"@
}

function Invoke-TauriSigner {
  param(
    [string]$CliScript,
    [string]$KeyPath,
    [string]$ProbePath,
    [string]$Secret
  )

  $arguments = @($CliScript, 'signer', 'sign', '--private-key-path', $KeyPath)
  if ([string]::IsNullOrWhiteSpace($Secret)) {
    # An unencrypted key still needs a password argument, or the CLI blocks on
    # a terminal prompt. Empty, so there is nothing to expose.
    $arguments += @('--password', '')
  }
  $arguments += $ProbePath

  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $startInfo.FileName) { $startInfo.FileName = 'node' }
  $startInfo.Arguments = ($arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
  $startInfo.WorkingDirectory = $repo
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  # Inherit a clean slate: a stray key or password in this shell must not decide
  # which key a release gets signed with.
  foreach ($name in @('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD')) {
    $startInfo.EnvironmentVariables.Remove($name)
  }
  if (-not [string]::IsNullOrWhiteSpace($Secret)) {
    $startInfo.EnvironmentVariables['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] = $Secret
  }

  $process = [Diagnostics.Process]::Start($startInfo)
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()

  if (-not $process.WaitForExit($script:SignerTimeoutSeconds * 1000)) {
    try { $process.Kill() } catch { }
    throw @"
The Tauri signer did not finish within $script:SignerTimeoutSeconds seconds and was stopped.

It was signing the probe. No signature was produced and nothing was built.
"@
  }
  # Lets the redirected streams drain, which the timed overload does not do.
  $process.WaitForExit()

  foreach ($line in (($stdout.Result + "`n" + $stderr.Result) -split "`r?`n")) {
    if ($line.Trim()) { Write-Host "    $line" }
  }
  return $process.ExitCode
}

# The probe is a file, not a directory tree, so cleaning it up never walks a
# tree, never follows a link and cannot reach a sibling. The name and the parent
# are checked anyway, because a bug in deleting something in a temp directory is
# invisible by construction.
function Remove-ProbeFile {
  param([string]$Path, [string]$TempRoot, [string]$ExpectedName)

  if (-not (Test-Path -LiteralPath $Path)) { return }

  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing to remove $Path : it is not a plain file."
  }
  $full = [IO.Path]::GetFullPath($Path)
  $parent = [IO.Path]::GetDirectoryName($full).TrimEnd('\', '/')
  $root = [IO.Path]::GetFullPath($TempRoot).TrimEnd('\', '/')
  if (-not $parent.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove $full : it is not directly under the temporary root."
  }
  if ([IO.Path]::GetFileName($full) -cne $ExpectedName) {
    throw "Refusing to remove $full : unexpected file name."
  }
  Remove-Item -LiteralPath $full -Force
}

# ---------------------------------------------------------------------------
# 1. Resolve the key from outside the repository.
# ---------------------------------------------------------------------------

$keyPath = Get-KeyPath -Explicit $KeyFile
$repoPrefix = $repo.TrimEnd('\') + '\'

# Checked before the key is opened, and on the unresolved path, so that "this
# key must not live in this repository" is answered the same way whether or not
# the file turns out to be readable. Answering it second would let an unreadable
# path quietly take a different route past the one rule that cannot bend.
$candidate = [System.IO.Path]::GetFullPath($keyPath)
if ($candidate.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw @"
The private key is inside this repository:

  $candidate

Move it out first. A signing key that lives next to the source is a key that will
eventually be committed, and this repository is public.
"@
}

if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Key file not found: $candidate" }
$keyPath = (Resolve-Path -LiteralPath $candidate).Path

# ---------------------------------------------------------------------------
# 2. Prove the key is the one the shipped clients trust.
# ---------------------------------------------------------------------------

if (-not $Password) { $Password = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD }
$isEncrypted = Test-KeyIsEncrypted -Path $keyPath

if ($isEncrypted -and [string]::IsNullOrWhiteSpace($Password)) {
  throw @"
The private key at

  $keyPath

is encrypted, and no password was available. Without it the signer cannot read
the key, and skipping the check would skip the only thing this script exists to
prove.

Set the password in the environment rather than on the command line, which other
processes on this machine can read. For this session only:

  `$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<password>'

or persist it with:

  setx TAURI_SIGNING_PRIVATE_KEY_PASSWORD <password>

It is never printed, written to a file, or passed as an argument.
"@
}

$tempRoot = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath
$probeName = 'wafx-signer-' + [guid]::NewGuid().ToString() + '.bin'
$probePath = Join-Path $tempRoot $probeName
$signaturePath = $probePath + '.sig'

Write-Host ''
Write-Host 'Updater signing key'
Write-Host ("  key file             : {0}" -f $keyPath)
Write-Host  '  inside repository    : no'
Write-Host ("  encrypted            : {0}" -f $isEncrypted)
Write-Host ("  password available   : {0}" -f (-not [string]::IsNullOrWhiteSpace($Password)))
Write-Host ("  password via         : {0}" -f $(if ($Password) { 'environment' } else { 'none needed' }))

$probeBytes = New-Object byte[] 64
# RandomNumberGenerator.Create() rather than the static Fill, which does not
# exist on Windows PowerShell 5.1 - the version a user is most likely to run
# this from, and the one where a build script should not fall over.
$probeRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $probeRng.GetBytes($probeBytes) } finally { $probeRng.Dispose() }

try {
  [System.IO.File]::WriteAllBytes($probePath, $probeBytes)

  Write-Host ''
  Write-Host 'Signing a throwaway probe with the real Tauri signer...'
  $signExit = Invoke-TauriSigner -CliScript (Get-TauriCliScript) -KeyPath $keyPath -ProbePath $probePath -Secret $Password

  if ($signExit -ne 0) {
    throw "The Tauri signer exited with code $signExit. The key was not read; see its output above."
  }
  if (-not (Test-Path -LiteralPath $signaturePath)) {
    throw 'The Tauri signer reported success but produced no .sig file.'
  }

  # plugins.updater.pubkey is base64 of the armored minisign public key. The
  # probe's signature is checked against exactly that, so what is proved is the
  # pairing, not a resemblance between two key IDs.
  Write-Host ''
  Write-Host 'Verifying the signature against plugins.updater.pubkey'
  & node "$PSScriptRoot/verify-signing-key.mjs" --sig $signaturePath --payload $probePath 2>&1 |
    ForEach-Object { Write-Host "    $_" }
  $verifyExit = $LASTEXITCODE

  if ($verifyExit -ne 0) {
    throw @"
The private key and plugins.updater.pubkey do not match.

Signing with this key would produce a latest.json that every installed client
rejects, because the app verifies updates against the committed public key. The
failure would only appear on other people's machines.

Either point -KeyFile at the key that matches the committed public key, or treat
rotating to a new key as its own deliberate change.
"@
  }

  Write-Host ''
  Write-Host '  match                : yes'
}
finally {
  Remove-ProbeFile -Path $signaturePath -TempRoot $tempRoot -ExpectedName ($probeName + '.sig')
  Remove-ProbeFile -Path $probePath -TempRoot $tempRoot -ExpectedName $probeName
}

if ($DryRun) {
  Write-Host ''
  Write-Host '-DryRun: the key signed a real probe that verified against the committed public key. Not building.'
  exit 0
}

# ---------------------------------------------------------------------------
# 3. Build.
# ---------------------------------------------------------------------------

# Tauri reads both variables; set them for this process and its children only, so
# nothing lands in a shell profile or a checked-in file.
$env:TAURI_SIGNING_PRIVATE_KEY = [System.IO.File]::ReadAllText($keyPath)
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
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
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
