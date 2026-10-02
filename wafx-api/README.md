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

Phase 1. The catalog API, admin authentication and the admin panel are all in
place; the desktop app has not been pointed at any of it yet.

```
migrations/0001_init.sql   schema, verified against real SQLite
migrations/0002_*.sql      rate-limit counters, relaxed KDF iteration bound
scripts/verify-schema.mjs  assertions over the schema
scripts/seed-admin.ts      creates the first admin from a terminal
wrangler.toml              bindings + config
.dev.vars.example          secret names, no values
src/                       Worker: routes, auth, validation, audit
admin/                     admin panel, served as static assets
test/                      5 suites, 125 tests, real SQLite
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
Sessions are stateful rows rather than JWTs, so setting `admins.disabled = 1`
logs the account out immediately rather than whenever its token happens to
expire, and a password change revokes every session the account has.

## Admin authentication, and why the KDF runs in the browser

Passwords are never sent anywhere. The panel derives a **verifier** with
PBKDF2-SHA256 at 600,000 iterations and sends only that; the Worker stores the
SHA-256 of the verifier. The plaintext password and the PBKDF2 output both stay
in the browser tab.

That split is forced by the platform. workerd caps `PBKDF2` at 100,000
iterations, and Workers Free allows 10ms of CPU per request, so the 600,000
iterations a password KDF should cost cannot run in the Worker at all. Hashing
the 32-byte verifier is about 0.3ms, which fits comfortably.

`GET /api/admin/auth/params?username=...` returns the salt and iteration count
for an account, and a stable decoy salt for a username that does not exist, so
the response cannot be used to enumerate accounts. `admins.iterations` is stored
per row, so raising the cost later is a data change rather than a redeploy.

`scripts/seed-admin.ts` performs the same derivation in Node and posts to
`POST /api/admin/bootstrap`, which is how the first account is created without a
browser. Only the first account can be created this way: the endpoint refuses
every later call.

## Routes

Public, no authentication, cacheable:

```
GET /api/health
GET /api/apps                    published apps with their published versions
GET /api/apps/:id
GET /api/categories
GET /api/releases/latest         Wafi X release metadata; not the Tauri feed
GET /api/meta                    feed version + server time
```

Admin, session cookie plus `X-WAFI-Admin: 1` on anything that changes data:

```
GET    /api/admin/auth/params          salt + iterations for a username
POST   /api/admin/bootstrap            first admin only; needs BOOTSTRAP_TOKEN
POST   /api/admin/login
POST   /api/admin/logout
GET    /api/admin/me
POST   /api/admin/password

GET    /api/admin/categories           POST   /api/admin/categories
PATCH  /api/admin/categories/:id       DELETE /api/admin/categories/:id
GET    /api/admin/apps                 POST   /api/admin/apps
GET    /api/admin/apps/:id             PUT    /api/admin/apps/:id
DELETE /api/admin/apps/:id
GET    /api/admin/apps/:id/versions    POST   /api/admin/apps/:id/versions
PATCH  /api/admin/versions/:id         DELETE /api/admin/versions/:id

GET    /api/admin/releases             POST   /api/admin/releases
GET    /api/admin/releases/:id         PATCH  /api/admin/releases/:id
DELETE /api/admin/releases/:id
GET    /api/admin/audit
```

The auth endpoints are not all under one prefix: `params` sits at
`/api/admin/auth/params` while the rest sit directly under `/api/admin`. That
came from a test that caught `params` registered one segment too deep, and the
fix moved only that route. It is worth tidying into `/api/admin/auth/*` before
the surface is frozen, but it is cosmetic and nothing depends on it yet.

`/api/releases/latest` is deliberately not shaped like the Tauri updater
contract: no `204` for up-to-date, and no signature field. The desktop app reads
`latest.json` from GitHub Releases instead - see the section at the end.

## First run

```
npm install
npx wrangler d1 create wafx          # prints a database_id -> wrangler.toml
npm run migrate:local
cp .dev.vars.example .dev.vars       # then set BOOTSTRAP_TOKEN
npm run dev
```

Then create the first admin, from a terminal:

```
export BOOTSTRAP_TOKEN=...           # same value as .dev.vars
npm run seed:admin -- --username wafi
```

On PowerShell, set it with `$env:BOOTSTRAP_TOKEN = "..."` first. The password
is read from a prompt, or from `--password-file`, never from the command line.

or open `http://127.0.0.1:8787/admin/` and use the bootstrap form.

Deploying:

```
npx wrangler d1 migrations apply wafx --remote
npx wrangler secret put BOOTSTRAP_TOKEN
npm run deploy
```

The admin panel is served from `admin/` through Workers Static Assets, which
needs no bucket and no card. It is same-origin with the API, so there is no CORS
configuration and the session cookie can be `SameSite=Strict`.

## Checks

```
npm run check        # typecheck (both configs) + lint + schema + tests
npm run typecheck    # Worker program and Node test program
npm run lint         # eslint, strict on src/ and scripts/
npm run verify:schema
npm run test         # 125 tests against real SQLite
```

The tests run on Node's native `node:sqlite`, behind a small shim that presents
the `D1Database` interface, so they exercise the real SQL - constraints, cascade
deletes, `CHECK`s - without a Cloudflare account.

## Moving to your own domain

Nothing in the codebase names a hostname. **One** place carries it:

- `[vars] PUBLIC_ORIGIN` in `wrangler.toml`

The desktop app does not need a matching edit. An earlier draft of this README
said the `connect-src` entry in `src-tauri/tauri.conf.json` had to move too; it
does not, because the desktop app never talks to this API from the webview.

`src-tauri/src/wafx.rs` fetches the catalog with `reqwest` in Rust and hands the
webview parsed data. No request to `api.wafix.app` originates from the webview,
so the CSP has no entry to change and stays exactly as PC Tweaker shipped it.
Two consequences worth knowing:

- The host the client uses is resolved by `wafx::api_base()` — runtime
  `WAFX_API_BASE`, then the compile-time `WAFX_API_BASE` or `VITE_WAFX_API`,
  then `DEFAULT_WAFX_API_BASE`. Override it at run time and nothing recompiles.
- If that host ever moves, the only stale value is `DEFAULT_WAFX_API_BASE` in
  `wafx.rs`, and only if you rely on the default.

This is also why catalog icons are fetched in Rust and delivered as `data:`
URLs. A `data:` URL is already permitted by `img-src`, so no host is added to
the CSP and the webview is never given a reason to contact a vendor's CDN.

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
