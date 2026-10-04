/**
 * Admin account management: find an account, grant and revoke Pro, disable and
 * enable an account.
 *
 *   GET    /admin/accounts              list, or exact lookup with ?email=
 *   POST   /admin/accounts/:id/pro      grant Pro
 *   DELETE /admin/accounts/:id/pro      revoke Pro
 *   POST   /admin/accounts/:id/disable  disable the account
 *   POST   /admin/accounts/:id/enable   re-enable the account
 *
 * WHY THERE IS A LOOKUP ROUTE
 * ==========================
 *
 * The other four routes take `accounts.id`, which is a server-generated UUID.
 * Phase 5 established that this id is deliberately invisible everywhere else: it
 * is not in `/api/account/me`, not in the login or registration responses, not in
 * the desktop app's IPC, and not in the audit log. That isolation is a security
 * property and it stays - but it means the id exists in exactly one admin-visible
 * place, and without it the four mutation routes are addressable in theory and
 * unusable in practice, with every grant performed by hand against the production
 * database from a `wrangler d1` shell.
 *
 * So this is the one surface that discloses the id, and it discloses it only to an
 * authenticated admin. Nothing here widens what an unauthenticated caller can
 * learn: the route sits behind `requireAdmin()`, so a stranger gets a 401 whose
 * body contains no account data whatsoever.
 *
 * WHAT THIS ROUTE MUST NOT BECOME
 * ===============================
 *
 * This is an operator finding an account, not an account system. It has no power
 * to create, rename, re-password, delete or verify an account, and no way to
 * reach another admin. In particular:
 *
 *   - Nothing here is bound to a machine, a place or a habit. `pro_grants` and
 *     `accounts` have no such column and this file adds none; binding an
 *     entitlement to a device would make it survive neither a reinstall nor a
 *     new PC, which is the opposite of what the Phase 5 licence is for.
 *   - `admin_audit.ip` is recorded for every action here, as it is for every other
 *     admin action in this Worker. That is an operator audit trail which predates
 *     accounts and is joined to no account row. It is not account data and it is
 *     never returned to anybody by this file.
 *
 * WHY DISABLE NEEDS NO SESSION HANDLING
 * =====================================
 *
 * Disabling writes `accounts.disabled` and nothing else. No session is deleted,
 * no token is revoked and no other table is touched, because none of that is
 * needed: `account-session.resolve()` re-reads `disabled` from `accounts` on
 * every single request and destroys the session row when it finds 1. So a disable
 * takes effect on the account's very next request, and `account-auth`'s login
 * already refuses a disabled account with the same generic answer it gives a
 * wrong password - which is why disabling cannot be used to discover whether an
 * address is registered.
 */

import { Hono } from "hono";
import type { Context } from "hono";

import type { AdminEnv } from "../middleware/admin-guard.ts";
import { flag, num, str } from "../middleware/admin-guard.ts";
import { HttpError, conflict, notFound } from "../errors.ts";
import { Validator } from "../validate.ts";
import { nowIso } from "../db.ts";
import { normaliseEmail } from "../account-session.ts";
import { record } from "../audit.ts";
import { pick, readJsonObject } from "./body.ts";

export const accountAdminRoutes = new Hono<AdminEnv>();

/** The two plans Wafi X 1.0.0 can actually produce. See migrations/0003. */
const PLANS = ["pro", "lifetime"] as const;

/** Fields `POST /:id/pro` accepts. Anything else is a 422. */
const GRANT_FIELDS = ["plan", "expires_at"] as const;
/** Fields `DELETE /:id/pro` accepts. Anything else is a 422. */
const REVOKE_FIELDS = ["revoke_reason"] as const;
/**
 * Disable and enable take no fields at all.
 *
 * An empty allowlist is the strictest shape there is: every key a caller sends is
 * refused by `shape`. There is deliberately no `reason` on a disable - the
 * attribution columns on `accounts` already record who and when, and an
 * operator-supplied justification is free text that would then need its own
 * retention story.
 */
