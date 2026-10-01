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
}

/** Resolved, validated configuration. Built once per request from `Env`. */
export interface Config {
  publicOrigin: string;
  sessionTtlHours: number;
  loginMaxAttempts: number;
  loginWindowMinutes: number;
}

/** Upper bounds chosen so a bad config cannot turn into an unbounded wait. */
const LIMITS = {
  sessionTtlHours: { min: 1, max: 24 * 30 },
  loginMaxAttempts: { min: 1, max: 100 },
  loginWindowMinutes: { min: 1, max: 60 * 24 },
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

export function readConfig(env: Env): Config {
  return {
    publicOrigin: origin(env.PUBLIC_ORIGIN),
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
  };
}
