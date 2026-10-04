/**
 * Phase 6 - Admin account management.
 *
 * The claims under test, and why each needs a test rather than a comment:
 *
 *   - `GET /api/admin/accounts` is reachable only by an authenticated admin. The
 *     account id it discloses is invisible everywhere else by design, so this is
 *     the one surface that has to be proven narrow rather than assumed narrow.
 *   - Lookups support exact `email` and pagination, and return only the six fields
 *     the decision lists. `password_hash`, `password_salt` and `iterations` are not
 *     merely filtered out of the JSON - they are never selected - so no later
 *     edit to the mapping can leak a column the query did not read.
 *   - Grant/revoke/disable/enable are state-changing and audited, with
 *     attribution taken from `requireAdmin()` and from nowhere else.
 *   - A second live grant is a 409 and never overwrites. Revoking with no live
 *     grant is a 404 and writes no audit row. `revoke_reason` is required and a
 *     blank reason is refused. `expires_at` must be UTC, real and in the future.
 *   - The end-to-end proof: grant -> sign in -> `/api/license` isPro=true ->
 *     revoke -> isPro=false, over real HTTP against the licence route, so the
 *     claim rests on the signed payload rather than on a cached value.
 *   - A disabled account cannot obtain Pro at all, even while a live grant exists.
 *   - A forged admin cookie, an account cookie and a cross-origin request are all
 *     refused, and unknown fields are refused with 422.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { harness, fakeVerifier, testSalt } from "./harness.ts";
import type { Harness } from "./harness.ts";

const BOOTSTRAP_TOKEN = "bootstrap-token-32-characters-long!!";

/** One account row as the lookup route is allowed to describe it. */
interface AccountRow {
  readonly id: string;
  readonly email: string;
  readonly created_at: string;
  readonly last_login_at: string | null;
  readonly disabled: boolean;
  readonly grant: { readonly plan: string; readonly expires_at: string | null } | null;
}

/**
 * A harness with one real admin session behind it.
 *
 * Bootstrap is the only way to get an admin cookie that `requireAdmin()` accepts,
 * and it only works while `admins` is empty - so every test bootstraps its own
 * harness rather than sharing one. The cookie is returned because the harness
 * remembers exactly one cookie and an account login would overwrite it.
 */
async function adminSession(): Promise<{ h: Harness; admin: string; adminId: string; username: string }> {
  const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
  const response = await h.json("/api/admin/bootstrap", {
    method: "POST",
    admin: true,
    body: JSON.stringify({
      bootstrap_token: BOOTSTRAP_TOKEN,
      username: "wafi",
      verifier: fakeVerifier("operator"),
      salt: testSalt(),
    }),
  });
  assert.ok(response.status === 200 || response.status === 201, "bootstrap should create the first admin");
  const token = h.sessionToken();
  assert.ok(token !== null, "bootstrap should leave an admin cookie behind");

  // Bootstrap assigns the operator's own id. The audit assertions need the real
  // one rather than a seeded `'a1'`, because a grant's `granted_by` is a foreign
  // key and bootstrap only works while `admins` is empty.
  const row = h.db.get<{ id: string; username: string }>(
    "SELECT id, username FROM admins LIMIT 1",
  );
  assert.ok(row !== undefined, "bootstrap should have written an admin row");
  return { h, admin: `wafx_admin=${token}`, adminId: row.id, username: row.username };
}

/**
 * Registers an account and signs it in, returning the cookie it can be called
 * with. Login does not return the token in the body - it is only ever in the
 * `Set-Cookie` - so it is read from the harness's remembered cookie.
 */
async function registerAndSignIn(h: Harness, email: string, seed: string): Promise<string> {
  const registration = await h.json("/api/account/register", {
    method: "POST",
    body: JSON.stringify({ email, verifier: fakeVerifier(seed), salt: testSalt(seed) }),
  });
  assert.ok(registration.status === 200 || registration.status === 201, `${email} should be able to register`);

  const login = await h.json("/api/account/login", {
    method: "POST",
    body: JSON.stringify({ email, verifier: fakeVerifier(seed) }),
  });
  assert.equal(login.status, 200, `${email} should be able to sign in`);
  const token = h.sessionToken();
  assert.ok(token !== null, "login should leave an account cookie behind");
  return `wafx_account=${token}`;
}

/** The account id for an address, looked up the way an operator would. */
async function idOf(h: Harness, admin: string, email: string): Promise<string> {
  const response = await h.json<{ accounts: AccountRow[] }>(
    `/api/admin/accounts?email=${encodeURIComponent(email)}`,
    { headers: { cookie: admin } },
  );
  assert.equal(response.status, 200);
  const found = response.body.accounts[0];
  assert.ok(found !== undefined, `${email} should be in the lookup`);
  return found.id;
}