const NO_FIELDS = [] as const;

const REASON_MAX = 200;

/**
 * The exact timestamp format every column in this schema stores.
 *
 * Enforced rather than assumed. `expires_at` is compared against `now` as a
 * *string* - `license.ts` relies on the format sorting lexicographically in
 * chronological order - so a stored `"2026-10-01T00:00:00.000Z"` or a local-time
 * `"2026-10-01 00:00:00"` would sort wrongly and quietly shorten or extend the
 * grant. Rejecting anything else at the door is cheaper than discovering it
 * later.
 */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Pagination bounds. The ceiling exists so one request cannot read the table. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Reads the body as an object and asserts only known keys are present.
 *
 * Identical in purpose to the helper in `admin-catalog.ts`: `shape` runs before
 * any field is read, so a payload carrying an unrecognised key is refused on that
 * basis alone and nothing downstream has to remember to check.
 */
async function body(c: Context<AdminEnv>, allowed: readonly string[]) {
  const v = new Validator();
  const input = v.shape(await readJsonObject(c.req.raw), allowed);
  v.assert();
  return { v, input };
}

/**
 * The account id from the path, checked for shape only.
 *
 * The shape check bounds the value that reaches the audit row and the SQL; it
 * deliberately does not establish that the account exists, because "this id is
 * not an account" and "this id is not an account you can see" must not be
 * distinguishable. Both are answered by the same 404 below.
 */
function accountIdFrom(v: Validator, c: Context<AdminEnv>): string {
  const id = v.string("id", c.req.param("id"), { required: true, max: 64 });
  if (id === undefined) {
    v.assert();
    return "";
  }
  return id;
}

/**
 * Reads `expires_at`, where three states have to stay distinct.
 *
 *   not sent   the admin did not say - perpetual, the schema's own meaning for NULL
 *   null       the admin explicitly said "no end date"
 *   a value    an end date, which must be real, UTC and still in the future
 *
 * An end date in the past is refused rather than stored. Storing it would produce
 * a grant that looks live to `pro_grants_one_live` and is worth nothing to
 * `license.ts`, which is exactly the state an operator cannot tell apart from a
 * bug - and it would occupy the single live slot, so the next grant would 409 and
 * there would be no obvious reason why.
 */
function readExpiry(
  v: Validator,
  field: string,
  value: unknown,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value !== "string") {
    v.note(field, "Must be text");
    return undefined;
  }
  const out = value.trim();
  if (!UTC_INSTANT.test(out)) {
    v.note(field, "Use a UTC timestamp such as 2026-10-01T00:00:00Z");
    return undefined;
  }
  // The regex is happy with 2030-02-31, and so - less obviously - is `Date.parse`,
  // which rolls an impossible February day over into March rather than returning
  // NaN. So neither check alone is enough: `Date.parse` rejects a month or day
  // out of range entirely (13, 32), and the round-trip below rejects the ones it
  // silently corrects. Formatting the parsed instant back to the same shape and
  // requiring it to equal the input catches exactly the dates that were shifted.
  const ms = Date.parse(out);
  if (Number.isNaN(ms)) {
    v.note(field, "Not a valid date");
    return undefined;
  }
  if (new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") !== out) {
    v.note(field, "Not a date that exists");
    return undefined;
  }
  if (ms <= Date.now()) {
    v.note(field, "Must be a date in the future");
    return undefined;
  }
  return out;
}

/** The authenticated operator. Never anything from a request body. */
function operator(c: Context<AdminEnv>): { adminId: string; username: string } {
  const admin = c.get("admin");
  return { adminId: admin.adminId, username: admin.username };
}

/** 404 unless the account exists. Used before any write, so nothing dangles. */
async function requireAccount(db: AdminEnv["Variables"]["db"], id: string): Promise<void> {
  const row = await db.first<{ id: string }>("SELECT id FROM accounts WHERE id = ?", id);
  if (row === null) throw notFound("Account");
}

