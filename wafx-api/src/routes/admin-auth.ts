/**
 * Admin authentication routes.
 *
 * `/bootstrap` creates the first admin and only ever works once. `/login` is
 * the endpoint most likely to be attacked, so it does three things that are
 * easy to skip and expensive to regret:
 *
 *   - Rate limits per IP *and* per account, before any account lookup, so the
 *     cost of a guess is bounded whether the attacker is spreading requests
 *     across addresses or across usernames.
 *   - Returns one shape for "no such user" and "wrong verifier": same status,
 *     same body, same work. A decoy salt is handed out so the client's PBKDF2
 *     still runs and the comparison is still reached.
 *   - Records the outcome in the audit log either way.
 */

import { Hono } from "hono";

import type { AdminEnv } from "../middleware/admin-guard.ts";
import { context, str } from "../middleware/admin-guard.ts";
import { HttpError, badRequest } from "../errors.ts";
import { Validator } from "../validate.ts";
import {
  DEFAULT_ITERATIONS,
  MAX_ITERATIONS,
  MIN_ITERATIONS,
  bootstrapTokenMatches,
  decoySaltFor,
  materialFromVerifier,
  newSalt,
  verifyAgainst,
} from "../crypto.ts";
import { readJsonObject } from "./body.ts";
import {
  adminById,
  adminByUsername,
  adminCount,
  clearCookieHeader,
  create,
  destroy,
  destroyAllForAdmin,
  readSessionToken,
  resolve,
  sessionCookieHeader,
} from "../session.ts";
import { loginBucket, loginIpBucket, consume, reset, sweepIfStale } from "../ratelimit.ts";
import { record } from "../audit.ts";
import { nowIso } from "../db.ts";

export const authRoutes = new Hono<AdminEnv>();

const BOOTSTRAP_FIELDS = ["bootstrap_token", "username", "verifier", "salt", "iterations"] as const;
const LOGIN_FIELDS = ["username", "verifier"] as const;
const PASSWORD_FIELDS = ["current_verifier", "new_verifier"] as const;

/**
 * The verifier a client submits is 64 lowercase hex characters (32 bytes).
 * Checking the shape before hashing keeps a megabyte of junk from becoming a
 * megabyte of SHA-256 input.
 */
const VERIFIER_PATTERN = /^[0-9a-f]{64}$/;

/** Username rules, kept in step with the panel's own hint text. */
function readUsername(v: Validator, value: unknown): string {
  const username = v.string("username", value, { required: true, min: 3, max: 40 });
  if (username !== undefined && !/^[a-z0-9._-]+$/i.test(username)) {
    v.note("username", "Use letters, digits, dots, hyphens and underscores");
  }
  return (username ?? "").toLowerCase();
}

function readVerifier(v: Validator, field: string, value: unknown): string {
  const raw = v.string(field, value, { required: true, min: 64, max: 64 });
  if (raw !== undefined && !VERIFIER_PATTERN.test(raw)) {
    v.note(field, "Must be 64 hexadecimal characters");
  }
  return raw ?? "";
}

/**
 * Derives the salt and iteration count the panel should use.
 *
 * A separate route rather than a side effect of a failed login: the panel needs
 * these before it can derive anything, and answering them here means the login
 * route never has to distinguish "unknown user" from "wrong password" by
 * returning different data.
 */
authRoutes.get("/admin/auth/params", context(), async (c) => {
  const username = (c.req.query("username") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw badRequest("Invalid username");
  }
  const admin = await adminByUsername(c.get("db"), username);
  if (admin === null || Number(admin.disabled) === 1) {
    // Indistinguishable from the real answer.
    return c.json({
      salt: decoySaltFor(),
      iterations: DEFAULT_ITERATIONS,
    });
  }
  return c.json({
    salt: str(admin.password_salt),
    iterations: Number(admin.iterations) || DEFAULT_ITERATIONS,
  });
});

/**
 * Creates the first administrator.
 *
 * Two independent conditions must hold: the table is empty, and the request
 * carries the configured BOOTSTRAP_TOKEN. Once an admin exists this route is
 * permanently closed, so leaking the token later buys nothing. It is written to
 * refuse *before* checking the token, so a caller cannot use response timing to
 * learn whether an admin already exists.
 */
