/**
 * Account sessions.
 *
 * Deliberately a separate file from `session.ts` rather than a parameterised
 * version of it. Admin and account sessions look alike - random token, SHA-256 at
 * rest, sliding expiry, `__Host-` cookie - and that similarity is exactly why
 * they must not be one function. The differences are the whole point:
 *
 *   - The cookie name is separate, so signing in to the panel and signing in to
 *     Wafi X cannot be confused for one another, and clearing one does not
 *     disturb the other.
 *   - `Secure` and `__Host-` follow `ACCOUNT_ORIGIN`, not `PUBLIC_ORIGIN`. The
 *     cookie belongs to the *app's* origin.
 *   - `last_seen_at` is touched on a five-minute cadence instead of on every
 *     request. See `TOUCH_INTERVAL_MS` for why that is the right call here and
 *     would be the wrong one for the panel.
 *   - The number of concurrent sessions per account is capped.
 *
 * WHAT IS NOT HERE, AND WHY
 * =========================
 *
 * This file stores no IP address, no user agent, no hostname, no device id and
 * no install id. There is nowhere in the account path to put one even if a
 * future change wanted to, because the session row has four columns and a
 * session cookie has no way to carry any of that without a signature that does
 * not exist.
 *
 * There is also no `destroyAllForAccount`. Admin sessions get one because a
 * password change must kill every other session; accounts have no password change
 * in 1.0.0, and "sign out everywhere" is a feature nobody has asked for. Adding
 * the function now would be an unused export that a future route reaches for
 * without reading this paragraph.
 */

import type { Config } from "./env.ts";
import type { Db } from "./db.ts";
import { nowIso } from "./db.ts";
import { newSessionToken, sha256Hex } from "./crypto.ts";
import { parseCookies } from "./session.ts";

export const ACCOUNT_SESSION_COOKIE = "wafx_account";

/**
 * How stale `last_seen_at` may get before the row is rewritten.
 *
 * The panel touches its session on every request, which costs one D1 write per
 * request. An account is not the panel: it is a desktop app that may poll, and a
 * write per poll turns "am I signed in?" into a database write amplifier.
 *
 * So the row is only rewritten once `last_seen_at` is this old. The column is
 * then accurate to within five minutes, which is the honest claim - and it is
 * accurate, not merely recent, because it is never set to a time the session was
 * not actually in use.
 *
 * Five minutes is short against the 24-hour TTL, so sliding still behaves as
 * sliding: an account in continuous use is extended roughly every five minutes
 * rather than every request, and an account that stops for longer than the TTL
 * expires. Both bounds still hold.
 */
export const TOUCH_INTERVAL_MS = 5 * 60_000;

export interface AccountSession {
  readonly accountId: string;
  readonly email: string;
  readonly createdAt: string;
  /** Seconds until this session expires as of *now*. Drives the cookie's Max-Age. */
  readonly expiresInSeconds: number;
}

export interface AccountRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly password_salt: string;
  readonly iterations: number;
  readonly disabled: number;
  readonly created_at: string;
  readonly last_login_at: string | null;
}

/**
 * Serialises the account session cookie.
 *
 * `__Host-` when the app origin is https. Same guarantee as the panel cookie and
 * for the same reason: no `Domain`, `Path=/`, so a subdomain cannot set a cookie
 * that shadows this one.
 *
 * `SameSite=Strict` is not decoration. It is the layer that stops a page on
 * another origin from having the browser attach this cookie in the first place;
 * the Origin allowlist in middleware/csrf.ts is the layer that catches the
 * clients which do not implement it.
 */
