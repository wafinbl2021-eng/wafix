# Windows release verification

CI compilation is a verification step, not a download channel: unsigned build
artifacts are not uploaded. Build and sign releases on the authorized release
workstation. The Wafi publisher certificate required for Authenticode signing is
not held yet, so this gate cannot pass until one is obtained and imported with
its private key; the updater key is already in place.

Before preparing `latest.json`, `scripts/make-latest-json.mjs` requires the
application, DLLs in its release directory, EXE installer and MSI installer to pass Windows Authenticode,
publisher identity (**Wafi**) and trusted timestamp verification.
Both installers must also have valid Tauri updater signatures for the public
key installed in the application. The helper rejects changed bytes.

PowerShell 7, Windows SDK SignTool and minisign must be available locally.
`SIGNTOOL_PATH` and `MINISIGN_PATH` may identify installed verification tools;
they are paths, not signing credentials. Missing tools stop preparation.

The stable-download workflow verifies the downloaded installers and final
aliases before uploading. WinGet is not a publishing channel for this product:
that workflow still names the previous product's package, is inert while its PAT
secret is unset, and must not be run. Verifying GitHub API SHA-256 digests and
Windows trust stays a release step regardless of which channels are published.
These checks do not sign files, rotate keys or require a new certificate.

Do not change verified assets after publication. A new build needs a new
release and fresh signatures. Manual uploads outside these helpers still
require independent verification of the final installers and packaged payloads.
Code signing identifies a publisher; it does not guarantee an absence of
SmartScreen warnings or application vulnerabilities.
