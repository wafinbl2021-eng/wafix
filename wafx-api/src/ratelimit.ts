/**
 * Rate limiting.
 *
 * Fixed-window counters in D1. Chosen over the Workers Rate Limiting binding
 * because that binding is not available on every plan this is meant to run on,
 * and a limit that silently disappears when a plan changes is worse than a
 * counter that costs one row read.
 *
 * Two structural details are load-bearing:
 *
 *   - The increment is a single UPSERT ... RETURNING statement. Reading the
 *     count and then writing count+1 lets two concurrent requests both see "9"
 *     and both write "10", so the limit is off by however many requests race.
 *   - Column references inside DO UPDATE are qualified (`rate_limits.count`).
 *     Unqualified, SQLite resolves them against the incoming `excluded` row
 *     instead of the stored one, the window never resets, and the limit looks
 *     like it works right up until it stops resetting.
 *
 * Windows are fixed rather than sliding: a sliding window needs a row per
 * distinct timestamp, turning a two-column table into an event log.
 */

import type { Db } from "./db.ts";
import { minutesAgoIso } from "./db.ts";
import { sha256Hex } from "./crypto.ts";

export interface LimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the current window ends. Only meaningful when refused. */
  readonly retryAfterSeconds: number;
}

export interface LimitOptions {
  readonly bucket: string;
  readonly max: number;
  readonly windowMinutes: number;
}

/** First 16 hex characters of a SHA-256: collision-free enough for a bucket key. */
async function digest(value: string): Promise<string> {
  return (await sha256Hex(value)).slice(0, 16);
}

/**
 * Per account, keyed on the username alone.
 *
 * Deliberately *not* including the IP. A bucket keyed on both is really a second
 * per-IP bucket under a different name: an attacker who rotates addresses gets a
 * fresh account budget on every request, which is exactly what this bucket
 * exists to prevent. Keying on the username alone is what makes spraying one
 * account from many addresses countable.
 *
 * The username is hashed into the key rather than stored plainly, so a dump of
 * `rate_limits` does not hand over the operator's username. The key does not
 * need to be readable for the limit to work.
 */
export async function loginBucket(username: string): Promise<string> {
  return `login:${await digest(username.trim().toLowerCase())}`;
}

/** Per-IP only, applied before any account lookup so it costs nothing extra. */
export const loginIpBucket = (ip: string): string => `login-ip:${ip}`;

/**
 * Account buckets.
 *
 * Two buckets per login, and two more for registration, so the cost of guessing
 * is bounded whether the attacker spreads requests across addresses or across
 * accounts.
 *
 * Why the IP is hashed here and stored plainly in `loginIpBucket` above: this is a
 * deliberate divergence, not an inconsistency. Admin login is one operator, and
 * the plaintext IP is useful in an audit trail. Account login is the public
 * internet, and `rate_limits` is not a table anyone should be able to read a
 * visitor's address out of. The bucket key does not need to be readable for the
 * limit to work - it only needs to be the same string for the same input.
 *
 * Addresses are normalised the same way `loginBucket` normalises a username, so
 * `A@x.com` and `a@x.com` cannot each spend their own budget.
 *
 * Why registration has its own address bucket rather than reusing the login one:
 * the two are judged against different limits - five logins per fifteen minutes is
 * a brute-force ceiling, five registrations per day is a spam ceiling - and one
 * shared counter would be measured against whichever limit happened to be
 * stricter. Sharing it also means a legitimate sign-up spends the budget that the
 * sign-in is about to need.
 */
export async function accountIpBucket(ip: string): Promise<string> {
  return `account-ip:${await digest(ip)}`;
}

export async function accountEmailBucket(email: string): Promise<string> {
  return `account-email:${await digest(email.trim().toLowerCase())}`;
}

/** Registration, per IP, over a day-long window. */
export async function accountRegisterIpBucket(ip: string): Promise<string> {
  return `account-register-ip:${await digest(ip)}`;
}

/** Registration, per address, over a day-long window. */
export async function accountRegisterEmailBucket(email: string): Promise<string> {
  return `account-register-email:${await digest(email.trim().toLowerCase())}`;
}

const UPSERT = `
INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
ON CONFLICT(bucket) DO UPDATE SET
  count        = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END,
  window_start = CASE WHEN rate_limits.window_start <= ? THEN excluded.window_start ELSE rate_limits.window_start END
RETURNING count, window_start
`;

function toIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Counts this attempt and reports whether it is allowed.
 *
 * The count is incremented whether or not the caller is over the limit, so a
 * script hammering the endpoint cannot reset its own window by making the
 * refusal be the request that lands on the boundary.
 */
export async function consume(db: Db, options: LimitOptions): Promise<LimitVerdict> {
  const now = Date.now();
  // A window is stale once its stored start is older than the window length.
  const boundary = toIso(now - options.windowMinutes * 60_000);
  const row = await db
    .prepare(UPSERT)
    .bind(options.bucket, toIso(now), boundary, boundary)
    .first<{ count: number; window_start: string }>();

  const count = Number(row?.count ?? 1);
  const windowStart = Date.parse(String(row?.window_start ?? toIso(now)));
  const windowEnd = windowStart + options.windowMinutes * 60_000;

  return {
    allowed: count <= options.max,
    remaining: Math.max(0, options.max - count),
    retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)),
  };
}

/** Clears the counters after a successful login, so a careful operator resets. */
export async function reset(db: Db, buckets: readonly string[]): Promise<void> {
  if (buckets.length === 0) return;
  const placeholders = buckets.map(() => "?").join(", ");
  await db.run(`DELETE FROM rate_limits WHERE bucket IN (${placeholders})`, ...buckets);
}

/**
 * Housekeeping. Expired rows go only once the table has grown past a threshold,
 * because on the free plan every statement counts against a daily budget and a
 * sweep on each login would cost more than the rows it removes.
 */
export async function sweepIfStale(db: Db, keepUnder = 500): Promise<void> {
  const row = await db.first<{ n: number }>("SELECT count(*) AS n FROM rate_limits");
  if (Number(row?.n ?? 0) <= keepUnder) return;
  await db.run("DELETE FROM rate_limits WHERE window_start < ?", minutesAgoIso(60 * 24));
}
