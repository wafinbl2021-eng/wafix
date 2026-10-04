/**
 * Pro entitlement issuance.
 *
 *   GET /api/license
 *
 * One route, and its whole job is to answer a question only the signed-in
 * account may ask: *is this account Pro right now?* It answers by signing that
 * answer, so the client never has to take a boolean from a server on trust.
 *
 * WHY IT ANSWERS FOR EVERY SIGNED-IN ACCOUNT, NOT ONLY FOR PRO ONES
 * ==================================================================
 *
 * The obvious design is to sign an entitlement when a live grant exists and
 * return 404 when one does not. That is worse, and in the direction that matters
 * most: a client holding a still-cached Pro licence would learn nothing from a
 * 404, so an admin who revoked Pro would not take effect on that machine until
 * the cache aged out - up to three days of Pro after the grant was withdrawn.
 *
 * So this route always returns a *signed* answer for a signed-in account, and
 * the answer is `isPro: false` when no live grant exists. The client overwrites
 * its cache with that, and the revocation takes effect on the next refresh
 * instead of the next week. An account that never had Pro gets a signed `false`,
 * which is exactly as useless to an attacker as no response at all.
 *
 * WHAT IS NOT HERE, AND WHY
 * =========================
 *
 * No machine id, no device id, no install id, no hostname, no IP, no user agent,
 * no telemetry, no heartbeat. An entitlement is bound to a Wafi X *account* and
 * to nothing else, so it survives a reinstall and a new machine. There is no
 * column for any such identifier and nothing here that could supply one - which
 * is why binding the licence to a PC is not merely absent but impossible without
 * a schema change.
 *
 * Also absent: any way to grant. An admin who can write `pro_grants` is an admin
 * (see `granted_by`'s foreign key), and the endpoints that do that are Phase 6.
 * This route only reads.
 */

import { Hono } from "hono";

import type { AccountEnv } from "../middleware/account-guard.ts";
import { context, str } from "../middleware/admin-guard.ts";
import type { Db } from "../db.ts";
import { signEntitlement } from "../license-signing.ts";

/**
 * Mounted behind `requireAccount()`, so a route added here cannot be reachable
 * without a session. See the mount in src/index.ts.
 */
export const licenseRoutes = new Hono<AccountEnv>();

/** A live grant, as this route needs to read it. */
interface LiveGrant {
  plan: string;
  expires_at: string | null;
}

/**
 * The account's one live grant, or null.
 *
 * "Live" is enforced here rather than trusted from `pro_grants.revoked_at`
 * being null, because an expired-but-unrevoked grant is not entitlement and the
 * schema deliberately keeps the two states distinct: an expired grant still
 * occupies the single live slot until an admin revokes it, so the unique index
 * cannot be used to find it.
 *
 * `expires_at` is compared in SQL rather than in JavaScript. The column is an
 * ISO-8601 UTC string in exactly the format `strftime('%Y-%m-%dT%H:%M:%SZ',
 * 'now')` produces, which sorts lexicographically in the same order it sorts
 * chronologically - so this is a correct string comparison, not an approximation.
 * Doing it here means one query and one answer.
 */
async function liveGrant(db: Db, accountId: string): Promise<LiveGrant | null> {
  const row = await db.first<{ plan: string; expires_at: string | null }>(
    `SELECT plan, expires_at
       FROM pro_grants
      WHERE account_id = ? AND revoked_at IS NULL`,
    accountId,
  );
  if (row === null) return null;

  const expiresAt = row.expires_at === null ? null : str(row.expires_at);
  if (expiresAt !== null && expiresAt <= new Date().toISOString().replace(/\.\d{3}Z$/, "Z")) {
    // Expired. Treated as no grant, which is what it is.
    return null;
  }
  return { plan: str(row.plan), expires_at: expiresAt };
}

/**
 * The grant's cutoff as Unix seconds, or null for a grant with no end.
 *
 * Returns null rather than a number when the stored value will not parse. A
 * lifetime grant is the common case and must survive untouched; a corrupt date on
 * a bounded grant must not become `NaN` in a signed payload, and must not become
 * a cutoff in the distant past either - both of which would silently deny a
 * grant an admin believes is live.
 */
function expirySeconds(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/**
 * The signed entitlement for whoever is signed in.
 *
 * Never discloses anything about anybody else: no email, no account list, no
 * grant history, no admin identity. The signed payload names one account id,
 * which is the one that asked.
 *
 * A missing signing secret is a 500, not a 403 and not a free plan. It is a
 * deployment mistake, and the client treats a 500 as "could not tell" - leaving
 * whatever it already had - rather than as "not Pro".
 */
licenseRoutes.get("/license", context(), async (c) => {
  const accountId = c.get("account").accountId;
  const grant = await liveGrant(c.get("db"), accountId);

  const entitlement = await signEntitlement(c.env, {
    accountId,
    isPro: grant !== null,
    plan: grant === null ? null : grant.plan,
    expiresAt: grant === null ? null : expirySeconds(grant.expires_at),
  });

  return c.json(entitlement, 200);
});
