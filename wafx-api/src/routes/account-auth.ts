/**
 * Account authentication routes.
 *
 * Four routes, and the shape of each is a decision rather than a default:
 *
 *   GET  /api/account/auth/params   salt + iteration count, decoyed
 *   POST /api/account/register      never says whether the address existed
 *   POST /api/account/login         one answer for every failure
 *   POST /api/account/logout        this session only
 *   GET  /api/account/me            behind requireAccount
 *
 * The password model is the one `admins` uses, unchanged: the client runs
 * PBKDF2-SHA256 at 600,000 iterations and sends a 32-byte verifier, and this
 * Worker stores `SHA-256(verifier)`. See src/crypto.ts for why the KDF cannot
 * run here. A stolen database therefore yields something that is not a login
 * credential, and a recovered verifier still costs 600,000 rounds per guess.
 *
 * What this Worker *cannot* do is judge password strength - it never sees a
 * password, only a hash of a stretched one. A minimum length is the client's
 * job, and no validation below pretends otherwise.
 */

import { Hono } from "hono";

import type { AccountEnv } from "../middleware/account-guard.ts";
import { context, str } from "../middleware/admin-guard.ts";
import { HttpError, badRequest } from "../errors.ts";
import { Validator } from "../validate.ts";
import {
  DEFAULT_ITERATIONS,
  MAX_ITERATIONS,
  MIN_ITERATIONS,
  decoySaltFor,
  hashVerifier,
  materialFromVerifier,
  newSalt,
  timingSafeEqualHex,
} from "../crypto.ts";
import { readJsonObject } from "./body.ts";
import {
  accountByEmail,
  accountById,
  accountCookieHeader,
  clearAccountCookieHeader,
  create,
  destroy,
  normaliseEmail,
  readAccountToken,
} from "../account-session.ts";
import {
  accountEmailBucket,
  accountIpBucket,
  accountRegisterEmailBucket,
  accountRegisterIpBucket,
  consume,
  reset,
  sweepIfStale,
} from "../ratelimit.ts";
import { nowIso } from "../db.ts";

/** Routes that do not require an existing session. */
export const accountRoutes = new Hono<AccountEnv>();

/** Routes that do. Mounted under `requireAccount()` - see src/index.ts. */
export const accountPrivateRoutes = new Hono<AccountEnv>();

const REGISTER_FIELDS = ["email", "verifier", "salt", "iterations"] as const;
const LOGIN_FIELDS = ["email", "verifier"] as const;

/**
 * The verifier a client submits is 64 lowercase hex characters (32 bytes).
 * Checking the shape before hashing keeps a megabyte of junk from becoming a
 * megabyte of SHA-256 input.
 */
const VERIFIER_PATTERN = /^[0-9a-f]{64}$/;

/**
 * One answer for every registration outcome.
 *
 * Every case below returns this exact status and this exact body:
 *
 *   - the address is new            -> the account is created
 *   - the address already exists    -> nothing happens
 *   - the address exists, and the
 *     verifier matches              -> nothing happens
 *   - the address exists, and it
 *     does not match                -> nothing happens
 *
 * The second, third and fourth cases are all the same response, which is the
 * point: a caller who has never registered cannot learn whether an address is
 * taken. Registering an address that is already taken is a no-op rather than an
 * error, and in particular cannot take the account over - no session is issued
 * and no password material is touched.
 *
 * 200 rather than 201 because there is nothing to observe that distinguishes
 * "created" from "already there", and a status code is just another channel for
 * the same question.
 *
 * The cost is one extra round trip: a new user registers and then signs in.
 * That is what the honest version looks like without an email address to
 * confirm against, which Phase 0.2 deferred to 1.1. With email verification
 * available, this becomes "check your inbox" and the second request disappears -
 * but it does not become less safe, and no safe version of this route needs it.
 */
const REGISTER_ACCEPTED = {
  ok: true,
  message:
    "If that address was not already registered, it is now. Sign in to continue.",
} as const;

/**
 * Email shape.
 *
 * A floor, not RFC 5322. It rejects the things that are wrong far more often
 * than they are right - padding, no local part, no domain, embedded whitespace,
 * stray dots - and accepts everything else, because an address this strict that
 * rejects a real person costs a support ticket and gains nothing.
 *
 * Returns the canonical stored form, so every write and every lookup goes
 * through exactly one normalisation function.
 */
function readEmail(v: Validator, value: unknown): string {
  const raw = v.string("email", value, { required: true, min: 3, max: 254 });
  if (raw === undefined) return "";
  const out = normaliseEmail(raw);

  const at = out.indexOf("@");
  const local = at < 0 ? "" : out.slice(0, at);
  const domain = at < 0 ? "" : out.slice(at + 1);
  const malformed =
    at < 0 ||
    at !== out.lastIndexOf("@") ||
    local.length < 1 ||
    local.length > 64 ||
    domain.length < 1 ||
    domain.length > 189 ||
    /\s/.test(out) ||
    out.includes("..") ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    domain.startsWith("-") ||
    domain.endsWith("-");

  if (malformed) v.note("email", "Enter a valid email address");
  return out;
}