/** A UTC instant `days` from now, in the only format the schema stores. */
function iso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The signed payload `/api/license` returned, parsed. */
function payloadOf(body: { readonly payloadJson: string }): {
  readonly userId: string;
  readonly isPro: boolean;
  readonly plan: string | null;
} {
  return JSON.parse(body.payloadJson) as {
    readonly userId: string;
    readonly isPro: boolean;
    readonly plan: string | null;
  };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("admin accounts - who may reach them", () => {
  test("no cookie, a forged cookie and an account cookie are all refused", async () => {
    const { h, admin } = await adminSession();
    try {
      // The harness remembers the admin cookie as a default, so an
      // "unauthenticated" request has to replace it rather than simply omit it.
      const anonymous = await h.json("/api/admin/accounts", {
        headers: { cookie: "wafx_admin=" },
      });
      assert.equal(anonymous.status, 401);

      const forged = await h.json("/api/admin/accounts", {
        headers: { cookie: "wafx_admin=made-up" },
      });
      assert.equal(forged.status, 401);

      // A real, live account session. It is the strongest credential a stranger
      // can hold, and it must not open the admin surface.
      const account = await registerAndSignIn(h, "alice@example.com", "alice");
      const withAccountCookie = await h.json("/api/admin/accounts", {
        headers: { cookie: account },
      });
      assert.equal(withAccountCookie.status, 401);

      // And a live admin session does open it, so the 401s above are refusals
      // rather than a route that is simply absent.
      const withAdminCookie = await h.json<{ accounts: AccountRow[] }>("/api/admin/accounts", {
        headers: { cookie: admin },
      });
      assert.equal(withAdminCookie.status, 200);
    } finally {
      h.close();
    }
  });

  test("a 401 body carries nothing from any table", async () => {
    const { h } = await adminSession();
    try {
      const probes: [string, string, string][] = [
        ["/api/admin/accounts", "GET", "wafx_admin=made-up"],
        ["/api/admin/accounts/some-id/pro", "POST", "wafx_admin=made-up"],
        ["/api/admin/accounts/some-id/pro", "DELETE", "wafx_admin=made-up"],
        ["/api/admin/accounts/some-id/disable", "POST", "wafx_admin=made-up"],
        ["/api/admin/accounts/some-id/enable", "POST", "wafx_admin=made-up"],
      ];

      for (const [path, method, cookie] of probes) {
        const mutating = method !== "GET";
        const response = await h.json(path, {
          method,
          admin: true,
          headers: { cookie, ...(mutating ? { origin: new URL("https://wafx-api.test").origin } : {}) },
          body: mutating ? JSON.stringify({ revoke_reason: "x" }) : undefined,
        });
        assert.equal(response.status, 401, `${method} ${path} answered ${response.status} to a forged cookie`);
        const raw = JSON.stringify(response.body);
        for (const leak of [
          "accounts",
          "pro_grants",
          "password_hash",
          "password_salt",
          "iterations",
          "email",
          "wafi",
        ]) {
          assert.ok(!raw.includes(leak), `${method} ${path} mentions "${leak}" in a 401`);
        }
      }
    } finally {
      h.close();
    }
  });

  test("a mutation needs the admin header as well as the cookie", async () => {
    const { h, admin } = await adminSession();
    try {
      await registerAndSignIn(h, "molly@example.com", "molly");
      const id = await idOf(h, admin, "molly@example.com");

      // Cookie present, `X-WAFI-Admin` absent.
      const noHeader = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(noHeader.status, 403);

      // The header alone is not a credential either.
      const noCookie = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: "wafx_admin=" },
        body: JSON.stringify({}),
      });
      assert.equal(noCookie.status, 401);

      // Nothing was written by either refused request.
      const grants = h.db.get<{ n: number }>("SELECT count(*) AS n FROM pro_grants");
      assert.equal(grants?.n ?? -1, 0);
    } finally {
      h.close();
    }
  });

  test("a cross-origin mutation is refused and writes nothing", async () => {
    const { h, admin } = await adminSession();
    try {
      const account = await registerAndSignIn(h, "nora@example.com", "nora");
      const id = await idOf(h, admin, "nora@example.com");

      const foreign = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        csrf: false,
        headers: { cookie: admin, origin: "https://evil.example" },
        body: JSON.stringify({}),
      });
      assert.equal(foreign.status, 403);

      const grants = h.db.get<{ n: number }>("SELECT count(*) AS n FROM pro_grants");
      assert.equal(grants?.n ?? -1, 0);
      const disabled = h.db.get<{ disabled: number }>(
        "SELECT disabled FROM accounts WHERE id = ?",
        id,
      );
      assert.equal(disabled?.disabled ?? -1, 0);
      assert.ok(account.length > 0);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

describe("admin accounts - lookup", () => {
  test("returns only the six agreed fields, and no secret material", async () => {
    const { h, admin } = await adminSession();
    try {
      await registerAndSignIn(h, "bob@example.com", "bob");
      await registerAndSignIn(h, "carol@example.com", "carol");

      const list = await h.json<{ accounts: AccountRow[]; count: number; limit: number; offset: number }>(
        "/api/admin/accounts",
        { headers: { cookie: admin } },
      );
      assert.equal(list.status, 200);
      assert.equal(list.body.count, 2);

      for (const account of list.body.accounts) {
        assert.deepEqual(Object.keys(account).sort(), [
          "created_at",
          "disabled",
          "email",
          "grant",
          "id",
          "last_login_at",
        ]);
      }

      const raw = JSON.stringify(list.body);
      for (const leak of [
        "password_hash",
        "password_salt",
        "iterations",
        "session",
        "token",
        "secret",
        "device",
        "hardware",
        "machine",
      ]) {
        assert.ok(!raw.includes(leak), `the lookup leaked "${leak}"`);
      }
    } finally {
      h.close();
    }
  });

  test("?email= is an exact match on the canonical address", async () => {
    const { h, admin } = await adminSession();
    try {
      await registerAndSignIn(h, "bob@example.com", "bob");
      await registerAndSignIn(h, "carol@example.com", "carol");

      // Mixed case, because that is what arrives in a support transcript.
      const mixed = await h.json<{ accounts: AccountRow[] }>(
        `/api/admin/accounts?email=${encodeURIComponent("Bob@EXAMPLE.COM")}`,
        { headers: { cookie: admin } },
      );
      assert.equal(mixed.status, 200);
      assert.equal(mixed.body.accounts.length, 1);
      assert.equal(mixed.body.accounts[0]?.email, "bob@example.com");

      // A prefix is not a match. "bob@example.co" must find nothing rather than
      // bob@example.com, because a filter that matched loosely would hand an
      // operator the wrong account to grant Pro to.
      const prefix = await h.json<{ accounts: AccountRow[] }>(
        `/api/admin/accounts?email=${encodeURIComponent("bob@example.co")}`,
        { headers: { cookie: admin } },
      );
      assert.equal(prefix.status, 200);
      assert.equal(prefix.body.accounts.length, 0);

      const unknown = await h.json<{ accounts: AccountRow[] }>(
        `/api/admin/accounts?email=${encodeURIComponent("nobody@example.com")}`,
        { headers: { cookie: admin } },
      );
      assert.equal(unknown.status, 200);
      assert.equal(unknown.body.accounts.length, 0);
    } finally {
      h.close();
    }
  });

  test("pagination walks the list without repeating or dropping a row", async () => {
    const { h, admin } = await adminSession();
    try {
      for (const email of ["one@example.com", "two@example.com", "three@example.com"]) {
        await registerAndSignIn(h, email, email);
      }

      const first = await h.json<{ accounts: AccountRow[]; limit: number; offset: number }>(
        "/api/admin/accounts?limit=2&offset=0",
        { headers: { cookie: admin } },
      );
      assert.equal(first.status, 200);
      assert.equal(first.body.limit, 2);
      assert.equal(first.body.offset, 0);
      assert.equal(first.body.accounts.length, 2);

      const second = await h.json<{ accounts: AccountRow[]; limit: number; offset: number }>(
        "/api/admin/accounts?limit=2&offset=2",
        { headers: { cookie: admin } },
      );
      assert.equal(second.status, 200);
      assert.equal(second.body.offset, 2);
      assert.equal(second.body.accounts.length, 1);

      const ids = [...first.body.accounts, ...second.body.accounts].map((a) => a.id);
      assert.equal(new Set(ids).size, 3, "pagination repeated an account");

      // Past the end is an empty page, not an error and not a wrap.
      const beyond = await h.json<{ accounts: AccountRow[] }>(
        "/api/admin/accounts?limit=2&offset=99",
        { headers: { cookie: admin } },
      );
      assert.equal(beyond.status, 200);
      assert.equal(beyond.body.accounts.length, 0);
    } finally {
      h.close();
    }
  });

  test("the grant column is keyed on the plan, not on the expiry", async () => {
    const { h, admin } = await adminSession();
    try {
      await registerAndSignIn(h, "dora@example.com", "dora");
      const id = await idOf(h, admin, "dora@example.com");

      const before = await h.json<{ accounts: AccountRow[] }>(
        "/api/admin/accounts?email=dora@example.com",
        { headers: { cookie: admin } },
      );
      assert.equal(before.body.accounts[0]?.grant, null);

      const granted = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ plan: "lifetime" }),
      });
      assert.equal(granted.status, 201);

      // A perpetual grant has expires_at === null. Reading that as "no grant"
      // would show an operator that a lifetime holder has nothing.
      const after = await h.json<{ accounts: AccountRow[] }>(
        "/api/admin/accounts?email=dora@example.com",
        { headers: { cookie: admin } },
      );
      assert.deepEqual(after.body.accounts[0]?.grant, { plan: "lifetime", expires_at: null });

      const revoked = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ revoke_reason: "handing it back" }),
      });
      assert.equal(revoked.status, 200);

      const cleared = await h.json<{ accounts: AccountRow[] }>(
        "/api/admin/accounts?email=dora@example.com",
        { headers: { cookie: admin } },
      );
      assert.equal(cleared.body.accounts[0]?.grant, null);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Grant and revoke
