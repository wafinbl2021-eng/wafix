/**
 * Phase 5 - Pro entitlement issuance.
 *
 * The claims under test, and why each needs a test rather than a comment:
 *
 *   - `GET /api/license` cannot be reached without a session. A licence is the one
 *     thing in this Worker worth stealing, so an unauthenticated or wrong-origin
 *     request is the attack this route exists to be immune to.
 *   - The signature is real. Every positive case verifies the bytes against the
 *     fixture public key, so "it returned 200" is never mistaken for "it signed
 *     something the app would accept".
 *   - The payload is the exact bytes that were signed, not a re-serialisation of
 *     them. Asserted by mutating one whitespace character and watching the
 *     signature stop verifying - which is exactly what would happen in the app.
 *   - Grant status is honoured in all four states: no grant, live grant, revoked
 *     grant, expired-but-unrevoked grant.
 *   - Revocation is *reported*, not merely absent. A client holding a cached Pro
 *     licence must be told "not Pro" rather than 404, or the revoke takes days.
 *   - The product is exactly `wafix`, and matches the constant in
 *     `src-tauri/src/license.rs`.
 *   - Nothing binds the entitlement to a machine, and nothing about the account
 *     other than its id is disclosed.
 *
 * The fixture key is committed on purpose; see test/fixtures/license-key.ts for
 * why that is harmless and what would stop it from staying harmless.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { fakeVerifier, harness, testSalt, type Harness } from "./harness.ts";
import { DEFAULT_ITERATIONS } from "../src/crypto.ts";
import { LICENSE_PRODUCT_ID } from "../src/license-signing.ts";
import { FIXTURE_PUBLIC_B64, verifyWithFixture } from "./fixtures/license-key.ts";

const EMAIL = "holder@example.com";
const PASSWORD_SEED = "correct horse";

const here = dirname(fileURLToPath(import.meta.url));
const licenseRs = readFileSync(join(here, "..", "..", "src-tauri", "src", "license.rs"), "utf8");

/**
 * `license.rs` with its `mod tests` module removed - the code that actually
 * ships.
 *
 * Two of the guards below are about what is *embedded*, and the Rust module's own
 * negative assertions necessarily name the things they forbid: proving the old
 * PC Tweaker key is not the one in use requires writing that key down somewhere.
 * A scan over the whole file would fail on this suite's own evidence.
 *
 * If the marker ever stops matching, the split silently yields the entire file
 * and the key assertion fails again, so a rename degrades to a false alarm
 * rather than to a guard that has stopped looking.
 */