/** Same shape check as the register route, for a query string. */
function emailFromQuery(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  const probe = new Validator();
  const out = readEmail(probe, trimmed);
  if (!probe.ok) throw badRequest("Invalid email address");
  return out;
}

function readVerifier(v: Validator, field: string, value: unknown): string {
  const raw = v.string(field, value, { required: true, min: 64, max: 64 });
  if (raw !== undefined && !VERIFIER_PATTERN.test(raw)) {
    v.note(field, "Must be 64 hexadecimal characters");
  }
  return raw ?? "";
}

/** 401 for every login failure, with one message. See the route below. */
const BAD_CREDENTIALS = { code: "unauthorized" as const, message: "Invalid email or password" };

/**
 * Salt and iteration count, so the client can derive a verifier for an address
 * that may or may not exist.
 *
 * An unknown address gets `decoySaltFor()`. The response shape, status and
 * length are identical either way, and no stored value is revealed: the decoy is
 * a fresh random salt per process, so it cannot be confused with a real one by
 * any client that does not already have the account's password.
 *
 * Deliberately not rate limited. It performs no credential work - one indexed
 * read and nothing else - and the value it returns answers no question an
 * attacker does not already have. Limiting the cheap pre-login call would
 * mostly lock out a real client retrying, for no gain.
 */
accountRoutes.get("/account/auth/params", context(), async (c) => {
  const email = emailFromQuery(c.req.query("email"));
  const account = await accountByEmail(c.get("db"), email);
  if (account === null || Number(account.disabled) === 1) {
    return c.json({ salt: decoySaltFor(), iterations: DEFAULT_ITERATIONS });
  }
  return c.json({
    salt: str(account.password_salt),
    iterations: Number(account.iterations) || DEFAULT_ITERATIONS,
  });
});

/**
 * Creates an account, or does nothing. See REGISTER_ACCEPTED for the reasoning.
 *
 * Rate limited twice: per IP over a day, because creating accounts is a spam
 * problem, and per address over the same day, because one address registering
 * repeatedly is the other half of the same abuse. Both buckets key on a hash, so
 * a dump of `rate_limits` yields neither the address nor the visitor's IP.
 *
 * The insert is allowed to lose a race. Two concurrent registrations for one
 * address make the second violate `UNIQUE (email)`; that is caught and answered
 * with the same 200 as everything else, which is what the caller would have got
 * had it arrived a moment later anyway.
 */