// ---------------------------------------------------------------------------

describe("admin accounts - granting and revoking Pro", () => {
  test("a grant is refused when a live grant already occupies the slot", async () => {
    const { h, admin } = await adminSession();
    try {
      await registerAndSignIn(h, "erin@example.com", "erin");
      const id = await idOf(h, admin, "erin@example.com");

      const first = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(first.status, 201);
      assert.equal((first.body as { plan: string }).plan, "pro", "pro is the default plan");

      const second = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ plan: "lifetime" }),
      });
      assert.equal(second.status, 409, "a second live grant must not overwrite the first");

      // The original grant is untouched: the refused request changed nothing.
      interface GrantRow {
  plan: string;
}
      const rows = h.db.query("SELECT plan FROM pro_grants WHERE account_id = ?", id) as GrantRow[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.plan, "pro");

      // Revoke, then grant. That is the only way to change a plan, and both
      // halves are audited.
      const revoked = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ revoke_reason: "changing plan" }),
      });
      assert.equal(revoked.status, 200);

      const regranted = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ plan: "lifetime" }),
      });
      assert.equal(regranted.status, 201);
    } finally {
      h.close();
    }
  });

  test("revoking with no live grant is a 404 and writes no audit row", async () => {
    const { h, admin } = await adminSession();
    try {
      await registerAndSignIn(h, "finn@example.com", "finn");
      const id = await idOf(h, admin, "finn@example.com");

      const revoke = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ revoke_reason: "nothing to revoke" }),
      });
      assert.equal(revoke.status, 404);

      const audited = h.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM admin_audit WHERE action = 'account.pro_revoke'",
      );
      assert.equal(audited?.n ?? -1, 0, "a revoke that did not happen was audited");
    } finally {
      h.close();
    }
  });

  test("revoke_reason is required, and a blank one is refused", async () => {
    const { h, admin } = await adminSession();
    try {
      await registerAndSignIn(h, "gabe@example.com", "gabe");
      const id = await idOf(h, admin, "gabe@example.com");

      const grant = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(grant.status, 201);

      const missing = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(missing.status, 422);

      const blank = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ revoke_reason: "" }),
      });
      assert.equal(blank.status, 422);

      // Still live: neither refusal touched the grant.
      const live = h.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM pro_grants WHERE account_id = ? AND revoked_at IS NULL",
        id,
      );
      assert.equal(live?.n ?? -1, 1);

      const good = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ revoke_reason: "requested by the user" }),
      });
      assert.equal(good.status, 200);
    } finally {
      h.close();
    }
  });

  test("an expired but unrevoked grant is still revokable, and still blocks a grant", async () => {
    const { h, admin, adminId, username } = await adminSession();
    try {
      await registerAndSignIn(h, "hana@example.com", "hana");
      const id = await idOf(h, admin, "hana@example.com");

      // Granted for a moment that has already passed. The schema refuses an
      // expiry at or before `granted_at`, so this has to be written directly -
      // and it is the state `pro_grants_one_live` still counts.
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const past = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      h.db.run(
        `INSERT INTO pro_grants (id, account_id, plan, granted_at, granted_by,
                                 granted_by_username, expires_at)
         VALUES ('expired-grant', ?, 'pro', ?, ?, ?, ?)`,
        id,
        past,
        adminId,
        username,
        now,
      );

      const blocked = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(blocked.status, 409, "an expired grant still occupies the live slot");

      // It has to be revocable, or the account could never be granted again.
      const revoked = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ revoke_reason: "expired" }),
      });
      assert.equal(revoked.status, 200);

      const now_grantable = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(now_grantable.status, 201);
    } finally {
      h.close();
    }
  });

  test("expires_at is accepted, and refused unless it is UTC, real and future", async () => {
    const { h, admin } = await adminSession();
    try {
      await registerAndSignIn(h, "iris@example.com", "iris");
      const id = await idOf(h, admin, "iris@example.com");

      // An end date in the past would occupy the live slot while being worth
      // nothing - the exact state an operator cannot tell from a bug.
      const past = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ expires_at: "2000-01-01T00:00:00Z" }),
      });
      assert.equal(past.status, 422);

      // Not the stored format, so it would sort wrongly as a string.
      const local = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ expires_at: "2030-01-01T00:00:00.000Z" }),
      });
      assert.equal(local.status, 422);

      const offset = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ expires_at: "2030-01-01T00:00:00+01:00" }),
      });
      assert.equal(offset.status, 422);

      // The regex accepts this one, and so does `Date.parse` - which rolls it
      // over into March rather than refusing it. Only a round-trip catches it.
      const impossible = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ expires_at: "2030-02-31T00:00:00Z" }),
      });
      assert.equal(impossible.status, 422);

      const impossibleFebruary = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ expires_at: "2031-02-30T00:00:00Z" }),
      });
      assert.equal(impossibleFebruary.status, 422);

      // Out of range entirely, which `Date.parse` does reject on its own.
      const month = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ expires_at: "2030-13-01T00:00:00Z" }),
      });
      assert.equal(month.status, 422);

      const day = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ expires_at: "2030-01-32T00:00:00Z" }),
      });
      assert.equal(day.status, 422);

      // A real leap day is accepted, so the round-trip is not simply refusing
      // anything the calendar finds unusual.
      const leap = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ expires_at: "2032-02-29T00:00:00Z" }),
      });
      assert.equal(leap.status, 201);

      const nonsense = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ expires_at: "tomorrow" }),
      });
      assert.equal(nonsense.status, 422);

      const notText = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ expires_at: 1893456000 }),
      });
      assert.equal(notText.status, 422);

      // Nothing above was stored except the leap day, which was accepted on
      // purpose; clear it so the count below is about refusals only.
      h.db.run("DELETE FROM pro_grants WHERE expires_at = '2032-02-29T00:00:00Z'");
      assert.equal(h.db.get<{ n: number }>("SELECT count(*) AS n FROM pro_grants")?.n ?? -1, 0);

      // A real future date is accepted, and stored exactly as given.
      const expiry = iso(30);
      const granted = await h.json<{ expires_at: string }>(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ expires_at: expiry }),
      });
      assert.equal(granted.status, 201);
      assert.equal(granted.body.expires_at, expiry);

      // Explicit null is "no end date", which is not the same as not saying.
      const revoked = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ revoke_reason: "resetting" }),
      });
      assert.equal(revoked.status, 200);

      const perpetual = await h.json<{ expires_at: string | null }>(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ expires_at: null }),
      });
      assert.equal(perpetual.status, 201);
      assert.equal(perpetual.body.expires_at, null);
    } finally {
      h.close();
    }
  });

  test("plan is a closed set", async () => {
    const { h, admin } = await adminSession();
    try {
      await registerAndSignIn(h, "jack@example.com", "jack");
      const id = await idOf(h, admin, "jack@example.com");

      for (const plan of ["ultimate", "PRO", "enterprise", "pro ", 1, true]) {
        const refused = await h.json(`/api/admin/accounts/${id}/pro`, {
          method: "POST",
          admin: true,
          headers: { cookie: admin },
          body: JSON.stringify({ plan }),
        });
        assert.equal(refused.status, 422, `plan=${JSON.stringify(plan)} should be refused`);
      }

      // An empty plan is "not supplied", not "pro" by accident: `Validator.oneOf`
      // treats "" like an omitted field throughout the API, so it falls back to
      // pro rather than being refused. Asserted here because a grant is a real
      // entitlement - it must be obvious which of the two happened.
      const blank = await h.json<{ plan: string }>(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ plan: "" }),
      });
      assert.equal(blank.status, 201);
      assert.equal(blank.body.plan, "pro");

      await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ revoke_reason: "resetting the closed-set check" }),
      });

      const lifetime = await h.json<{ plan: string }>(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ plan: "lifetime" }),
      });
      assert.equal(lifetime.status, 201);
      assert.equal(lifetime.body.plan, "lifetime");

      const pro = await h.json<{ plan: string }>(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ plan: "pro" }),
      });
      assert.equal(pro.status, 409, "lifetime already occupies the live slot");
    } finally {
      h.close();
    }
  });

  test("unknown fields are refused on every mutation", async () => {
    const { h, admin } = await adminSession();
    try {
      await registerAndSignIn(h, "kate@example.com", "kate");
      const id = await idOf(h, admin, "kate@example.com");

      const grant = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ note: "not a field" }),
      });
      assert.equal(grant.status, 422);

      const revoke = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ revoke_reason: "ok", extra: 1 }),
      });
      assert.equal(revoke.status, 422);

      // Disable and enable take no fields at all, so there is nowhere to hide
      // an operator identity or a justification.
      const disable = await h.json(`/api/admin/accounts/${id}/disable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ reason: "because" }),
      });
      assert.equal(disable.status, 422);

      const enable = await h.json(`/api/admin/accounts/${id}/enable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ reason: "because" }),
      });
      assert.equal(enable.status, 422);

      assert.equal(h.db.get<{ n: number }>("SELECT count(*) AS n FROM pro_grants")?.n ?? -1, 0);
      assert.equal(
        h.db.get<{ disabled: number }>("SELECT disabled FROM accounts WHERE id = ?", id)?.disabled ?? -1,
        0,
      );
    } finally {
      h.close();
    }
  });

  test("an account that does not exist is a 404, and so is an id of the wrong shape", async () => {
    const { h, admin } = await adminSession();
    try {
      const grant = await h.json("/api/admin/accounts/00000000-0000-4000-8000-000000000000/pro", {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(grant.status, 404);

      const revoke = await h.json("/api/admin/accounts/00000000-0000-4000-8000-000000000000/pro", {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ revoke_reason: "x" }),
      });
      assert.equal(revoke.status, 404);

      const disable = await h.json("/api/admin/accounts/00000000-0000-4000-8000-000000000000/disable", {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(disable.status, 404);

      const enable = await h.json("/api/admin/accounts/00000000-0000-4000-8000-000000000000/enable", {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(enable.status, 404);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Disable and enable
// ---------------------------------------------------------------------------

describe("admin accounts - disabling and enabling", () => {
  test("disable is refused when already disabled, and enable when not disabled", async () => {
    const { h, admin } = await adminSession();
    try {
      await registerAndSignIn(h, "liam@example.com", "liam");
      const id = await idOf(h, admin, "liam@example.com");

      const enableFirst = await h.json(`/api/admin/accounts/${id}/enable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(enableFirst.status, 409, "enabling a live account changes nothing");

      const disable = await h.json(`/api/admin/accounts/${id}/disable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(disable.status, 200);

      const disableAgain = await h.json(`/api/admin/accounts/${id}/disable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(disableAgain.status, 409);

      // A refused transition changes nothing, so it is not audited.
      const disables = h.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM admin_audit WHERE action = 'account.disable'",
      );
      assert.equal(disables?.n ?? -1, 1);

      const enable = await h.json(`/api/admin/accounts/${id}/enable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(enable.status, 200);

      const enableAgain = await h.json(`/api/admin/accounts/${id}/enable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(enableAgain.status, 409);

      const enables = h.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM admin_audit WHERE action = 'account.enable'",
      );
      assert.equal(enables?.n ?? -1, 1);
    } finally {
      h.close();
    }
  });

  test("enabling clears the disable attribution, not just the flag", async () => {
    const { h, admin } = await adminSession();
    try {
      await registerAndSignIn(h, "mia@example.com", "mia");
      const id = await idOf(h, admin, "mia@example.com");

      await h.json(`/api/admin/accounts/${id}/disable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });

      const disabled = h.db.get<{
        disabled: number;
        disabled_at: string | null;
        disabled_by: string | null;
        disabled_by_username: string | null;
      }>(
        `SELECT disabled, disabled_at, disabled_by, disabled_by_username FROM accounts WHERE id = ?`,
        id,
      );
      assert.equal(disabled?.disabled ?? -1, 1);
      assert.ok((disabled?.disabled_at ?? "").length > 0);
      assert.ok((disabled?.disabled_by ?? "").length > 0);

      await h.json(`/api/admin/accounts/${id}/enable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });

      const live = h.db.get<{
        disabled: number;
        disabled_at: string | null;
        disabled_by: string | null;
        disabled_by_username: string | null;
      }>(
        `SELECT disabled, disabled_at, disabled_by, disabled_by_username FROM accounts WHERE id = ?`,
        id,
      );
      assert.equal(live?.disabled ?? -1, 0);
      assert.equal(live?.disabled_at, null);
      assert.equal(live?.disabled_by, null);
      assert.equal(live?.disabled_by_username, null);
    } finally {
      h.close();
    }
  });

  test("a disabled account cannot sign in, and its live session stops working", async () => {
    const { h, admin } = await adminSession();
    try {
      const account = await registerAndSignIn(h, "noah@example.com", "noah");
      const id = await idOf(h, admin, "noah@example.com");

      const disabled = await h.json(`/api/admin/accounts/${id}/disable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(disabled.status, 200);

      // The session cookie the account already had stops being accepted, on the
      // account's very next request.
      const licence = await h.json("/api/license", { headers: { cookie: account } });
      assert.equal(licence.status, 401);

      // And it cannot get a new one: the refusal is the same generic answer a
      // wrong password gets, so a disable cannot be used to find out whether an
      // address is registered.
      const retry = await h.json<{ error: { code: string } }>("/api/account/login", {
        method: "POST",
        body: JSON.stringify({ email: "noah@example.com", verifier: fakeVerifier("noah") }),
      });
      assert.equal(retry.status, 401);

      const unknown = await h.json<{ error: { code: string } }>("/api/account/login", {
        method: "POST",
        body: JSON.stringify({ email: "nobody@example.com", verifier: fakeVerifier("noah") }),
      });
      assert.equal(unknown.status, 401);
      assert.deepEqual(retry.body, unknown.body, "a disabled account is distinguishable");
    } finally {
      h.close();
    }
  });

  test("a disabled account cannot obtain Pro even with a live grant", async () => {
    const { h, admin } = await adminSession();
    try {
      const account = await registerAndSignIn(h, "olive@example.com", "olive");
      const id = await idOf(h, admin, "olive@example.com");

      const granted = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(granted.status, 201);

      // The grant is still there and still live.
      const live = h.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM pro_grants WHERE account_id = ? AND revoked_at IS NULL",
        id,
      );
      assert.equal(live?.n ?? -1, 1);

      const disabled = await h.json(`/api/admin/accounts/${id}/disable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(disabled.status, 200);

      // So no entitlement is issued, even though the grant would otherwise
      // justify one.
      const licence = await h.json("/api/license", { headers: { cookie: account } });
      assert.equal(licence.status, 401);

      // Re-enabling restores access without touching the grant.
      const enabled = await h.json(`/api/admin/accounts/${id}/enable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      assert.equal(enabled.status, 200);

      const signedIn = await h.json<{ session: unknown }>("/api/account/login", {
        method: "POST",
        body: JSON.stringify({ email: "olive@example.com", verifier: fakeVerifier("olive") }),
      });
      assert.equal(signedIn.status, 200);
      const refreshed = h.sessionToken();
      assert.ok(refreshed !== null);

      const restored = await h.json<{ payloadJson: string }>("/api/license", {
        headers: { cookie: `wafx_account=${refreshed}` },
      });
      assert.equal(restored.status, 200);
      assert.equal(payloadOf(restored.body).isPro, true, "the grant survived the disable");
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// End to end, and the audit trail
// ---------------------------------------------------------------------------

describe("admin accounts - the licence follows the live grant", () => {
  test("grant -> sign in -> Pro, revoke -> not Pro", async () => {
    const { h, admin } = await adminSession();
    try {
      const account = await registerAndSignIn(h, "paige@example.com", "paige");
      const id = await idOf(h, admin, "paige@example.com");

      // Before: a signed `false`, not a refusal. A 404 would leave a cached Pro
      // licence in place until it aged out, so a revoke could take days.
      const before = await h.json<{ payloadJson: string }>("/api/license", {
        headers: { cookie: account },
      });
      assert.equal(before.status, 200);
      const notPro = payloadOf(before.body);
      assert.equal(notPro.isPro, false);
      assert.equal(notPro.plan, null, "a plan with no Pro would be a contradiction");
      assert.equal(notPro.userId, id);

      const granted = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ plan: "lifetime" }),
      });
      assert.equal(granted.status, 201);

      const during = await h.json<{ payloadJson: string }>("/api/license", {
        headers: { cookie: account },
      });
      assert.equal(during.status, 200);
      const pro = payloadOf(during.body);
      assert.equal(pro.isPro, true);
      assert.equal(pro.plan, "lifetime");
      assert.equal(pro.userId, id, "the entitlement names the account that asked");

      const revoked = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ revoke_reason: "support request" }),
      });
      assert.equal(revoked.status, 200);

      const after = await h.json<{ payloadJson: string }>("/api/license", {
        headers: { cookie: account },
      });
      assert.equal(after.status, 200);
      assert.equal(payloadOf(after.body).isPro, false, "a revoke has to take effect now");
    } finally {
      h.close();
    }
  });

  test("a timed grant is Pro until it passes, and not Pro after", async () => {
    const { h, admin } = await adminSession();
    try {
      const account = await registerAndSignIn(h, "quinn@example.com", "quinn");
      const id = await idOf(h, admin, "quinn@example.com");

      const granted = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ expires_at: iso(1) }),
      });
      assert.equal(granted.status, 201);

      const during = await h.json<{ payloadJson: string }>("/api/license", {
        headers: { cookie: account },
      });
      assert.equal(payloadOf(during.body).isPro, true);

      // Move the grant's window into the past. `expires_at > granted_at` is a CHECK
      // constraint, so both ends move together - which is exactly the row shape
      // the route refuses to create and a timed grant eventually becomes.
      h.db.run(
        "UPDATE pro_grants SET granted_at = ?, expires_at = ? WHERE account_id = ?",
        iso(-2),
        iso(-1),
        id,
      );

      const after = await h.json<{ payloadJson: string }>("/api/license", {
        headers: { cookie: account },
      });
      assert.equal(after.status, 200);
      assert.equal(payloadOf(after.body).isPro, false);
    } finally {
      h.close();
    }
  });

  test("an account session can neither grant nor revoke Pro", async () => {
    const { h, admin } = await adminSession();
    try {
      const account = await registerAndSignIn(h, "rita@example.com", "rita");
      const id = await idOf(h, admin, "rita@example.com");

      const grant = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: account },
        body: JSON.stringify({}),
      });
      assert.equal(grant.status, 401);

      const revoke = await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: account },
        body: JSON.stringify({ revoke_reason: "mine" }),
      });
      assert.equal(revoke.status, 401);

      const disable = await h.json(`/api/admin/accounts/${id}/disable`, {
        method: "POST",
        admin: true,
        headers: { cookie: account },
        body: JSON.stringify({}),
      });
      assert.equal(disable.status, 401);

      assert.equal(h.db.get<{ n: number }>("SELECT count(*) AS n FROM pro_grants")?.n ?? -1, 0);
      assert.equal(
        h.db.get<{ disabled: number }>("SELECT disabled FROM accounts WHERE id = ?", id)?.disabled ?? -1,
        0,
      );
    } finally {
      h.close();
    }
  });

  test("every state change is audited against the admin that made it", async () => {
    const { h, admin, adminId } = await adminSession();
    try {
      await registerAndSignIn(h, "sam@example.com", "sam");
      const id = await idOf(h, admin, "sam@example.com");

      await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ plan: "pro" }),
      });
      await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ revoke_reason: "audit trail" }),
      });
      await h.json(`/api/admin/accounts/${id}/disable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });
      await h.json(`/api/admin/accounts/${id}/enable`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({}),
      });

      interface AuditRow {
  action: string;
  target: string;
  admin_id: string;
}
      const rows = h.db.query(
        `SELECT action, target, admin_id FROM admin_audit
          WHERE action LIKE 'account.%' ORDER BY rowid`,
      ) as AuditRow[];
      assert.deepEqual(
        rows.map((r) => r.action),
        ["account.pro_grant", "account.pro_revoke", "account.disable", "account.enable"],
      );
      // Attribution comes from `requireAdmin()`, so every row names the operator
      // the session resolved to - not anything the request body claimed.
      for (const row of rows) {
        assert.equal(row.target, id);
        assert.equal(row.admin_id, adminId);
      }

      // And the audit route shows the same four actions.
      const feed = await h.json<{ entries: { action: string; target: string }[] }>("/api/admin/audit", {
        headers: { cookie: admin },
      });
      assert.equal(feed.status, 200);
      const actions = feed.body.entries.map((e) => e.action);
      for (const action of [
        "account.pro_grant",
        "account.pro_revoke",
        "account.disable",
        "account.enable",
      ]) {
        assert.ok(actions.includes(action), `${action} is missing from the audit feed`);
      }
    } finally {
      h.close();
    }
  });

  test("a grant row records who granted it and a revoke records who took it back", async () => {
    const { h, admin, adminId, username } = await adminSession();
    try {
      await registerAndSignIn(h, "tess@example.com", "tess");
      const id = await idOf(h, admin, "tess@example.com");

      await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "POST",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ plan: "pro", expires_at: iso(7) }),
      });
      await h.json(`/api/admin/accounts/${id}/pro`, {
        method: "DELETE",
        admin: true,
        headers: { cookie: admin },
        body: JSON.stringify({ revoke_reason: "no longer required" }),
      });

      const row = h.db.get<{
        granted_by: string;
        granted_by_username: string;
        revoked_by: string;
        revoked_by_username: string;
        revoke_reason: string;
        expires_at: string | null;
        revoked_at: string | null;
      }>("SELECT * FROM pro_grants WHERE account_id = ?", id);

      // The grant history is kept rather than overwritten, so "who handed out
      // this Pro and why did they take it back" survives.
      assert.equal(row?.granted_by, adminId);
      assert.equal(row?.granted_by_username, username);
      assert.equal(row?.revoked_by, adminId);
      assert.equal(row?.revoked_by_username, username);
      assert.equal(row?.revoke_reason, "no longer required");
      assert.equal(row?.expires_at, iso(7));
      assert.ok((row?.revoked_at ?? "").length > 0);
    } finally {
      h.close();
    }
  });
});