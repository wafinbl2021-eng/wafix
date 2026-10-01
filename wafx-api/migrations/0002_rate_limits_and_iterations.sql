/**
 * Migrations for the tables Phase 1 needs beyond Phase 0's schema.
 *
 * Two additions:
 *
 *   - `rate_limits`, backing the login throttle. Written by hand rather than
 *     pulled from a KV binding, because a rate limit that disappears when a
 *     plan changes is not a rate limit.
 *
 *   - `migration 0002` also relaxes `admins.iterations`.
 *
 * Why that relaxation is needed, since Phase 0's schema required 310,000
 * iterations and the agreed design still says PBKDF2:
 *
 *   Cloudflare's runtime caps PBKDF2 at 100,000 iterations and throws above it,
 *   so a Worker can never *perform* 310,000 rounds. The Workers Free plan also
 *   allows only 10 ms of CPU per request, and PBKDF2 at the 100,000 ceiling
 *   costs ~41 ms - four times the whole budget.
 *
 *   So the KDF runs in the admin panel, where there is no such limit, at 600,000
 *   iterations. The Worker stores only SHA-256 of the resulting verifier and
 *   records the iteration count so the panel knows what to use and so the count
 *   can be raised later without invalidating anyone. The stored column
 *   therefore describes a browser-side cost, not a Worker-side one, and the
 *   lower bound moves to 100,000 to match the OWASP floor rather than the old
 *   server-side figure.
 */

-- Login throttling. Fixed window, one row per (account, ip) pair.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT    PRIMARY KEY,
  window_start TEXT    NOT NULL,
  count        INTEGER NOT NULL CHECK (count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);

-- The iteration count is now a client-side figure. Keep a floor and a ceiling
-- that stop a typo storing a value no client can honour, while allowing the
-- figure to be raised over time.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt: create the new
-- shape, copy the rows, drop the old table, rename. The copy cannot fail here,
-- because every value the old constraint allowed (>= 310,000) also satisfies the
-- new one (>= 100,000). Sessions reference admins by id, so the rebuild does not
-- touch them; the cascade from admins to admin_sessions is restored when the
-- renamed table lands, which the schema verifier asserts.
CREATE TABLE admins_rebuilt (
  id            TEXT    PRIMARY KEY,
  username      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  password_salt TEXT    NOT NULL,
  iterations    INTEGER NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_login_at TEXT,
  CHECK (disabled IN (0, 1)),
  CHECK (iterations >= 100000 AND iterations <= 5000000),
  CHECK (length(password_salt) >= 16),
  CHECK (length(password_hash) >= 32),
  UNIQUE (username)
);

INSERT INTO admins_rebuilt (id, username, password_hash, password_salt, iterations, disabled, created_at, last_login_at)
SELECT id, username, password_hash, password_salt, iterations, disabled, created_at, last_login_at
  FROM admins;

DROP TABLE admins;
ALTER TABLE admins_rebuilt RENAME TO admins;