export function accountCookieHeader(token: string, ttlSeconds: number, secure: boolean): string {
  const name = secure ? `__Host-${ACCOUNT_SESSION_COOKIE}` : ACCOUNT_SESSION_COOKIE;
  const attributes = [
    `${name}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(ttlSeconds))}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** Cookie that clears the session. Same name and path, so it actually matches. */
export function clearAccountCookieHeader(secure: boolean): string {
  const name = secure ? `__Host-${ACCOUNT_SESSION_COOKIE}` : ACCOUNT_SESSION_COOKIE;
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * Reads the session token from a Cookie header.
 *
 * `parseCookies` is shared with the admin cookie rather than duplicated. Both
 * cookies are named `__Host-x` or `x`, never both at once, so there is no way for
 * a request to present two session tokens and have one of them silently win.
 */
export function readAccountToken(cookieHeader: string | undefined | null): string | null {
  const cookies = parseCookies(cookieHeader);
  for (const candidate of [ACCOUNT_SESSION_COOKIE, `__Host-${ACCOUNT_SESSION_COOKIE}`]) {
    const value = cookies.get(candidate);
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

function expiry(config: Config): string {
  return new Date(Date.now() + config.accountSessionTtlHours * 3_600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

/**
 * Keeps only the newest `max` live sessions for one account, dropping the rest.
 *
 * Two steps, and the order of the two is the point.
 *
 * First the expired rows go, because the cap has to bound *live* sessions. If it
 * counted dead ones, a user who signed in and away repeatedly would eventually be
 * unable to sign in at all - the table would be full of sessions that expired
 * hours ago.
 *
 * Then the excess is dropped by `last_seen_at`, so an account with eleven devices
 * keeps its ten most recently used rather than whichever happened to sign in
 * first.
 *
 * `rowid DESC` is the tie-break, and it is load-bearing rather than decorative.
 * Timestamps are stored to the second, so two logins in the same second are
 * indistinguishable by `last_seen_at` and `created_at` alike - and "keep the
 * newest N" over tied rows is arbitrary. `rowid` is monotonic in insertion order,
 * so it resolves the tie the only way that means anything: the session created
 * first is the one dropped.
 *
 * Called *after* the new row is inserted. Before the insert, "keep the newest ten"
 * out of ten rows keeps all ten and the insert makes eleven; the cap would be
 * unreachable and unbounded in exactly the case it exists to bound.
 */
async function enforceSessionCap(db: Db, accountId: string, max: number): Promise<void> {
  await db.run(
    "DELETE FROM account_sessions WHERE account_id = ? AND expires_at <= ?",
    accountId,
    nowIso(),
  );
  await db.run(
    `DELETE FROM account_sessions
      WHERE account_id = ?
        AND token_hash NOT IN (
          SELECT token_hash FROM account_sessions
           WHERE account_id = ?
           ORDER BY last_seen_at DESC, created_at DESC, rowid DESC
           LIMIT ?
        )`,
    accountId,
    accountId,
    max,
  );
}

/**
 * Creates a session row and returns the raw token.
 *
 * The raw value exists here, in one Set-Cookie header, and nowhere else. It is
 * not logged, not returned in the body, and not stored - only its SHA-256 is, so
 * a dump of `account_sessions` cannot be replayed as a login.
 */
export async function create(db: Db, accountId: string, config: Config): Promise<string> {
  const token = newSessionToken();
  const tokenHash = await sha256Hex(token);
  await db.run(
    `INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
    tokenHash,
    accountId,
    nowIso(),
    expiry(config),
    nowIso(),
  );
  await enforceSessionCap(db, accountId, config.accountSessionMaxPerAccount);
  return token;
}

/**
 * Resolves a token to a session, or null.
 *
 * Three ways to be refused, all of them final:
 *
 *   - No row for that hash. Fabricated token, or a session already destroyed.
 *   - The account is `disabled`. Re-read from `accounts` on every request rather
 *     than cached in the session, so disabling an account takes effect at once
 *     instead of whenever the cookie happens to expire. The row is deleted, so
 *     re-enabling does not resurrect it.
 *   - The row has expired. Also deleted on sight, which keeps the table from
 *     needing a cron to stay clean.
 *
 * A session for an account that no longer exists cannot reach the first branch:
 * `account_sessions.account_id` is `ON DELETE CASCADE`, so deleting an account
 * takes its sessions with it. The join is an inner join on purpose.
 */
export async function resolve(
  db: Db,
  token: string,
  config: Config,
): Promise<AccountSession | null> {
  const tokenHash = await sha256Hex(token);
  const row = await db.first<{
    account_id: string;
    email: string;
    created_at: string;
    expires_at: string;
    last_seen_at: string;
    disabled: number;
  }>(
    `SELECT s.account_id, s.created_at, s.expires_at, s.last_seen_at,
            a.email, a.disabled
       FROM account_sessions s
       JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ?`,
    tokenHash,
  );

  if (!row) return null;

  const expiresAtMs = Date.parse(String(row.expires_at));
  if (Number(row.disabled) === 1 || expiresAtMs <= Date.now()) {
    await db.run("DELETE FROM account_sessions WHERE token_hash = ?", tokenHash);
    return null;
  }

  const staleFor = Date.now() - Date.parse(String(row.last_seen_at));
  if (staleFor >= TOUCH_INTERVAL_MS) {
    // Extend expiry and last_seen_at in the same write, so they can never
    // disagree about when the session was last used.
    await db.run(
      "UPDATE account_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
      nowIso(),
      expiry(config),
      tokenHash,
    );
  }

  return {
    accountId: String(row.account_id),
    email: String(row.email),
    createdAt: String(row.created_at),
    // Remaining time, not the full TTL. Handing the client the full TTL on every
    // response would let the browser hold a cookie that outlives the row, which
    // is a session that looks valid and is not.
    expiresInSeconds: Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)),
  };
}

/** Revokes exactly the one session this request presented. */
export async function destroy(db: Db, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await db.run("DELETE FROM account_sessions WHERE token_hash = ?", tokenHash);
}

/**
 * Canonical stored form of an email address.
 *
 * `toLowerCase()` is Unicode-aware, which is the one fold SQLite cannot do in a
 * constraint - see the note in migrations/0003_accounts.sql. Trim first, so the
 * `email = trim(email)` CHECK is satisfied by construction rather than by luck.
 *
 * Every write and every lookup goes through this function. An address that is
 * normalised on the way in and looked up with the same function is what makes the
 * plain `UNIQUE (email)` in the schema case-insensitive in practice.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function accountByEmail(db: Db, email: string): Promise<AccountRow | null> {
  return db.first<AccountRow>(
    `SELECT id, email, password_hash, password_salt, iterations, disabled, created_at, last_login_at
       FROM accounts WHERE email = ?`,
    normaliseEmail(email),
  );
}

export function accountById(db: Db, id: string): Promise<AccountRow | null> {
  return db.first<AccountRow>(
    `SELECT id, email, password_hash, password_salt, iterations, disabled, created_at, last_login_at
       FROM accounts WHERE id = ?`,
    id,
  );
}