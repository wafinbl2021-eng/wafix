/**
 * Bindings and configuration.
 *
 * Nothing here has a default that would let the Worker start in a state where
 * it is serving traffic without a real configuration value. A missing secret
 * throws at first use rather than silently degrading to something permissive.
 */

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;

  /** Public origin the admin panel is served from, e.g. https://x.workers.dev */
  PUBLIC_ORIGIN: string;

  /** Admin session lifetime in hours. */
  SESSION_TTL_HOURS: string;

  /** Login attempts allowed per window, per ip and per username. */
  LOGIN_MAX_ATTEMPTS: string;
  LOGIN_WINDOW_MINUTES: string;

  /**
   * One-time token that creates the first admin. Absent once the first admin
   * exists, which is why the bootstrap route checks the table as well.
   */
  BOOTSTRAP_TOKEN?: string;

  // -------------------------------------------------------------------------
  // Accounts (Phase 2)
  //
  // Separate from the admin settings on purpose. Admin login is one operator
  // signing in to a panel; account login is the public internet guessing at a
  // password. Sharing one knob between them means whichever is looser wins for
  // both, so these have their own names, their own bounds and their own
  // defaults.
  // -------------------------------------------------------------------------

  /**
   * Origin the Wafi X app is served from, and the one allowed to make
   * cookie-authenticated account changes. Defaults to PUBLIC_ORIGIN.
   *
   * This is the value that decides `Secure` and the `__Host-` prefix on the
   * session cookie, so it must be the *app's* origin, not the API's.
   */
  ACCOUNT_ORIGIN?: string;

  /**
   * Further origins permitted to make cookie-authenticated account changes,
   * comma-separated. Empty by default.
   *
   * Needed because the account session cookie is only usable from an origin the
   * browser will attach it to. Where the app and the API share one origin - the
   * usual deployment - this stays empty and ACCOUNT_ORIGIN alone applies.
   */
  ACCOUNT_ORIGINS?: string;

  /** Account session lifetime in hours, sliding. */
  ACCOUNT_SESSION_TTL_HOURS?: string;

  /** Login attempts allowed per window, per IP and per email address. */
  ACCOUNT_LOGIN_MAX_ATTEMPTS?: string;

  /** The window both account limits count in. */
  ACCOUNT_WINDOW_MINUTES?: string;

  /** Registrations allowed per IP per day. */
  ACCOUNT_REGISTER_MAX_PER_DAY?: string;

  /** Sessions one account may hold at once. The oldest is dropped past this. */
  ACCOUNT_SESSION_MAX_PER_ACCOUNT?: string;

  // -------------------------------------------------------------------------
  // Pro entitlements (Phase 5)
  //
  // A Worker *secret*, never a `[vars]` entry and never a committed file: the
  // value is the 32-byte private seed of the key whose public half the desktop
  // app embeds, and anyone holding it can mint a Pro entitlement for any
  // account. The product id is deliberately absent - see LICENSE_PRODUCT_ID in
  // src/license-signing.ts for why it is a constant rather than configuration.
  // -------------------------------------------------------------------------

  /**
   * Base64 32-byte Ed25519 seed, used to sign Pro entitlements for
   * `GET /api/license`. Absent means that route cannot answer, and it says so
   * loudly rather than returning a free plan or a silent denial.
   */
  LICENSE_SIGNING_KEY_B64?: string;
}

/** Resolved, validated configuration. Built once per request from `Env`. */
export interface Config {
  publicOrigin: string;
  sessionTtlHours: number;
  loginMaxAttempts: number;
  loginWindowMinutes: number;

  /** The app origin. Decides `Secure` and `__Host-` on the account cookie. */
  accountOrigin: string;
  /** Every origin allowed to make cookie-authenticated account changes. */
  accountOrigins: readonly string[];
  accountSessionTtlHours: number;
  accountLoginMaxAttempts: number;
  accountWindowMinutes: number;
  accountRegisterMaxPerDay: number;
  accountSessionMaxPerAccount: number;
}

/** Upper bounds chosen so a bad config cannot turn into an unbounded wait. */
const LIMITS = {
  sessionTtlHours: { min: 1, max: 24 * 30 },
  loginMaxAttempts: { min: 1, max: 100 },
  loginWindowMinutes: { min: 1, max: 60 * 24 },
  // Account sessions are sliding and internet-facing. The ceiling is a month,
  // which is as long as "stay signed in" is worth meaning; past that, the
  // password is asked for again.
  accountSessionTtlHours: { min: 1, max: 24 * 30 },
  // Tighter than the admin figures. Ten guesses per fifteen minutes against one
  // operator is fine; against an account anyone on the internet can name, it is
  // not.
  accountLoginMaxAttempts: { min: 1, max: 100 },
  accountWindowMinutes: { min: 1, max: 60 * 24 },
  accountRegisterMaxPerDay: { min: 1, max: 10_000 },
  accountSessionMaxPerAccount: { min: 1, max: 100 },
} as const;

