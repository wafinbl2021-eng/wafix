/**
 * Wafi X accounts, sessions and Pro grants. D1 (SQLite).
 *
 * This is Phase 1. It adds storage and nothing else: no route reads these
 * tables yet, and no test exercises a handler against them. The point of
 * landing it alone is that every property this schema is supposed to have is
 * settled - and enforced by CHECK and FOREIGN KEY constraints rather than by
 * validation a future handler might forget - before a single line of
 * authentication is written on top of it.
 *
 * FOUR TABLES, AND ONLY FOUR
 * =========================
 *
 *   accounts          a person, identified by an email address
 *   account_sessions  logged-in sessions, hashed
 *   account_tokens    single-use tokens (unwritten in 1.0.0 - see below)
 *   pro_grants        Pro entitlement, granted and revoked by an admin
 *
 *
 * AN ACCOUNT IS A PERSON, NOT A MACHINE
 * =====================================
 *
 * There is no machine_id, hwid, install_id, device_id, MachineGuid, hostname,
 * serial number, IP address, user agent or coordinate column anywhere in this
 * file, and none may be added. The account is bound to a human being and to
 * nothing else. Consequences, all of them intentional:
 *
 *   - Reinstalling Wafi X does not lose the account, and does not create a
 *     second one. The email address is the identity.
 *   - Pro follows the person across machines, which is what a Pro purchase is
 *     understood to mean and is why nothing here needs to be re-issued per
 *     device.
 *   - Nothing in this schema can be joined to a fingerprinting database without
 *     a separate breach of some other system first. There is no join key.
 *
 * This is a deliberate departure from `backend/`, whose `users` table is keyed
 * by install identity. Wafi X is a separate product and does not inherit that
 * model. `scripts/verify-schema.mjs` and `test/accounts-schema.test.ts` both
 * assert the absence, so a later column cannot be added quietly.
 *
 * The one deliberate exception in the whole schema is `admin_audit.ip`, which
 * predates this migration. That is an operator audit trail - a record of who
 * did what from where - and it is not joined to any account. It stays.
 *
 *
 * PASSWORD MATERIAL: THE SAME MODEL AS `admins`, ONE STEP TIGHTER
 * ===============================================================
 *
 * `admins` derives a verifier with PBKDF2-SHA256 at 600,000 iterations *in the
 * browser*, because Cloudflare caps WebCrypto at 100,000 and the Workers Free
 * plan allows 10 ms of CPU per request. See `src/crypto.ts` for the full
 * reasoning. Accounts use that identical model: the client stretches, the Worker
 * stores `SHA-256(verifier)`, and `iterations` is recorded per row so the figure
 * can be raised later without invalidating anyone.
 *
 * A stolen database therefore yields `SHA-256(verifier)`, which is not a login
 * credential - the server hashes whatever arrives before comparing - and a
 * recovered verifier still costs 600,000 PBKDF2 rounds per guess.
 *
 * One column is stricter than `admins.password_hash`, which only checks
 * `length >= 32`. `accounts` demands exactly 64 lowercase hex characters, which
 * is what `sha256Hex()` returns and what `timingSafeEqualHex()` requires: a
 * shorter or malformed hash can never compare equal, so the looser check admits
 * rows that are permanently unable to authenticate. Nothing in this migration
 * can be the cause of a broken login later.
 *
 *
 * EMAIL IS NORMALISED BY THE SCHEME, NOT BY THE ROUTE
 * ===================================================
 *
 * The stored form is canonical, and that is what makes uniqueness work:
 *
 *   - `CHECK (email NOT GLOB '*[A-Z]*')` means a stored address has no ASCII
 *     uppercase in it, so two stored addresses differing only by ASCII case
 *     cannot both exist - which is why `UNIQUE (email)` is already
 *     case-insensitive without any folding index.
 *   - `CHECK (email = trim(email))` means no padding.
 *
 * GLOB is used rather than `lower(email)` deliberately: SQLite's `lower()` folds
 * ASCII only, so a CHECK comparing against it would disagree with JavaScript's
 * Unicode-aware `toLowerCase()` and reject legitimate non-ASCII addresses.
 *
 * The residual gap is a non-ASCII local part differing only by case, which
 * neither this schema nor any SQLite constraint can catch. Phase 2's route is
 * responsible for normalising with `toLowerCase()`, which does fold those.
 *
 * The remaining email checks are a shape floor, not RFC 5322 validation: an
 * `@` with something before it and something after it, and a sane length. Real
 * validation belongs in `src/validate.ts` in Phase 2, where it can produce a
 * useful error message. The floor exists so an obviously malformed value cannot
 * reach storage at all.
 *
 *
 * WHY `account_tokens` EXISTS BUT IS NEVER WRITTEN IN 1.0.0
 * ========================================================
 *
 * Phase 0.2 deferred email verification, password reset and email-based
 * recovery to 1.1. No Wafi X 1.0.0 route writes a row here.
 *
 * The table is in this migration anyway, with `purpose` closed to the three
 * values 1.1 will need, for one reason: a token table that arrives with an open
 * `purpose` column is a general-purpose bearer-token store by the time anyone
 * reaches for it, and it will be reachable by a compromised handler. Fixing the
 * set now costs one line; fixing it later means auditing every row ever written.
 *
 * Rows are hashed exactly like sessions, carry an expiry, and are single-use via
 * `used_at IS NULL` - enforced in the consuming query, because a partial unique
 * index cannot express "not yet consumed" over a mutable column.
 *
 *
 * PRO LIVES IN ONE PLACE
 * ======================
 *
 * `accounts` has no `is_pro`, no `plan`, no `pro_until`. The entitlement is the
 * existence of a live row in `pro_grants`, and that is the whole model.
 *
 * This matters because `backend/` carries exactly that split - a `users.plan`
 * column beside an `entitlements` table - and reconciling the two when they
 * disagree is how a paying customer ends up locked out. There is nothing to
 * reconcile here because there is only one column that answers the question.
 *
 * `plan` is closed to `('pro', 'lifetime')`. Those are the two states Wafi X
 * 1.0.0 can actually produce, and `lifetime` is not hypothetical: the desktop
 * app gates four lifetime tools on `plan == "lifetime"`, so an admin-granted
 * account can reach them. Stripe-era plans (`monthly`, `annual`) are deliberately
 * absent rather than pre-emptively allowed, and arrive with the Stripe
 * migration, which rebuilds the table the same way 0002 rebuilt `admins`.
 *
 * There are no Stripe columns - no customer id, no subscription id, no price id,
 * no webhook event. None of them have a value in 1.0.0, and a column that is
 * always NULL is a column someone will eventually trust.
 *
 *
 * GRANT HISTORY IS KEPT, AND RE-GRANTING IS AN EXPLICIT REVOKE FIRST
 * =================================================================
 *
 * Each grant is its own row, so "who gave this account Pro, and when" survives
 * later revocations. `revoked_at`, `revoked_by`, `revoked_by_username` and
 * `revoke_reason` are on the row that was revoked rather than beside it.
 *
 * A partial unique index allows at most one *unrevoked* grant per account.
 * SQLite cannot put `now()` in an index, so an unrevoked grant that has already
 * expired still occupies the slot - and a new grant is refused until the old one
 * is explicitly revoked. That is the intended behaviour: expiry and revocation
 * are different states, every transition between them is a deliberate act by a
 * named admin, and each one is an auditable event. "Fixing" this with an
 * implicit overwrite would lose exactly the history this table exists to keep.
 *
 *
 * ATTRIBUTION IS DENORMALISED ON PURPOSE
 * ======================================
 *
 * `granted_by_username` and `revoked_by_username` duplicate the referenced
 * admin's username alongside the id.
 *
 * The id is a foreign key so the reference cannot dangle: a grant naming an
 * admin who does not exist is refused at insert rather than becoming a mystery.
 * The username is copied so the answer to "who handed out this Pro" survives
 * afterwards. The foreign key has no ON DELETE clause for the same reason -
 * deleting an admin must not erase the record of a Pro grant, and refusing the
 * delete outright is the honest way to guarantee it. No route deletes an admin.
 *
 *
 * TIMESTAMPS
 * ==========
 *
 * Every stamp is the same `YYYY-MM-DDTHH:MM:SSZ` UTC form `strftime` produces
 * and `nowIso()` writes, so lexicographic comparison in SQL equals chronological
 * comparison. Anything a CHECK compares as a string compares correctly for that
 * reason.
 *
 * As in 0001, SQLite requires every column definition to come first and every
 * table constraint after them, interleaving the two is a syntax error.
 */

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  id                   TEXT    PRIMARY KEY,
  -- Normalised at rest. See the email notes above: no ASCII uppercase is
  -- storable, and uniqueness is case-insensitive via the index below.
  email                TEXT    NOT NULL,
  -- PBKDF2-SHA256 happens client-side; this is SHA-256 of the verifier. The
  -- column describes a browser-side cost, not a Worker-side one.
  password_hash        TEXT    NOT NULL,
  password_salt        TEXT    NOT NULL,
  iterations           INTEGER NOT NULL,
  disabled             INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_login_at        TEXT,
  -- Disable is an administrative act, so it carries the same attribution
  -- pro_grants does. `disabled = 1` and these three are all-or-nothing.
  disabled_at          TEXT,
  disabled_by          TEXT    REFERENCES admins(id),
  disabled_by_username TEXT,

  CHECK (disabled IN (0, 1)),
  CHECK (iterations >= 100000 AND iterations <= 5000000),
  CHECK (length(password_salt) >= 16),
  -- Exactly what sha256Hex() returns and what timingSafeEqualHex() can compare.
  CHECK (length(password_hash) = 64 AND password_hash NOT GLOB '*[^0-9a-f]*'),

  -- Email: ASCII-normalised, unpadded, and of a plausible shape.
  CHECK (email NOT GLOB '*[A-Z]*'),
  CHECK (email = trim(email)),
  CHECK (length(email) BETWEEN 3 AND 254),
  CHECK (instr(email, '@') BETWEEN 2 AND length(email) - 1),

  -- Disabled state is all-or-nothing, in both directions, so a row cannot claim
  -- to be disabled with nobody responsible for it or be live while still
  -- carrying an old disable stamp.
  CHECK (disabled = 0 OR (disabled_at IS NOT NULL
                          AND disabled_by IS NOT NULL
                          AND disabled_by_username IS NOT NULL)),
  CHECK (disabled = 1 OR (disabled_at IS NULL
                          AND disabled_by IS NULL
                          AND disabled_by_username IS NULL)),

  CHECK (disabled_at IS NULL OR disabled_at >= created_at),
  CHECK (last_login_at IS NULL OR last_login_at >= created_at),

  -- Uniqueness is exact *because* of the `NOT GLOB '[A-Z]'` check above: an
  -- address with ASCII uppercase in it cannot be stored at all, so two stored
  -- addresses that differ only by ASCII case cannot both exist, and an exact
  -- UNIQUE is already case-insensitive. A unique index on `lower(email)` was
  -- written here first and removed as dead code - SQLite's `lower()` folds ASCII
  -- only, so it could never have caught a pair the CHECK already rejects, and it
  -- would still not catch a non-ASCII pair. The route in Phase 2 must normalise
  -- with JavaScript's Unicode-aware `toLowerCase()` for that last case.
  UNIQUE (email)
);

