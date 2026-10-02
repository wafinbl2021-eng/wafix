# Wafi X operations

How the Wafi X catalog API gets deployed, how its first admin is created, how
catalog entries are published, and how updates reach installed copies of the
app. Everything here is deliberately manual and credential-gated; nothing in
this document runs unattended.

Wafi X is a rebrand layered onto the existing desktop app. The catalog API lives
in [`wafx-api/`](../wafx-api/README.md) and is completely separate from
[`backend/`](../backend), which owns PC Tweaker licensing and is untouched.

## Status

| Area | State |
| --- | --- |
| Icon / branding | Done. Wafi X emblem ships as the app, EXE, shortcut and installer icon. |
| API source | Done. Worker, admin panel, schema, migrations, 125 tests. |
| API deployment | **Not deployed.** Needs a Cloudflare account. See below. |
| D1 migrations | Written, verified against a local database. **Not applied remotely.** |
| Admin account | Script ready. **Not bootstrapped** - no live Worker to call. |
| Catalog data | **Empty.** No apps published. |
| Self-update | Already wired to GitHub Releases. Never exercised. |
| Updater signing | Key handling in place. **The private key for the committed pubkey is not on this machine.** |
| Release automation | Verification and alias workflows exist. Builds are unsigned in CI. |

## Deploying the API

Two values in [`wafx-api/wrangler.toml`](../wafx-api/wrangler.toml) cannot be
known in advance and are deliberately left as placeholders:

```
database_id = "REPLACE_WITH_THE_ID_WRANGLER_PRINTED"
PUBLIC_ORIGIN = "https://wafx-api.YOUR-SUBSCRIPTION.workers.dev"
```

Create the database and fill both in:

```
cd wafx-api
npx wrangler d1 create wafx          # paste the printed id into wrangler.toml
```

`wafx-api-deploy.yml` refuses to run while either placeholder is present,
rather than failing later as a confusing 404.

Then either use the workflow (**Deploy wafx-api**, manual dispatch, with an
optional migration step and a `--dry-run` mode) or run it directly:

```
cd wafx-api
npx wrangler d1 migrations apply wafx --remote
npx wrangler deploy
```

It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. In CI those are
repository secrets; locally `npx wrangler login` is enough. The token needs
D1 and Workers edit permissions and nothing else.

## Creating the first admin

The admin password is never stored, never sent to the Worker and never
committed. The panel derives a PBKDF2-SHA256 verifier in the browser and the
Worker stores only its SHA-256.

1. Set a bootstrap token as a Worker secret:
   ```
   npx wrangler secret put BOOTSTRAP_TOKEN
   ```
   Generate one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Seed the account from a terminal:
   ```
   node scripts/seed-admin.ts --username wafi
   ```
   It prompts for the password without echoing it and never accepts one on the
   command line, because `argv` is world-readable in the process table.

`POST /api/admin/bootstrap` only succeeds while the admins table is empty, so a
leaked token later buys nothing. `.dev.vars` holds the local equivalent and is
gitignored; `.dev.vars.example` is the committed template.

## Publishing catalog entries

Entries are created in the admin panel, not by a seed script. For each app:

- **Category** - the group it appears under in the Applications section.
- **Installer type** - `exe` or `msi`. This selects a fixed argument list in
  `src-tauri/src/installer.rs`. There is no free-form command or argument field
  anywhere in the API or the client.
- **Installer mode** - `silent`, `passive` or `interactive`. Anything else is
  rejected.
- **Installer URL** - must be HTTPS and `external`.
- **SHA-256** - see below.
- **Icon** - an HTTPS image URL. The desktop app fetches it in Rust and hands
  the webview a `data:` URL, so the app's CSP does not need to allow vendor
  hosts.

### The SHA-256 is measured, never invented

The client downloads the installer, hashes it locally and compares against this
value. A mismatch deletes the download and reports an error. The installer is
never launched. So a guessed or stale checksum is not a cosmetic mistake: it is
an app that refuses to install.

Download the exact file the URL serves and hash it:

```
Get-FileHash -Algorithm SHA256 .\7z2409-x64.exe
```

Publish the value from that command. When a vendor ships a new build, the URL
stays and the checksum changes - that combination is correct, and it means the
old entry must be retired rather than overwritten with different bytes. Prefer a
versioned URL per release.

## Self-update and signing

Updates already point at GitHub Releases:

```
https://github.com/AurelioAvila/pc-tweaker-app/releases/latest/download/latest.json
```

`src-tauri/tauri.conf.json` sets `createUpdaterArtifacts: true` and carries a
`pubkey`. `src-tauri/src/update_identity.rs` pins the signed artifact filenames
and the download host, so an old signature cannot advertise a newer version.

**The private key is not in this repository and must not be put in it.** A public
repository plus a committed signing key is an updater that cannot be made safe
again for users who already installed from it. `.gitignore` blocks `*.key`, and
`scripts/release-identity.test.mjs` fails if key material appears in a tracked
file.

Build a signed release with:

```
powershell -ExecutionPolicy Bypass -File scripts/build-signed.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File scripts/build-signed.ps1 -KeyFile D:\keys\wafix-updater.key
```

The script refuses a key inside the working tree, and refuses a key whose
minisign ID does not match the committed `pubkey` - signing with the wrong key
produces artifacts that every installed client silently refuses.

Rotating to a new key is a deliberate migration: it needs the new `pubkey`
shipped in a release *before* artifacts signed with it are published. Nothing in
the build rewrites it.

CI deliberately does not sign. `build.yml` builds with
`createUpdaterArtifacts: false` and uploads nothing distributable, so a
compromised runner cannot produce a trusted update.

## Branding

The supplied artwork is a 2816x1536 lockup: a circular emblem above a wordmark.
A wordmark is unreadable at 16-32 px, so the emblem is what became the
application icon and the full lockup is kept as a logo asset.

```
powershell -ExecutionPolicy Bypass -File scripts/make-wafix-icons.ps1
```

`wafix-emblem.png` is committed, so regenerating the size set needs nothing
else. Pass `-Source <original.png>` to re-crop from the artwork; the measured
crop geometry is documented in the script header. `tauri icon` writes exactly
the filenames `tauri.conf.json` already lists, so `productName`, `identifier`
and `publisher` are untouched by this.

The source PNG has no alpha channel, so there was no transparency to preserve
and none was invented: the icons are the artwork on its own dark background.

## Deliberately not done

- **R2.** No bucket. Installer binaries are external HTTPS links. Enabling it
  later is a binding plus two column values, no migration and no client change.
- **Telemetry, device registration, remote commands.** The API serves a catalog
  and nothing else. The Worker does not accept device identifiers and has no
  endpoint that can act on a client.
- **Phase 4.** Not started.