function intFromEnv(
  raw: string | undefined,
  name: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(
      `${name} must be an integer between ${bounds.min} and ${bounds.max}, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * PUBLIC_ORIGIN is compared against the Origin header to reject cross-site
 * mutating requests, so it has to be a real absolute https URL. Accepting a
 * bare host here would make that comparison silently useless.
 */
function origin(raw: string | undefined): string {
  if (!raw) {
    throw new Error(
      "PUBLIC_ORIGIN is required. Set it in wrangler.toml [vars] or as a secret.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_ORIGIN is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:") {
    // wrangler dev serves http://localhost, so local runs need this escape
    // hatch. It is scoped to loopback hosts so it cannot weaken production.
    const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (!isLoopback) {
      throw new Error(
        `PUBLIC_ORIGIN must be https in production, got ${JSON.stringify(raw)}`,
      );
    }
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("PUBLIC_ORIGIN must be an origin only, with no path");
  }
  return parsed.origin;
}

/**
 * A comma-separated list of allowed origins, each normalised the same way
 * PUBLIC_ORIGIN is.
 *
 * An entry that will not parse aborts startup rather than being skipped. A typo
 * in an allowlist should be loud: silently dropping it would leave a legitimate
 * origin locked out, and quietly keeping a malformed one would be worse.
 */
function originList(raw: string | undefined, what: string): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const parsed = origin(trimmed);
    if (!out.includes(parsed)) out.push(parsed);
    if (out.length > 16) {
      throw new Error(`${what} allows at most 16 origins`);
    }
  }
  return out;
}

export function readConfig(env: Env): Config {
  const publicOrigin = origin(env.PUBLIC_ORIGIN);
  // Defaulting to PUBLIC_ORIGIN keeps the common case - app and API on one
  // origin - working with no extra configuration at all.
  const accountOrigin = env.ACCOUNT_ORIGIN ? origin(env.ACCOUNT_ORIGIN) : publicOrigin;
  const extra = originList(env.ACCOUNT_ORIGINS, "ACCOUNT_ORIGINS");

  return {
    publicOrigin,
    sessionTtlHours: intFromEnv(
      env.SESSION_TTL_HOURS,
      "SESSION_TTL_HOURS",
      12,
      LIMITS.sessionTtlHours,
    ),
    loginMaxAttempts: intFromEnv(
      env.LOGIN_MAX_ATTEMPTS,
      "LOGIN_MAX_ATTEMPTS",
      10,
      LIMITS.loginMaxAttempts,
    ),
    loginWindowMinutes: intFromEnv(
      env.LOGIN_WINDOW_MINUTES,
      "LOGIN_WINDOW_MINUTES",
      15,
      LIMITS.loginWindowMinutes,
    ),
    accountOrigin,
    // The primary origin is always allowed. An extra entry equal to it is
    // dropped here so the allowlist has one entry per distinct origin, which
    // keeps a test asserting on its length meaningful.
    accountOrigins: [accountOrigin, ...extra.filter((value) => value !== accountOrigin)],
    accountSessionTtlHours: intFromEnv(
      env.ACCOUNT_SESSION_TTL_HOURS,
      "ACCOUNT_SESSION_TTL_HOURS",
      24,
      LIMITS.accountSessionTtlHours,
    ),
    accountLoginMaxAttempts: intFromEnv(
      env.ACCOUNT_LOGIN_MAX_ATTEMPTS,
      "ACCOUNT_LOGIN_MAX_ATTEMPTS",
      5,
      LIMITS.accountLoginMaxAttempts,
    ),
    accountWindowMinutes: intFromEnv(
      env.ACCOUNT_WINDOW_MINUTES,
      "ACCOUNT_WINDOW_MINUTES",
      15,
      LIMITS.accountWindowMinutes,
    ),
    accountRegisterMaxPerDay: intFromEnv(
      env.ACCOUNT_REGISTER_MAX_PER_DAY,
      "ACCOUNT_REGISTER_MAX_PER_DAY",
      5,
      LIMITS.accountRegisterMaxPerDay,
    ),
    accountSessionMaxPerAccount: intFromEnv(
      env.ACCOUNT_SESSION_MAX_PER_ACCOUNT,
      "ACCOUNT_SESSION_MAX_PER_ACCOUNT",
      10,
      LIMITS.accountSessionMaxPerAccount,
    ),
  };
}