/**
 * The grant currently occupying the account's single live slot, or null.
 *
 * "Occupying the live slot" is `revoked_at IS NULL` and nothing else. An expired
 * but unrevoked grant still occupies it - `pro_grants_one_live` counts it - which
 * is why this cannot be answered by asking whether the grant is worth anything.
 */
async function liveSlotGrant(
  db: AdminEnv["Variables"]["db"],
  accountId: string,
): Promise<{ id: string; plan: string; expires_at: string | null } | null> {
  const row = await db.first<{ id: string; plan: string; expires_at: string | null }>(
    "SELECT id, plan, expires_at FROM pro_grants WHERE account_id = ? AND revoked_at IS NULL",
    accountId,
  );
  if (row === null) return null;
  return {
    id: str(row.id),
    plan: str(row.plan),
    expires_at: row.expires_at === null ? null : str(row.expires_at),
  };
}

/**
 * Turns a constraint violation into a readable error.
 *
 * The driver's message is logged, never returned: it embeds the SQL, and the SQL
 * embeds what was submitted. `UNIQUE` on `pro_grants` means one of two things -
 * a second live grant, or a genuine race between two admins - and both are the
 * same answer to the caller.
 */
function writeFailure(error: unknown, what: string, id: string): HttpError {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`admin write failed for ${what} ${id}: ${detail}`);
  if (/UNIQUE constraint failed/i.test(detail)) {
    return conflict("That account already has a Pro grant");
  }
  if (/CHECK constraint failed/i.test(detail)) {
    return new HttpError("validation_failed", "That value is not allowed");
  }
  if (/FOREIGN KEY constraint failed/i.test(detail)) {
    return new HttpError("validation_failed", "That references something that does not exist");
  }
  return new HttpError("internal", "The change could not be saved");
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Lists accounts, newest first, or looks one up by exact address.
 *
 * Six fields per account, and the set is the point. `password_hash`,
 * `password_salt` and `iterations` are what an attacker who reaches this route
 * would actually want, so they are not selected at all - not filtered out of the
 * result, absent from the query. That is stronger than omitting them from the
 * JSON, because a later edit that adds them to the mapping cannot leak a column
 * that was never read.
 *
 * `?email=` is an exact match on the canonical stored form, run through
 * `normaliseEmail` so an operator pasting `Ada@Example.com` from a support
 * transcript finds the row registered as `ada@example.com`. `account-session.ts`
 * requires every lookup to go through that function, and this is a lookup.
 *
 * Unknown query parameters are ignored rather than honoured - `pick` drops them,
 * so nothing here can be driven by a parameter nobody wrote a validator for.
 */
accountAdminRoutes.get("/admin/accounts", async (c) => {
  const db = c.get("db");
  const query = pick(c.req.query(), ["email", "limit", "offset"] as const);

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(query.offset ?? 0) || 0);

  let email: string | undefined;
  if (query.email !== undefined) {
    const probe = new Validator();
    const normalised = normaliseEmail(probe.string("email", query.email, { required: true, max: 254 }) ?? "");
    // Only the length was checked above; an operator typing nonsense into a
    // filter wants an empty list, not a validation error about somebody else's
    // address.
    if (!probe.ok) return c.json({ accounts: [], count: 0, limit, offset });
    email = normalised;
  }

  // The LEFT JOIN cannot multiply rows: `pro_grants_one_live` is unique over
  // `(account_id) WHERE revoked_at IS NULL`, so at most one `p` row can match.
  const rows = await db.all<{
    id: string;
    email: string;
    created_at: string;
    last_login_at: string | null;
    disabled: number;
    grant_plan: string | null;
    grant_expires_at: string | null;
  }>(
    `SELECT a.id, a.email, a.created_at, a.last_login_at, a.disabled,
            p.plan AS grant_plan, p.expires_at AS grant_expires_at
       FROM accounts a
       LEFT JOIN pro_grants p ON p.account_id = a.id AND p.revoked_at IS NULL
      WHERE (? IS NULL OR a.email = ?)
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?`,
    email ?? null,
    email ?? null,
    limit,
    offset,
  );

  return c.json({
    accounts: rows.map((row) => ({
      id: str(row.id),
      email: str(row.email),
      created_at: str(row.created_at),
      last_login_at: row.last_login_at === null ? null : str(row.last_login_at),
      disabled: flag(row.disabled),
      // Keyed on the plan, never on the expiry: `expires_at` is legitimately
      // NULL for a perpetual grant, so testing it would report a live lifetime
      // grant as no grant at all.
      grant:
        row.grant_plan === null
          ? null
          : {
              plan: str(row.grant_plan),
              expires_at: row.grant_expires_at === null ? null : str(row.grant_expires_at),
            },
    })),
    count: rows.length,
    limit,
    offset: num(offset),
  });
});