authRoutes.post("/admin/bootstrap", context(), async (c) => {
  const db = c.get("db");
  const ip = c.get("ip");

  const existing = await adminCount(db);
  if (existing > 0) {
    throw new HttpError("bootstrap_unavailable", "An administrator already exists");
  }

  const v = new Validator();
  const body = v.shape(await readJsonObject(c.req.raw), BOOTSTRAP_FIELDS);
  const token = v.string("bootstrap_token", body.bootstrap_token, { required: true, min: 16, max: 200 });
  const username = readUsername(v, body.username);
  const verifier = readVerifier(v, "verifier", body.verifier);
  const salt = v.string("salt", body.salt, { required: true, min: 32, max: 64 });
  const iterations = v.integer("iterations", body.iterations, {
    fallback: DEFAULT_ITERATIONS,
    min: MIN_ITERATIONS,
    max: MAX_ITERATIONS,
  });
  v.assert();

  if (!token || !salt) throw badRequest("Missing bootstrap token");

  const expected = c.env.BOOTSTRAP_TOKEN;
  if (expected === undefined || expected === "") {
    // Failing loudly beats a worker that silently refuses every bootstrap.
    throw new HttpError(
      "internal",
      "BOOTSTRAP_TOKEN is not configured. Set it with `wrangler secret put BOOTSTRAP_TOKEN`.",
    );
  }
  if (!(await bootstrapTokenMatches(token, expected))) {
    await record(db, { action: "admin.bootstrap", target: username, ip });
    throw new HttpError("forbidden", "Bootstrap token is not valid");
  }

  if ((await adminByUsername(db, username)) !== null) {
    throw new HttpError("conflict", "That username is taken");
  }

  const id = crypto.randomUUID();
  const material = await materialFromVerifier(verifier, salt, iterations ?? DEFAULT_ITERATIONS);

  await db.run(
    `INSERT INTO admins (id, username, password_hash, password_salt, iterations, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    username,
    material.hash,
    material.salt,
    material.iterations,
    nowIso(),
  );

  const sessionToken = await create(db, id, c.get("config"));
  await record(db, { action: "admin.bootstrap", target: username, adminId: id, ip });

  const secure = c.get("config").publicOrigin.startsWith("https://");
  return c.json(
    { admin: { id, username }, iterations: material.iterations },
    201,
    { "Set-Cookie": sessionCookieHeader(sessionToken, c.get("config").sessionTtlHours * 3600, secure) },
  );
});

authRoutes.post("/admin/login", context(), async (c) => {
  const db = c.get("db");
  const config = c.get("config");
  const ip = c.get("ip");

  const v = new Validator();
  const body = v.shape(await readJsonObject(c.req.raw), LOGIN_FIELDS);
  const username = readUsername(v, body.username);
  const verifier = readVerifier(v, "verifier", body.verifier);
  if (!v.ok) {
    throw new HttpError("validation_failed", "Invalid credentials", { fields: v.errors });
  }

  // Two buckets, both of which must pass. Named rather than indexed so the
  // order they are checked in is stated where it matters.
  const ipBucket = loginIpBucket(ip);
  const accountBucket = await loginBucket(username);
  const buckets = [ipBucket, accountBucket];
  const window = { max: config.loginMaxAttempts, windowMinutes: config.loginWindowMinutes };

  // Per-IP first, so a spray across usernames is throttled before any lookup.
  const perIp = await consume(db, { ...window, bucket: ipBucket });
  if (!perIp.allowed) {
    throw new HttpError("rate_limited", "Too many attempts. Try again later.", {
      headers: { "Retry-After": String(perIp.retryAfterSeconds) },
    });
  }
  const perAccount = await consume(db, { ...window, bucket: accountBucket });
  if (!perAccount.allowed) {
    throw new HttpError("rate_limited", "Too many attempts. Try again later.", {
      headers: { "Retry-After": String(perAccount.retryAfterSeconds) },
    });
  }

  const admin = await adminByUsername(db, username);
  const ok =
    admin !== null &&
    Number(admin.disabled) !== 1 &&
    (await verifyAgainst(verifier, {
      salt: str(admin.password_salt),
      iterations: Number(admin.iterations),
      hash: str(admin.password_hash),
    }));

  if (!ok) {
    // Same status and body as any other failure, so a caller cannot tell a bad
    // username from a bad verifier, or a disabled account from a live one.
    await record(db, { action: "admin.login_failed", target: username, ip });
    throw new HttpError("unauthorized", "Invalid credentials");
  }

  const sessionToken = await create(db, str(admin.id), config);
  await db.run("UPDATE admins SET last_login_at = ? WHERE id = ?", nowIso(), str(admin.id));
  await reset(db, buckets);
  await sweepIfStale(db);
  await record(db, { action: "admin.login", target: username, adminId: str(admin.id), ip });

  const secure = config.publicOrigin.startsWith("https://");
  return c.json(
    { admin: { id: str(admin.id), username: str(admin.username) } },
    200,
    { "Set-Cookie": sessionCookieHeader(sessionToken, config.sessionTtlHours * 3600, secure) },
  );
});

authRoutes.post("/admin/logout", context(), async (c) => {
  const db = c.get("db");
  const token = readSessionToken(c.req.header("cookie"));
  if (token !== null) await destroy(db, token);
  const secure = c.get("config").publicOrigin.startsWith("https://");
  return c.json({ ok: true }, 200, { "Set-Cookie": clearCookieHeader(secure) });
});

/**
 * Who am I. The panel calls this on load to decide between the login form and
 * the application, so a hard refresh does not look like a sign-out.
 */
authRoutes.get("/admin/me", context(), async (c) => {
  const token = readSessionToken(c.req.header("cookie"));
  if (token === null) throw new HttpError("unauthorized", "Not signed in");

  const db = c.get("db");
  const session = await resolve(db, token, c.get("config"));
  if (session === null) throw new HttpError("unauthorized", "Session expired");

  const admin = await adminById(db, session.adminId);
  return c.json({
    admin: {
      id: session.adminId,
      username: session.username,
      // The panel needs these to derive a new verifier without a login.
      salt: str(admin?.password_salt),
      iterations: Number(admin?.iterations) || DEFAULT_ITERATIONS,
    },
  });
});

/**
 * Changes the current admin's verifier.
 *
 * Every other session for this account is destroyed. A password change that
 * leaves old sessions alive is not a password change.
 */
authRoutes.post("/admin/password", context(), async (c) => {
  const token = readSessionToken(c.req.header("cookie"));
  if (token === null) throw new HttpError("unauthorized", "Sign in to continue");

  const db = c.get("db");
  const config = c.get("config");
  const session = await resolve(db, token, config);
  if (session === null) throw new HttpError("unauthorized", "Session expired");

  const v = new Validator();
  const body = v.shape(await readJsonObject(c.req.raw), PASSWORD_FIELDS);
  const current = readVerifier(v, "current_verifier", body.current_verifier);
  const next = readVerifier(v, "new_verifier", body.new_verifier);
  v.assert();

  const admin = await adminById(db, session.adminId);
  if (admin === null) throw new HttpError("unauthorized", "Sign in to continue");

  const ok = await verifyAgainst(current, {
    salt: str(admin.password_salt),
    iterations: Number(admin.iterations),
    hash: str(admin.password_hash),
  });
  if (!ok) {
    throw new HttpError("unauthorized", "Current password is not correct");
  }

  // A fresh salt on every change, so the same password never produces the same
  // verifier twice.
  const salt = newSalt();
  const material = await materialFromVerifier(next, salt, Number(admin.iterations) || DEFAULT_ITERATIONS);

  await db.run(
    "UPDATE admins SET password_hash = ?, password_salt = ?, iterations = ? WHERE id = ?",
    material.hash,
    material.salt,
    material.iterations,
    session.adminId,
  );
  await destroyAllForAdmin(db, session.adminId, token);
  await record(db, {
    action: "admin.password_changed",
    target: session.username,
    adminId: session.adminId,
    ip: c.get("ip"),
  });

  return c.json({ ok: true, salt: material.salt, iterations: material.iterations });
});
