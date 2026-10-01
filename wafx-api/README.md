# wafx-api

Wafi X catalog and release API. Cloudflare Workers + D1.

**This service is separate from `backend/` on purpose.** `backend/` owns PC
Tweaker licensing, Stripe and email on Postgres, and is linked to the existing
subscription product. Nothing here touches it, and nothing in it imports from
it. Wafi X can be deployed, changed or abandoned without PC Tweaker's billing
path noticing.

## What is deliberately absent

There is no remote control here, and adding one is out of scope by decision, not
by omission:

- No endpoint executes anything on a user's machine.
- No endpoint returns a command, an argument list or a script.
- No heartbeat, no device registration, no telemetry channel.
- No push mechanism. The desktop app asks when the user opens it.

The one place a remote value reaches a local process is
`app_versions.installer_url`, and that value is a URL to a file the user chose
to download, over HTTPS, optionally hash-verified. How the installer is launched
is decided in Rust, not here: see `installer_mode` below.

## Phase status

Phase 0 only. The schema and configuration below are settled and tested; there
are no routes yet.

```
migrations/0001_init.sql   schema, verified against real SQLite
scripts/verify-schema.mjs  40 assertions over that schema
wrangler.toml              bindings + config
.dev.vars.example          secret names, no values
src/                       Phase 1
admin/                     Phase 1
```

## Verify the schema

Needs no Cloudflare account, no network and no dependencies - `node:sqlite` ships
with Node 22+:

```
node scripts/verify-schema.mjs
```

It applies `0001_init.sql` to an in-memory database and then tries to write rows
that must not exist. A schema that looks right but lets `http://`, a UNC share or
`installer_mode = 'silent; calc.exe'` through fails here, before any route is
written to sit in front of it.

## Decisions encoded in the schema

**1. Only HTTPS is storable.** `installer_url`, `apps.icon_url` and
`apps.homepage_url` carry `CHECK (... LIKE 'https://%')`. An `http://`, `file://`,
UNC or `javascript:` value cannot be written at all. The desktop app re-checks
before it spawns anything, because a server-side check is not the only thing
standing between a bad row and a running process.

**2. No free-form installer arguments, anywhere.** There is no `args`,
`parameters`, `command` or `script` column in any table - asserted by the
verifier, which greps `pragma_table_info` for those names. `installer_mode` is a
closed enum (`silent`, `passive`, `interactive`) that the Rust side maps to argv
vectors fixed in `src-tauri/src/installer.rs`. A server that could send an
argument string would be a remote command channel wearing an app's name.

**3. R2 later, without a rebuild.** `installer_url` already means either "an
absolute https URL" or "an object key", and `installer_url_kind` says which.
Adding R2 means uncommenting the `[[r2_buckets]]` block in `wrangler.toml` and
writing a different value into two columns that already exist. No ALTER TABLE, no
migration over existing rows, no new branch in the desktop app.

Phase 1 sets `installer_url_kind = 'external'` for everything and never uploads a
byte. R2 needs a payment method on the bucket even at the free tier, which is the
reason it is off.

**4. Admin sessions are revocable.** Only the SHA-256 of a session token is
stored, in an `HttpOnly; Secure; SameSite=Strict` cookie. The token exists once.
Deleting a row from `admins` cascades to its sessions, so disabling an operator
takes effect immediately rather than whenever their token happens to expire.

## First run

```
npm install
npx wrangler d1 create wafx          # prints a database_id -> wrangler.toml
npm run migrate:local
cp .dev.vars.example .dev.vars       # then set BOOTSTRAP_TOKEN
npm run dev
```

Deploying:

```
npx wrangler d1 migrations apply wafx --remote
npx wrangler secret put BOOTSTRAP_TOKEN
npm run deploy
```

The admin panel is served from `admin/` through Workers Static Assets, which
needs no bucket and no card. Only the API is a Worker route today; the panel
appears under `/admin` once phase 1 adds the files.

## Moving to your own domain

Nothing in the codebase names a hostname. Two places carry the current one:

- `[vars] PUBLIC_ORIGIN` in `wrangler.toml`
- `connect-src` in `src-tauri/tauri.conf.json`

They must change together. The CSP is a literal, not derived from an env var, so
a build pointing `VITE_WAFX_API` somewhere new while the CSP still lists the old
host fails at runtime with a CSP violation that surfaces as an unhelpful network
error.

## Relationship to the desktop updater

`wafx_releases` is the panel's record of what it published. It is not the source
of truth for the updater.

Existing installations read `latest.json` from GitHub Releases, because
`src-tauri/src/update_identity.rs` pins both the artifact filename prefix and the
download host to a github.com release URL as an anti-replay check. Moving that
feed means changing that file deliberately and re-testing signature handling -
a real piece of work, and not one to do while building a catalog.

So: the panel publishes a release to GitHub and records what it did. If the two
ever disagree, GitHub is what every installed copy is reading.