// ---------------------------------------------------------------------------
// Pro
// ---------------------------------------------------------------------------

/**
 * Grants Pro.
 *
 * The grant is appended, never overwritten. `pro_grants` keeps one row per grant
 * forever so "granted by whom, on what date, revoked by whom" survives, and
 * `pro_grants_one_live` makes a second live grant impossible at the database
 * level rather than by a check this handler might forget. So a second grant is a
 * 409 and the existing grant stays exactly as it is; the way to change an
 * account's plan is revoke, then grant, and both halves are audited.
 *
 * Attribution is the authenticated admin from `requireAdmin()` and nothing else.
 * `granted_by` has a foreign key to `admins`, so a grant naming an operator who
 * does not exist cannot be stored at all.
 */
accountAdminRoutes.post("/admin/accounts/:id/pro", async (c) => {
  const db = c.get("db");
  const { v, input } = await body(c, GRANT_FIELDS);
  const id = accountIdFrom(v, c);
  const plan = v.oneOf("plan", input.plan, PLANS, { fallback: "pro" });
  const expiresAt = readExpiry(v, "expires_at", input.expires_at);
  v.assert();

  await requireAccount(db, id);
  const existing = await liveSlotGrant(db, id);
  if (existing !== null) {
    throw conflict("That account already has a Pro grant. Revoke it before granting again.");
  }

  const who = operator(c);
  const grantedAt = nowIso();
  const grantId = crypto.randomUUID();
  try {
    await db.run(
      `INSERT INTO pro_grants (id, account_id, plan, granted_at, granted_by,
                               granted_by_username, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      grantId,
      id,
      plan ?? "pro",
      grantedAt,
      who.adminId,
      who.username,
      expiresAt ?? null,
    );
  } catch (error) {
    throw writeFailure(error, "pro grant for", id);
  }

  await record(db, { action: "account.pro_grant", target: id, adminId: who.adminId, ip: c.get("ip") });
  return c.json({ ok: true, account_id: id, grant_id: grantId, plan: plan ?? "pro", expires_at: expiresAt ?? null }, 201);
});

/**
 * Revokes Pro.
 *
 * A reason is required. Not as decoration: "who handed out this Pro and why did
 * they take it back" is the question this table exists to answer, and a revocation
 * recorded with a blank reason answers half of it.
 *
 * Revoking an account with no live grant is a 404 and writes no audit row. The
 * request changed nothing, and an audit log that records operations which did not
 * happen is worse than one that is merely incomplete.
 *
 * An expired but unrevoked grant *is* revokable, and has to be: it still occupies
 * the live slot, so refusing to revoke it would leave the account permanently
 * un-grantable with no way out.
 */
accountAdminRoutes.delete("/admin/accounts/:id/pro", async (c) => {
  const db = c.get("db");
  const { v, input } = await body(c, REVOKE_FIELDS);
  const id = accountIdFrom(v, c);
  const reason = v.string("revoke_reason", input.revoke_reason, { required: true, min: 1, max: REASON_MAX });
  v.assert();

  await requireAccount(db, id);
  const grant = await liveSlotGrant(db, id);
  if (grant === null) throw notFound("Pro grant");

  const who = operator(c);
  const revokedAt = nowIso();
  // Guarded on `revoked_at IS NULL` so a second revoke cannot overwrite the first
  // revoker, even if two admins reach this at the same moment.
  const { changes } = await db.run(
    `UPDATE pro_grants
        SET revoked_at = ?, revoked_by = ?, revoked_by_username = ?, revoke_reason = ?
      WHERE id = ? AND revoked_at IS NULL`,
    revokedAt,
    who.adminId,
    who.username,
    reason ?? "",
    grant.id,
  );
  if (changes === 0) throw notFound("Pro grant");

  await record(db, { action: "account.pro_revoke", target: id, adminId: who.adminId, ip: c.get("ip") });
  return c.json({ ok: true, account_id: id, revoked_at: revokedAt });
});

// ---------------------------------------------------------------------------
// Disable / enable
// ---------------------------------------------------------------------------

/**
 * Disables an account.
 *
 * Writes the flag and the three attribution columns together, in one statement,
 * because `accounts` has CHECK constraints that make the state all-or-nothing in
 * both directions: a row cannot claim to be disabled with nobody responsible for
 * it, nor be live while still carrying a stale disable stamp. Setting them
 * separately would fail one of those constraints on the intermediate write.
 *
 * A second disable is a 409 with no audit row, for the same reason a second
 * revoke is a 404: nothing changed, so nothing is recorded.
 *
 * This does not delete sessions. See the file header for why it does not need to.
 */
accountAdminRoutes.post("/admin/accounts/:id/disable", async (c) => {
  const db = c.get("db");
  const { v } = await body(c, NO_FIELDS);
  const id = accountIdFrom(v, c);
  v.assert();

  await requireAccount(db, id);
  const current = await db.first<{ disabled: number }>(
    "SELECT disabled FROM accounts WHERE id = ?",
    id,
  );
  if (flag(current?.disabled)) throw conflict("That account is already disabled");

  const who = operator(c);
  const disabledAt = nowIso();
  const { changes } = await db.run(
    `UPDATE accounts
        SET disabled = 1, disabled_at = ?, disabled_by = ?, disabled_by_username = ?
      WHERE id = ? AND disabled = 0`,
    disabledAt,
    who.adminId,
    who.username,
    id,
  );
  if (changes === 0) throw conflict("That account is already disabled");

  await record(db, { action: "account.disable", target: id, adminId: who.adminId, ip: c.get("ip") });
  return c.json({ ok: true, account_id: id, disabled: true, disabled_at: disabledAt });
});

/**
 * Re-enables a disabled account.
 *
 * Clears all three attribution columns, not just the flag: the schema forbids a
 * live account from carrying a stale disable stamp, and leaving `disabled_by`
 * behind would both trip that CHECK and read as though the account were still
 * disabled.
 *
 * Re-enabling restores access but does not resurrect sessions - a disable
 * destroyed them, which is the point of a disable. The account signs in again.
 */
accountAdminRoutes.post("/admin/accounts/:id/enable", async (c) => {
  const db = c.get("db");
  const { v } = await body(c, NO_FIELDS);
  const id = accountIdFrom(v, c);
  v.assert();

  await requireAccount(db, id);
  const current = await db.first<{ disabled: number }>(
    "SELECT disabled FROM accounts WHERE id = ?",
    id,
  );
  if (!flag(current?.disabled)) throw conflict("That account is not disabled");

  const who = operator(c);
  const { changes } = await db.run(
    `UPDATE accounts
        SET disabled = 0, disabled_at = NULL, disabled_by = NULL, disabled_by_username = NULL
      WHERE id = ? AND disabled = 1`,
    id,
  );
  if (changes === 0) throw conflict("That account is not disabled");

  await record(db, { action: "account.enable", target: id, adminId: who.adminId, ip: c.get("ip") });
  return c.json({ ok: true, account_id: id, disabled: false });
});