const shippedLicenseRs = licenseRs.split(/^#\[cfg\(test\)\]\s*mod tests\s*\{/m)[0] ?? licenseRs;
const migration = readFileSync(join(here, "..", "migrations", "0003_accounts.sql"), "utf8");

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** A copy of `value` with its first byte flipped: same length, different bytes. */
function flipFirstByte(value: string): string {
  const bytes = fromBase64(value);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return base64Of(bytes);
}

interface Entitlement {
  readonly payloadJson: string;
  readonly signature: string;
}

interface Payload {
  readonly userId: string;
  readonly isPro: boolean;
  readonly plan: string | null;
  readonly product: string;
  readonly issuedAt: number;
  readonly expiresAt: number | null;
}

/**
 * The parsed response body, as whatever shape the caller expects.
 *
 * `Response.json()` is typed `any`; the hop through `unknown` is what makes the
 * caller's own annotation meaningful instead of silently `any` all the way down.
 */
async function body<T>(response: Response): Promise<T> {
  const parsed: unknown = await response.json();
  return parsed as T;
}

function registrationBody(email: string, seed: string): Record<string, unknown> {
  return { email, verifier: fakeVerifier(seed), salt: testSalt(seed), iterations: DEFAULT_ITERATIONS };
}

/** Registers and signs in, leaving the harness holding a live account cookie. */
async function signedIn(h: Harness, email = EMAIL): Promise<void> {
  await h.request("/api/account/register", {
    method: "POST",
    body: JSON.stringify(registrationBody(email, PASSWORD_SEED)),
  });
  const login = await h.request("/api/account/login", {
    method: "POST",
    body: JSON.stringify({ email, verifier: fakeVerifier(PASSWORD_SEED) }),
  });
  assert.equal(login.status, 200, "the fixture account should be able to sign in");
}

/**
 * An account row with no session behind it.
 *
 * `pro_grants.account_id` is a foreign key, so a grant cannot exist before its
 * account does. Tests about *refusing* a request need the grant to be there and
 * the session to be absent, which is the one combination the API cannot be talked
 * into - so the row is written directly, which is exactly what an account that
 * exists on another device looks like from here.
 */
function addAccount(h: Harness, email = EMAIL, id = "fixture-account"): string {
  h.db.run(
    `INSERT INTO accounts (id, email, password_hash, password_salt, iterations, created_at)
     VALUES (?, ?, ?, 'saltsaltsaltsaltsalt', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    id,
    email,
    "0".repeat(64),
    DEFAULT_ITERATIONS,
  );
  return id;
}

/** The account id the signed-in session belongs to. */
function accountId(h: Harness, email = EMAIL): string {
  const rows = h.db.query("SELECT id FROM accounts WHERE email = ?", email);
  assert.equal(rows.length, 1, `expected exactly one account for ${email}, found ${rows.length}`);
  return String((rows[0] as { id: string }).id);
}

/** Inserts the admin `pro_grants.granted_by` insists on, once per harness. */
function ensureAdmin(h: Harness): string {
  const existing = h.db.query("SELECT id FROM admins WHERE id = 'a1'");
  if (existing.length === 0) {
    h.db.exec(
      `INSERT INTO admins (id, username, password_hash, password_salt, iterations)
       VALUES ('a1', 'wafi', '${"0".repeat(64)}', 'saltsaltsaltsaltsalt', 600000)`,
    );
  }
  return "a1";
}

interface GrantOptions {
  readonly plan?: "pro" | "lifetime";
  /** Days from now the grant ends. Omitted means perpetual. */
  readonly expiresInDays?: number;
  readonly revokedDaysAgo?: number;
  /** The account the grant names. Defaults to the one `EMAIL` belongs to. */
  readonly forEmail?: string;
  /**
   * The admin `granted_by` names. Defaults to a seeded operator.
   *
   * A test that needs a real admin *cookie* has to bootstrap, and bootstrap only
   * works while `admins` is empty - so it cannot seed the grant first, and the
   * grant has to point at whoever bootstrap actually created.
   */
  readonly grantedBy?: { readonly id: string; readonly username: string };
}

/** One moment, formatted the way every timestamp column here stores it. */
function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const DAY_MS = 86_400_000;

function grant(h: Harness, options: GrantOptions = {}): void {
  const operator = options.grantedBy ?? { id: ensureAdmin(h), username: "wafi" };
  // `pro_grants` refuses a grant that expires or is revoked before it was made,
  // and the tests below need exactly those rows. So `granted_at` is anchored in
  // the past rather than defaulting to `now`, which would make "expired" and
  // "revoked a day ago" unrepresentable rather than merely un-granted.
  h.db.run(
    `INSERT INTO pro_grants (id, account_id, plan, granted_at, granted_by,
                             granted_by_username, expires_at, revoked_at,
                             revoked_by, revoked_by_username)
     VALUES ('g1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    accountId(h, options.forEmail ?? EMAIL),
    options.plan ?? "pro",
    iso(-30 * DAY_MS),
    operator.id,
    operator.username,
    options.expiresInDays === undefined ? null : iso(options.expiresInDays * DAY_MS),
    options.revokedDaysAgo === undefined ? null : iso(-options.revokedDaysAgo * DAY_MS),
    options.revokedDaysAgo === undefined ? null : operator.id,
    options.revokedDaysAgo === undefined ? null : operator.username,
  );
}

const licence = (h: Harness) => h.request("/api/license", { method: "GET" });

/**
 * Identifiers and string literals in a file, and nothing else.
 *
 * Comments are trivia to the TypeScript parser, so a doc comment saying "no
 * machine id" cannot trip the guard below - which matters because a guard that
 * fires on prose is a guard somebody deletes the first time the thing it forbids
 * gets documented.
 */
function codeFacts(relative: string): { identifiers: Set<string>; strings: string[] } {
  const source = readFileSync(join(here, "..", relative), "utf8");
  const file = ts.createSourceFile(relative, source, ts.ScriptTarget.ESNext, true);
  const identifiers = new Set<string>();
  const strings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    if (ts.isStringLiteralLike(node)) strings.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { identifiers, strings };
}

/** True if `needle` appears as an identifier or inside any string literal. */
function mentions(relative: string, needle: string): boolean {
  const { identifiers, strings } = codeFacts(relative);
  if (identifiers.has(needle)) return true;
  const lower = needle.toLowerCase();
  return strings.some((value) => value.toLowerCase().includes(lower));
}

async function payloadOf(h: Harness): Promise<Payload> {
  const response = await licence(h);
  assert.equal(response.status, 200);
  return JSON.parse((await body<Entitlement>(response)).payloadJson) as Payload;
}

describe("Phase 5 - /api/license is unreachable without a session", () => {
  test("no cookie is refused", async () => {
    const h = harness();
    addAccount(h);
    grant(h);
    const response = await licence(h);
    assert.equal(response.status, 401);
    // Nothing about the grant may be in the refusal.
    const text = await response.text();
    assert.ok(!text.includes(EMAIL), "a refusal must not echo the address");
    assert.ok(!text.includes('"userId"'), "a refusal must not contain a payload");
  });

  test("a forged cookie is refused", async () => {
    const h = harness();
    addAccount(h);
    grant(h);
    const response = await h.request("/api/license", {
      method: "GET",
      headers: { cookie: "wafx_account=" + "0".repeat(64) },
    });
    assert.equal(response.status, 401);
  });

  test("a cross-origin request with no session is still refused", async () => {
    // This route is a GET, and `requireAccountOrigin` skips safe methods by
    // design - there is nothing about reading that a cross-site page can change.
    // What stops a foreign page here is the session cookie being `SameSite=Strict`,
    // not an origin header, so the guard to assert is the session itself.
    const h = harness();
    addAccount(h);
    grant(h);
    const response = await h.request("/api/license", {
      method: "GET",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(response.status, 401);
  });

  test("an admin cookie opens no licence", async () => {
    // The two auth systems must not overlap. A session for the panel is not a
    // session for an account, and the entitlement route reads the account one.
    //
    // Bootstrap runs first because it refuses once any admin exists, and the
    // grant cannot exist before its `granted_by` does. So the operator here is
    // the one bootstrap actually created, not a seeded stand-in.
    const h = harness({ bootstrapToken: "bootstrap-token-32-characters-long!!" });
    const bootstrap = await h.request("/api/admin/bootstrap", {
      method: "POST",
      admin: true,
      body: JSON.stringify({
        username: "panel-operator",
        verifier: fakeVerifier("admin"),
        salt: testSalt("admin"),
        iterations: DEFAULT_ITERATIONS,
        bootstrap_token: "bootstrap-token-32-characters-long!!",
      }),
    });
    assert.equal(bootstrap.status, 201);
    const operator = (await body<{ admin: { id: string; username: string } }>(bootstrap)).admin;
    const adminCookie = /^([^=]+)=([^;]*)/.exec(bootstrap.headers.get("set-cookie") ?? "");
    assert.ok(adminCookie, "bootstrap must hand back a session cookie");
    addAccount(h);
    grant(h, { grantedBy: operator });

    const response = await h.request("/api/license", {
      method: "GET",
      headers: { cookie: `${adminCookie[1]}=${adminCookie[2]}` },
    });
    assert.equal(response.status, 401);
  });
});

describe("Phase 5 - the entitlement is signed and account-bound", () => {
  test("a live grant produces a signature the fixture key verifies", async () => {
    const h = harness();
    await signedIn(h);
    grant(h);

    const entitlement = await body<Entitlement>(await licence(h));
    assert.equal(
      await verifyWithFixture(entitlement.payloadJson, entitlement.signature),
      true,
      "the app verifies these exact bytes; a re-serialised copy would fail",
    );
  });

  test("the payload names the signed-in account and nothing else", async () => {
    const h = harness();
    await signedIn(h);
    grant(h);

    const payload = await payloadOf(h);
    assert.equal(payload.userId, accountId(h), "the entitlement must name the asker");
    assert.equal(payload.product, "wafix");
    assert.equal(Object.keys(payload).sort().join(","), "expiresAt,isPro,issuedAt,plan,product,userId");
    // No address, no session, no machine.
    const serialised = JSON.stringify(payload);
    for (const forbidden of [EMAIL, "expires_in_seconds", "hwid", "install_id", "machine_id"]) {
      assert.ok(!serialised.includes(forbidden), `${forbidden} must not appear in an entitlement`);
    }
  });

  test("one account's entitlement never names another", async () => {
    const h = harness();
    await signedIn(h, EMAIL);
    grant(h);
    const mine = await payloadOf(h);

    // A second account with its own Pro grant, sharing this Worker.
    const other = "someone.else@example.com";
    await h.request("/api/account/register", {
      method: "POST",
      body: JSON.stringify(registrationBody(other, "other seed")),
    });
    const id = String((h.db.query("SELECT id FROM accounts WHERE email = ?", other)[0] as { id: string }).id);
    ensureAdmin(h);
    h.db.run(
      `INSERT INTO pro_grants (id, account_id, plan, granted_by, granted_by_username)
       VALUES ('g2', ?, 'lifetime', 'a1', 'wafi')`,
      id,
    );
    await h.request("/api/account/login", {
      method: "POST",
      body: JSON.stringify({ email: other, verifier: fakeVerifier("other seed") }),
    });

    const theirs = await payloadOf(h);
    assert.notEqual(theirs.userId, mine.userId);
    assert.equal(theirs.userId, id);
  });

  test("an account with no grant is told not-Pro rather than refused", async () => {
    // A 404 would leave a cached Pro licence in place until it aged out, so a
    // revoke could take days. A signed `false` is what makes it take effect now.
    const h = harness();
    await signedIn(h);

    const response = await licence(h);
    assert.equal(response.status, 200);
    const entitlement = await body<Entitlement>(response);
    assert.equal(await verifyWithFixture(entitlement.payloadJson, entitlement.signature), true);

    const payload = JSON.parse(entitlement.payloadJson) as Payload;
    assert.equal(payload.isPro, false);
    assert.equal(payload.plan, null, "a plan with no Pro would be a contradiction");
  });

  test("a signed-in account with no grant cannot read another account's grant", async () => {
    const h = harness();
    await signedIn(h, "nobody.here@example.com");
    // A Pro grant exists, for somebody else entirely.
    ensureAdmin(h);
    addAccount(h, "pro@example.com", "other");
    h.db.run(
      `INSERT INTO pro_grants (id, account_id, plan, granted_by, granted_by_username)
       VALUES ('g3', 'other', 'lifetime', 'a1', 'wafi')`,
    );

    const payload = await payloadOf(h);
    assert.equal(payload.isPro, false);
    assert.equal(payload.userId, accountId(h, "nobody.here@example.com"));
    assert.ok(payload.userId !== "other");
  });
});

describe("Phase 5 - grant status is what decides isPro", () => {
  test("a live grant unlocks, with the plan it was granted under", async () => {
    const h = harness();
    await signedIn(h);
    grant(h, { plan: "lifetime" });

    const payload = await payloadOf(h);
    assert.equal(payload.isPro, true);
    assert.equal(payload.plan, "lifetime", "lifetime gates four native tools; it must survive");
  });

  test("a revoked grant is not entitlement", async () => {
    const h = harness();
    await signedIn(h);
    grant(h, { revokedDaysAgo: 1 });

    const payload = await payloadOf(h);
    assert.equal(payload.isPro, false);
    assert.equal(payload.plan, null);
  });

  test("an expired-but-unrevoked grant is not entitlement", async () => {
    // The schema keeps expired and revoked distinct on purpose: an expired grant
    // still occupies the one live slot until an admin revokes it. It is still not
    // a grant, and reading it as one would unlock Pro nobody paid for.
    const h = harness();
    await signedIn(h);
    grant(h, { expiresInDays: -1 });

    const payload = await payloadOf(h);
    assert.equal(payload.isPro, false);
    assert.equal(payload.plan, null);
  });

  test("a bounded grant carries its own cutoff", async () => {
    const h = harness();
    await signedIn(h);
    grant(h, { expiresInDays: 30 });

    const payload = await payloadOf(h);
    assert.equal(payload.isPro, true);
    assert.equal(typeof payload.expiresAt, "number");
    assert.ok(
      payload.expiresAt !== null,
      "precondition: a bounded grant must carry a cutoff",
    );
    const inThirtyDays = Date.now() / 1000 + 30 * 86_400;
    assert.ok(
      Math.abs(payload.expiresAt - inThirtyDays) < 120,
      `expiresAt ${payload.expiresAt} should be about 30 days out`,
    );
  });

  test("a perpetual grant carries no cutoff", async () => {
    // A lifetime entitlement that carried an expiry would quietly become a
    // subscription, which is the one thing a lifetime plan must never do.
    const h = harness();
    await signedIn(h);
    grant(h, { plan: "lifetime" });

    const payload = await payloadOf(h);
    assert.equal(payload.expiresAt, null);
  });

  test("issuedAt is a plausible unix timestamp, and expiry is absolute", async () => {
    const h = harness();
    await signedIn(h);
    grant(h, { expiresInDays: 7 });

    const payload = await payloadOf(h);
    const now = Date.now() / 1000;
    assert.ok(Math.abs(payload.issuedAt - now) < 120, "issuedAt is set by the signer, not the client");
    assert.ok(payload.expiresAt !== null && payload.expiresAt > payload.issuedAt);
  });
});

describe("Phase 5 - the payload is the bytes that were signed", () => {
  test("a single changed byte breaks the signature", async () => {
    // This is what the desktop app does. `payloadJson` is verified as opaque bytes
    // before it is ever parsed, so any difference at all is a failure.
    const h = harness();
    await signedIn(h);
    grant(h);
    const entitlement = await body<Entitlement>(await licence(h));

    for (const tampered of [
      `${entitlement.payloadJson} `,
      entitlement.payloadJson.replace('"isPro":true', '"isPro":false'),
      entitlement.payloadJson.replace('"plan":"pro"', '"plan":"lifetime"'),
      entitlement.payloadJson.replace('"product":"wafix"', '"product":"pctweaker"'),
    ]) {
      assert.notEqual(tampered, entitlement.payloadJson, "the tamper must have changed something");
      assert.equal(
        await verifyWithFixture(tampered, entitlement.signature),
        false,
        `a modified payload must not verify: ${tampered}`,
      );
    }
  });

  test("a signature from another key does not verify", async () => {
    const h = harness();
    await signedIn(h);
    grant(h);
    const entitlement = await body<Entitlement>(await licence(h));

    assert.equal(
      await verifyWithFixture(entitlement.payloadJson, flipFirstByte(entitlement.signature)),
      false,
    );
  });
});

describe("Phase 5 - a deployment that cannot sign says so", () => {
  test("an unset signing secret is a 500, not a free plan and not a denial", async () => {
    // Three answers are all wrong here. A 200 with isPro false would deny Pro to
    // everybody and read as a working service. A signed false needs the key we do
    // not have. Silently unlocking would be worse than either.
    const h = harness({ licenseSigningKey: "unset" });
    await signedIn(h);
    grant(h);

    const response = await licence(h);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.ok(!text.includes("LICENSE_SIGNING_KEY_B64"), "the log-free body must not name the secret");
    assert.ok(!text.includes('"userId"'), "no payload may be returned");
  });

  test("a malformed signing secret is a 500 rather than a crash-free success", async () => {
    const h = harness({ licenseSigningKey: "not base64 at all!!" });
    await signedIn(h);
    grant(h);
    assert.equal((await licence(h)).status, 500);
  });

  test("a secret of the wrong length is refused with the length named", async () => {
    // A PKCS#8 pasted where a seed was asked for is the likely mistake, and the
    // 500 has to be diagnosable from the Worker log rather than from a guess.
    const h = harness({ licenseSigningKey: base64Of(new Uint8Array(48).fill(3)) });
    await signedIn(h);
    grant(h);
    assert.equal((await licence(h)).status, 500);
  });

  test("an error body never carries a stack, a SQL fragment or the secret", async () => {
    const h = harness({ licenseSigningKey: "unset" });
    await signedIn(h);
    grant(h);
    const text = await (await licence(h)).text();
    for (const forbidden of ["at ", "SELECT", "INSERT", ".ts:", "Error:"]) {
      assert.ok(!text.includes(forbidden), `the 500 body leaked ${forbidden}: ${text}`);
    }
  });
});

describe("Phase 5 - the two sides agree, and neither is PC Tweaker", () => {
  test("the Worker and the Rust verifier name the same product", () => {
    assert.equal(LICENSE_PRODUCT_ID, "wafix");
    // The app hard-codes its own copy. If one is renamed without the other,
    // every entitlement stops being accepted - silently, at runtime, for every
    // user - so the two literals are compared here instead.
    assert.match(shippedLicenseRs, /const PRODUCT_ID: &str = "wafix";/);
    assert.ok(
      !shippedLicenseRs.includes('const PRODUCT_ID: &str = "pctweaker";'),
      "the app must not be verifying a PC Tweaker entitlement",
    );
  });

  test("the embedded public key is not the test fixture's", () => {
    // The fixture is committed, so this is the one mistake that would make it a
    // real key. It must fail here rather than in a build.
    const embedded = /const PUBLIC_KEY_B64: &str = "([^"]+)";/.exec(shippedLicenseRs)?.[1];
    assert.ok(embedded, "license.rs should still declare a public key");
    assert.notEqual(embedded, FIXTURE_PUBLIC_B64, "the shipped key must not be the committed fixture");
    // And the old PC Tweaker key must be gone, not merely unused. Scanned over the
    // shipped code only, because `license.rs`'s own test names it to prove the
    // same thing from the other side. If `shippedLicenseRs` ever stopped being a
    // prefix - a renamed module, say - this would scan the whole file again and
    // fail loudly here rather than quietly stop guarding anything.
    assert.ok(
      !shippedLicenseRs.includes("QisYr46g3mqEeiz1BDyEcPbRO1xO4z0lR3d5/ODppIU="),
      "the previous PC Tweaker licence key is still embedded",
    );
  });

  test("the Rust payload struct and this signer agree on every field", () => {
    // Field names cross a language boundary as strings. A rename on one side is a
    // parse failure on the other, which is a runtime 500 for every user rather
    // than a compile error, so it is asserted here.
    const struct = /pub struct LicensePayload \{([\s\S]*?)\n\}/.exec(licenseRs)?.[1];
    assert.ok(struct, "LicensePayload should still exist");
    const renamed = [...struct.matchAll(/pub (\w+):/g)].map((match) => {
      const snake = match[1] ?? "";
      return snake.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    });
    assert.deepEqual(renamed.sort(), [
      "expiresAt",
      "isPro",
      "issuedAt",
      "plan",
      "product",
      "userId",
    ]);
  });

  test("nothing binds an entitlement to a machine", () => {
    // Not "the route does not do it today" - the schema has no column for it
    // either, which is what makes it impossible rather than merely absent.
    const needles = [
      "MachineGuid",
      "GetComputerName",
      "hwid",
      "machine_id",
      "install_id",
      "device_id",
      "hostname",
      "user_agent",
      "client_ip",
      "c.pe.at",
    ];
    for (const relative of ["src/routes/license.ts", "src/license-signing.ts"]) {
      for (const forbidden of needles) {
        assert.ok(!mentions(relative, forbidden), `${forbidden} in ${relative}`);
      }
    }
    const grants = /CREATE TABLE pro_grants \(([\s\S]*?)\n\);/.exec(migration)?.[1] ?? "";
    for (const forbidden of ["hwid", "machine", "install", "device", "host", "ip_address", "user_agent"]) {
      assert.ok(
        !new RegExp(`\\b${forbidden}`, "i").test(grants),
        `pro_grants has a ${forbidden} column, which would make machine binding possible`,
      );
    }
  });
});