accountRoutes.post("/account/register", context(), async (c) => {
  const db = c.get("db");
  const config = c.get("config");

  const v = new Validator();
  const body = v.shape(await readJsonObject(c.req.raw), REGISTER_FIELDS);
  const email = readEmail(v, body.email);
  const verifier = readVerifier(v, "verifier", body.verifier);
  const salt = v.string("salt", body.salt, { required: true, min: 32, max: 64 });
  const iterations = v.integer("iterations", body.iterations, {
    fallback: DEFAULT_ITERATIONS,
    min: MIN_ITERATIONS,
    max: MAX_ITERATIONS,
  });
  v.assert();

  const window = { windowMinutes: config.accountWindowMinutes };
  const ipBucket = await accountRegisterIpBucket(c.get("ip"));
  const emailBucket = await accountRegisterEmailBucket(email);
  const buckets = [ipBucket, emailBucket];
  const max = config.accountRegisterMaxPerDay;

  for (const bucket of buckets) {
    const verdict = await consume(db, { ...window, max, bucket });
    if (!verdict.allowed) {
      throw new HttpError("rate_limited", "Too many attempts. Try again later.", {
        headers: { "Retry-After": String(verdict.retryAfterSeconds) },
      });
    }
  }

  // One SHA-256 over the presented verifier on every path, including the ones
  // that change nothing. Without it, "the address is new" does one hash and
  // "the address is taken" does none, and response time answers the question the
  // status code refuses to.
  const material = await materialFromVerifier(verifier, salt ?? newSalt(), iterations ?? DEFAULT_ITERATIONS);

  const existing = await accountByEmail(db, email);
  if (existing === null) {
    try {
      await db.run(
        `INSERT INTO accounts (id, email, password_hash, password_salt, iterations, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        email,
        material.hash,
        material.salt,
        material.iterations,
        nowIso(),
      );
    } catch {
      // Lost the race, or the address appeared between the read and the write.
      // Only tolerated when the row is genuinely there now; anything else is a
      // real failure and must surface as one.
      if ((await accountByEmail(db, email)) === null) throw new HttpError("internal", "The request could not be completed");
    }
  }

  await sweepIfStale(db);
  return c.json(REGISTER_ACCEPTED, 200);
});

/**
 * Signs in.
 *
 * Three buckets must pass - per IP, per address - both before the account is
 * looked up, so the cost of a guess is bounded whether the attacker spreads
 * requests across addresses or across accounts.
 *
 * Every failure returns `401 Invalid email or password`. That covers an unknown
 * address, a wrong verifier, and a disabled account. Collapsing the disabled case
 * into the same answer is the point: a message saying "this account is disabled"
 * is an enumeration oracle for anyone who can create accounts, and telling a
 * disabled user why is worth less than not letting a stranger discover they
 * exist. An admin who needs to explain a disable has other channels.
 *
 * On success the two buckets are reset, so a careful person who fumbled a few
 * times is not left throttled after succeeding.
 */
accountRoutes.post("/account/login", context(), async (c) => {
  const db = c.get("db");
  const config = c.get("config");

  const v = new Validator();
  const body = v.shape(await readJsonObject(c.req.raw), LOGIN_FIELDS);
  const email = readEmail(v, body.email);
  const verifier = readVerifier(v, "verifier", body.verifier);
  if (!v.ok) {
    // Same status and body as a wrong password. A malformed request is not a
    // successful guess and must not read like one.
    throw new HttpError(BAD_CREDENTIALS.code, BAD_CREDENTIALS.message);
  }

  const window = {
    max: config.accountLoginMaxAttempts,
    windowMinutes: config.accountWindowMinutes,
  };
  const ipBucket = await accountIpBucket(c.get("ip"));
  const emailBucket = await accountEmailBucket(email);
  const buckets = [ipBucket, emailBucket];

  // Per-IP first, so a spray across addresses is throttled before any lookup.
  for (const bucket of [ipBucket, emailBucket]) {
    const verdict = await consume(db, { ...window, bucket });
    if (!verdict.allowed) {
      throw new HttpError("rate_limited", "Too many attempts. Try again later.", {
        headers: { "Retry-After": String(verdict.retryAfterSeconds) },
      });
    }
  }

  const account = await accountByEmail(db, email);
  // Always hashed, even for an address that does not exist, so the two cases
  // cost the same. This is the only password-adjacent work in the request.
  const candidate = await hashVerifier(verifier);
  const ok =
    account !== null &&
    Number(account.disabled) !== 1 &&
    timingSafeEqualHex(candidate, str(account.password_hash));

  if (!ok) throw new HttpError(BAD_CREDENTIALS.code, BAD_CREDENTIALS.message);

  const accountId = str(account.id);
  const sessionToken = await create(db, accountId, config);
  await db.run("UPDATE accounts SET last_login_at = ? WHERE id = ?", nowIso(), accountId);
  await reset(db, buckets);
  await sweepIfStale(db);

  const secure = config.accountOrigin.startsWith("https://");
  return c.json(
    {
      account: {
        id: accountId,
        email: str(account.email),
        created_at: str(account.created_at),
      },
      session: { expires_in_seconds: config.accountSessionTtlHours * 3600 },
    },
    200,
    { "Set-Cookie": accountCookieHeader(sessionToken, config.accountSessionTtlHours * 3600, secure) },
  );
});

/**
 * Signs out of *this* session.
 *
 * Only the session the request presented is destroyed. Other devices stay signed
 * in, which is what "log out" means on every site people already use and what
 * they expect from a button that says Log out. "Log out everywhere" is a
 * different act and would be a separate, deliberate endpoint - it is not quietly
 * bundled in here, because a user on a shared machine who presses Log out
 * deserves to be signed out.
 *
 * Works without a valid session and answers 200 either way. Signing out is not a
 * state in which an error helps anyone, and refusing would leave a stale cookie
 * in the browser after the server has already forgotten it.
 */
accountRoutes.post("/account/logout", context(), async (c) => {
  const token = readAccountToken(c.req.header("cookie"));
  if (token !== null) await destroy(c.get("db"), token);
  const secure = c.get("config").accountOrigin.startsWith("https://");
  return c.json({ ok: true }, 200, { "Set-Cookie": clearAccountCookieHeader(secure) });
});

/**
 * Who am I.
 *
 * The client calls this on launch to decide between the sign-in screen and the
 * app, so a restart does not look like a sign-out. The session is resolved by
 * the guard that wraps this router, which is also what enforces "a disabled
 * account cannot use an existing session".
 *
 * `last_login_at` is returned but never the account id's siblings: no IP, no
 * user agent, no device, because there is nowhere in this system for any of them
 * to come from.
 *
 * There is no Pro entitlement here. Phase 5 adds it, and it will be a signed
 * licence rather than a field on this response - a client that can be told "you
 * are Pro" by a plain HTTP boolean is a client whose Pro can be spoofed.
 */
accountPrivateRoutes.get("/account/me", context(), async (c) => {
  const session = c.get("account");
  const account = await accountById(c.get("db"), session.accountId);
  // The guard resolved the session, which joins accounts, so this cannot be null
  // unless the row changed underneath it.
  if (account === null) throw new HttpError("unauthorized", "Session expired, sign in again");

  return c.json({
    account: {
      id: session.accountId,
      email: str(account.email),
      created_at: str(account.created_at),
      last_login_at: account.last_login_at === null ? null : str(account.last_login_at),
    },
    session: { expires_in_seconds: session.expiresInSeconds },
  });
});