-- Admin account listings page through newest-first.
CREATE INDEX idx_accounts_created ON accounts (created_at DESC);

-- ---------------------------------------------------------------------------
-- account_sessions
-- ---------------------------------------------------------------------------

-- Only SHA-256 of the session token is stored. The raw token exists once, in an
-- HttpOnly cookie, so a dump of this table cannot be replayed.
--
-- No IP address and no user agent. A session row describes "this account is
-- logged in until this time"; it does not describe where from or on what, and
-- the two are what turn an account table into a device log. Rate limiting still
-- works, because `rate_limits` buckets by a hash and is never joined to an
-- account row.
CREATE TABLE account_sessions (
  token_hash   TEXT    PRIMARY KEY,
  account_id   TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (expires_at > created_at),
  CHECK (last_seen_at >= created_at)
);

CREATE INDEX idx_account_sessions_account ON account_sessions (account_id);
CREATE INDEX idx_account_sessions_expiry  ON account_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- account_tokens
-- ---------------------------------------------------------------------------

-- Single-use, hashed, expiring tokens. Deliberately unwritten in 1.0.0: email
-- verification, password reset and email change are all deferred to 1.1 (Phase
-- 0.2). The closed `purpose` set is the reason this table can exist now.
CREATE TABLE account_tokens (
  token_hash TEXT    PRIMARY KEY,
  account_id TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT    NOT NULL,
  used_at    TEXT,

  CHECK (purpose IN ('email_verify', 'password_reset', 'email_change')),
  CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE INDEX idx_account_tokens_lookup ON account_tokens (account_id, purpose, expires_at);

-- ---------------------------------------------------------------------------
-- pro_grants
-- ---------------------------------------------------------------------------

-- The single source of truth for Pro. One row per grant, kept forever, so
-- "granted by whom, on what date, revoked by whom" survives every later change.
--
-- `expires_at IS NULL` means perpetual. There is no billing period here, because
-- there is no billing in 1.0.0: an admin decides when Pro ends.
CREATE TABLE pro_grants (
  id                  TEXT    PRIMARY KEY,
  account_id          TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan                TEXT    NOT NULL DEFAULT 'pro',
  granted_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- No ON DELETE clause: an admin who handed out Pro cannot be deleted while
  -- this row names them, because deleting them must not rewrite history.
  granted_by          TEXT    NOT NULL REFERENCES admins(id),
  granted_by_username TEXT    NOT NULL,
  expires_at          TEXT,
  revoked_at          TEXT,
  revoked_by          TEXT    REFERENCES admins(id),
  revoked_by_username TEXT,
  revoke_reason       TEXT,
  note                TEXT,

  -- Only the two states Wafi X 1.0.0 can produce. `lifetime` is real: the
  -- desktop app gates lifetime tools on plan == 'lifetime'.
  CHECK (plan IN ('pro', 'lifetime')),

  -- A grant cannot expire before it was made.
  CHECK (expires_at IS NULL OR expires_at > granted_at),

  -- Revocation is all-or-nothing in both directions: a live grant carries no
  -- revoker, and a revoked one cannot hide who revoked it.
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  CHECK (revoked_at IS NULL OR (revoked_by IS NOT NULL AND revoked_by_username IS NOT NULL)),
  CHECK (revoked_at IS NOT NULL OR (revoked_by IS NULL AND revoked_by_username IS NULL)),
  CHECK (revoke_reason IS NULL OR revoked_at IS NOT NULL)
);

-- At most one live grant per account. A revoked grant frees the slot, so
-- revoke-then-grant is the only path to a second Pro grant - and both halves of
-- that are audited.
CREATE UNIQUE INDEX pro_grants_one_live ON pro_grants (account_id) WHERE revoked_at IS NULL;

CREATE INDEX idx_pro_grants_account ON pro_grants (account_id, granted_at DESC);

-- Sweeping expired-but-unrevoked grants. Deliberately not unique: an expired
-- grant still occupies the live slot until an admin revokes it, and the two
-- states are kept distinct on purpose.
CREATE INDEX idx_pro_grants_expiring ON pro_grants (expires_at) WHERE revoked_at IS NULL;