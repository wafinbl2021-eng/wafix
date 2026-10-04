/**
 * Phase 2 - account authentication tests.
 *
 * The claims under test, and why each needs a test rather than a comment:
 *
 *   - Registration cannot tell a caller whether an address is taken. Asserted by
 *     comparing the *whole response* across the new / taken / taken-with-matching
 *     password / taken-with-wrong-password cases, because a different status, a
 *     different message and a different body are all enumeration channels.
 *   - Login answers identically for an unknown address, a wrong password and a
 *     disabled account. Same reason.
 *   - The session token is random, opaque, and stored only as a SHA-256.
 *   - The two auth systems do not overlap: an account cookie opens no admin route
 *     and an admin cookie opens no account route, and no account route asks for
 *     `X-WAFI-Admin`.
 *   - Nothing about the machine, the network or the browser is written down.
 *
 * The password model is the one `admins` uses, so a test cannot log in with a
 * password: it presents a verifier, which is what the client would send.
 * `fakeVerifier(seed)` stands in for "whatever the client derived", and the same
 * seed always produces the same value - which is how a correct and an incorrect
 * password are told apart without running 600,000 PBKDF2 rounds per test.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  fakeVerifier,
  harness,
  testSalt,
  TEST_ACCOUNT_ORIGIN,
  TEST_ORIGIN,
  type Harness,
} from "./harness.ts";
import { DEFAULT_ITERATIONS, sha256Hex } from "../src/crypto.ts";
import { readConfig, type Env } from "../src/env.ts";
import { publicRoutes } from "../src/routes/public.ts";
import { ACCOUNT_SESSION_COOKIE, TOUCH_INTERVAL_MS } from "../src/account-session.ts";

const EMAIL = "person@example.com";
const PASSWORD_SEED = "correct horse";
const WRONG_SEED = "battery staple";

/** `fakeVerifier` is deterministic, so a seed *is* a password for these tests. */
const verifierFor = (seed: string): string => fakeVerifier(seed);

/**
 * What a single request should carry.
 *
 * The harness supplies the ordinary defaults - a remembered cookie, a same-origin
 * Origin on anything mutating - so a test only names what it is actually about.
 */
interface Call {
  /** Omit entirely to use the remembered cookie; `""` to send none. */
  readonly cookie?: string;
  readonly origin?: string;
  /** Send no Origin at all, which is what the CSRF check refuses. */
  readonly noOrigin?: boolean;
  /** Attach `X-WAFI-Admin`, as the browser panel does. */
  readonly admin?: boolean;
  readonly ip?: string;
  readonly userAgent?: string;
}

function call(
  h: Harness,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  opts: Call = {},
): Promise<Response> {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
  if (opts.origin !== undefined) headers.set("origin", opts.origin);
  if (opts.userAgent !== undefined) headers.set("user-agent", opts.userAgent);
  if (opts.ip !== undefined) headers.set("cf-connecting-ip", opts.ip);

  return h.request(path, {
    method,
    headers,
    csrf: opts.noOrigin === true ? false : undefined,
    admin: opts.admin === true ? true : undefined,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function registrationBody(email: string, seed: string): Record<string, unknown> {
  return {
    email,
    verifier: verifierFor(seed),
    salt: testSalt(seed),
    iterations: DEFAULT_ITERATIONS,
  };
}

const register = (h: Harness, email = EMAIL, seed = PASSWORD_SEED, opts: Call = {}) =>
  call(h, "/api/account/register", "POST", registrationBody(email, seed), opts);

const login = (h: Harness, email = EMAIL, seed = PASSWORD_SEED, opts: Call = {}) =>
  call(h, "/api/account/login", "POST", { email, verifier: verifierFor(seed) }, opts);

const logout = (h: Harness, opts: Call = {}) =>
  call(h, "/api/account/logout", "POST", {}, opts);

const me = (h: Harness, opts: Call = {}) => call(h, "/api/account/me", "GET", undefined, opts);

/** The `Set-Cookie` header, split into the two parts most assertions need. */
function cookieOf(response: Response): { name: string; value: string; header: string } {
  const header = response.headers.get("set-cookie") ?? "";
  const parsed = /^([^=]+)=([^;]*)/.exec(header);
  return { name: parsed?.[1] ?? "", value: parsed?.[2] ?? "", header };
}

/** A complete cookie header for a raw token. `token` is the value, not the name. */
const accountCookie = (token: string): string => `${ACCOUNT_SESSION_COOKIE}=${token}`;

function countRows(h: Harness, sql: string, ...params: (string | number | null)[]): number {
  return h.db.query(sql, ...params).length;
}

function singleRow<T>(h: Harness, sql: string, ...params: (string | number | null)[]): T {
  const rows = h.db.query(sql, ...params) as T[];
  assert.equal(rows.length, 1, `expected exactly one row from: ${sql}`);
  return rows[0]!;
}

/**
 * Marks an account disabled the way the schema insists an admin must.
 *
 * The disabling admin has to exist: `accounts.disabled_by` is a foreign key, so
 * a row claiming "somebody disabled this" cannot name nobody.
 */
function disableAccount(h: Harness, email: string): void {
  h.db.exec(
    `INSERT INTO admins (id, username, password_hash, password_salt, iterations)
     VALUES ('a1', 'wafi', '${"0".repeat(64)}', 'saltsaltsaltsaltsalt', 600000)`,
  );
  h.db.run(
    `UPDATE accounts
        SET disabled = 1, disabled_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
            disabled_by = 'a1', disabled_by_username = 'wafi'
      WHERE email = ?`,
    email,
  );
}

/**
 * Rewrites a session so that it is in the past.
 *
 * All three timestamps move together. `account_sessions` carries
 * `CHECK (expires_at > created_at)` and `CHECK (last_seen_at >= created_at)`, so a
 * row cannot be made to expire by editing `expires_at` alone - which is itself
 * worth knowing, and is asserted separately below.
 */
function ageSession(h: Harness, agoDays: number): void {
  h.db.run(
    `UPDATE account_sessions
        SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?),
            last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?),
            expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?, ?)`,
    `-${agoDays} days`,
    `-${agoDays} days`,
    `-${agoDays} days`,
    "+2 hours",
  );
}

/** Status plus body, which is what "the same answer" actually means. */
async function shape(response: Response): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() };
}

describe("Phase 2 - registration", () => {
  test("creates the account and signs nobody in", async () => {
    const h = harness();
    const response = await register(h);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null, "register must not issue a session");
    assert.equal(countRows(h, "SELECT id FROM accounts"), 1);
    assert.equal(countRows(h, "SELECT token_hash FROM account_sessions"), 0);
    assert.equal(singleRow<{ email: string }>(h, "SELECT email FROM accounts").email, EMAIL);
    h.close();
  });

  test("stores the hash of the verifier, never the verifier", async () => {
    const h = harness();
    await register(h);

    const row = singleRow<{ password_hash: string; password_salt: string; iterations: number }>(
      h,
      "SELECT password_hash, password_salt, iterations FROM accounts",
    );
    assert.equal(row.password_hash, await sha256Hex(verifierFor(PASSWORD_SEED)));
    assert.equal(row.password_salt, testSalt(PASSWORD_SEED));
    assert.equal(row.iterations, DEFAULT_ITERATIONS);

    // The presented verifier is not a login credential, so it must not be here.
    const dumped = JSON.stringify(h.db.query("SELECT * FROM accounts"));
    assert.equal(dumped.includes(verifierFor(PASSWORD_SEED)), false);
    h.close();
  });

  test("says the same thing whether or not the address was taken", async () => {
    const h = harness();

    const answers = await Promise.all([
      shape(await register(h, EMAIL, PASSWORD_SEED)),
      shape(await register(h, EMAIL, PASSWORD_SEED)),
      shape(await register(h, EMAIL, WRONG_SEED)),
      shape(await register(h, "someone@example.com", WRONG_SEED)),
    ]);

    // One answer, four situations. A different status or a different message for
    // "already registered" is the enumeration this route exists to prevent.
    for (const answer of answers.slice(1)) {
      assert.equal(answer.status, answers[0].status);
      assert.equal(answer.body, answers[0].body);
    }

    // And it took the second one literally: only the two distinct addresses exist.
    assert.equal(countRows(h, "SELECT id FROM accounts"), 2);
    h.close();
  });

  test("a repeat registration cannot take the account over", async () => {
    const h = harness();
    await register(h, EMAIL, PASSWORD_SEED);

    const before = singleRow<{ password_hash: string; password_salt: string; created_at: string }>(
      h,
      "SELECT password_hash, password_salt, created_at FROM accounts",
    );

    // Someone who knows the address tries to re-register it with their own
    // password. Uniform response, and no effect whatsoever.
    assert.equal((await register(h, EMAIL, WRONG_SEED)).status, 200);

    const after = singleRow<{ password_hash: string; password_salt: string; created_at: string }>(
      h,
      "SELECT password_hash, password_salt, created_at FROM accounts",
    );
    assert.deepEqual(after, before, "a duplicate registration overwrote the password material");

    assert.equal((await login(h, EMAIL, PASSWORD_SEED, { cookie: "" })).status, 200);
    assert.equal((await login(h, EMAIL, WRONG_SEED, { cookie: "" })).status, 401);
    h.close();
  });

  test("stores one account per address however it is spelled", async () => {
    const h = harness();
    // All three are the same person, written three ways. Every one has to be
    // *accepted* as well as folded together: an implementation that folded the
    // case but rejected the padding would pass a count-only assertion while
    // refusing a real person's address.
    for (const spelling of [
      "Person@Example.COM",
      "  person@example.com  ",
      "PERSON@EXAMPLE.COM",
    ]) {
      const response = await register(h, spelling, PASSWORD_SEED);
      assert.equal(response.status, 200, `refused an ordinary spelling: "${spelling}"`);
    }

    assert.equal(countRows(h, "SELECT id FROM accounts"), 1);
    assert.equal(
      singleRow<{ email: string }>(h, "SELECT email FROM accounts").email,
      EMAIL,
      "the stored address must be the canonical form",
    );
    h.close();
  });

  test("refuses an address that is not an address", async () => {
    const h = harness();
    const rejected = [
      "no-at-sign",
      "@example.com",
      "person@",
      "two@at@example.com",
      ".person@example.com",
      "person.@example.com",
      "per..son@example.com",
      "person name@example.com",
      "person@-example.com",
      // Only the local-part rule rejects these two. Each is short enough to sit
      // comfortably inside the 254-character cap, so nothing else catches them -
      // which is the point: a shape check with no test is a shape check that gets
      // deleted the first time someone tidies it.
      `${"a".repeat(65)}@example.com`,
      `${"a".repeat(250)}@example.com`,
    ];

    for (const email of rejected) {
      const response = await register(h, email, PASSWORD_SEED);
      assert.equal(response.status, 422, `accepted a malformed address: ${email.slice(0, 40)}`);
    }
    assert.equal(countRows(h, "SELECT id FROM accounts"), 0);
    h.close();
  });

  test("refuses a verifier that is not 64 hexadecimal characters", async () => {
    const h = harness();
    // Registration reports malformed input as malformed, so this is observable
    // there. On the login route it deliberately is not - a verifier the server
    // cannot parse and a verifier that is simply wrong get the same answer, and
    // that is the more important of the two properties.
    const rejected = [
      "short",
      "z".repeat(64),
      `${"0".repeat(63)}g`,
      `${"0".repeat(65)}`,
      "0".repeat(63) + "É",
    ];

    for (const verifier of rejected) {
      const response = await call(
        h,
        "/api/account/register",
        "POST",
        { email: EMAIL, verifier, salt: testSalt(PASSWORD_SEED), iterations: DEFAULT_ITERATIONS },
      );
      assert.equal(response.status, 422, `accepted a malformed verifier: ${verifier.slice(0, 20)}`);
      const body = await response.json<{ error: { fields?: Record<string, string> } }>();
      assert.ok(body.error.fields?.verifier, "the verifier field was not named");
    }
    assert.equal(countRows(h, "SELECT id FROM accounts"), 0);
    h.close();
  });

  test("refuses a body carrying anything an account does not have", async () => {
    const h = harness();
    for (const field of ["machine_id", "hwid", "install_id", "device_id", "hostname", "plan"]) {
      const response = await call(h, "/api/account/register", "POST", {
        ...registrationBody(EMAIL, PASSWORD_SEED),
        [field]: "anything",
      });
      assert.equal(response.status, 422, `accepted an unknown field: ${field}`);
      const body = (await response.json<{ error: { fields?: Record<string, string> } }>());
      assert.ok(body.error.fields?.[field], `${field} was not named in the error`);
    }
    assert.equal(countRows(h, "SELECT id FROM accounts"), 0);
    h.close();
  });
});

describe("Phase 2 - login", () => {
  test("signs in and sets a cookie a browser cannot read", async () => {
    const h = harness();
    await register(h);

    const response = await login(h);
    assert.equal(response.status, 200);

    const cookie = cookieOf(response);
    assert.equal(cookie.name, `__Host-${ACCOUNT_SESSION_COOKIE}`);
    assert.match(cookie.header, /; HttpOnly/);
    assert.match(cookie.header, /; Secure/);
    assert.match(cookie.header, /; SameSite=Strict/);
    assert.match(cookie.header, /; Path=\//);
    assert.match(cookie.header, /; Max-Age=86400/);
    // `__Host-` is only honoured when there is no Domain attribute at all.
    assert.equal(cookie.header.includes("Domain"), false);

    const body = await response.json<{
      account: { email: string };
      session: { expires_in_seconds: number };
    }>();
    assert.equal(body.account.email, EMAIL);
    assert.equal(body.session.expires_in_seconds, 24 * 3600);
    assert.ok(
      singleRow<{ last_login_at: string | null }>(h, "SELECT last_login_at FROM accounts").last_login_at,
      "a successful login must stamp last_login_at",
    );
    h.close();
  });

  test("gives one answer to a wrong password, an unknown address and a disabled account", async () => {
    const h = harness();
    await register(h, EMAIL, PASSWORD_SEED);
    await register(h, "disabled@example.com", PASSWORD_SEED);
    disableAccount(h, "disabled@example.com");

    const answers = await Promise.all([
      shape(await login(h, EMAIL, WRONG_SEED, { cookie: "" })),
      shape(await login(h, "nobody@example.com", PASSWORD_SEED, { cookie: "" })),
      shape(await login(h, "disabled@example.com", PASSWORD_SEED, { cookie: "" })),
    ]);

    for (const answer of answers) {
      assert.equal(answer.status, 401);
      assert.equal(answer.body, answers[0].body);
      assert.equal(answer.body.toLowerCase().includes("disabled"), false, "the answer named the account's state");
      assert.equal(answer.body.toLowerCase().includes("exist"), false);
    }
    assert.equal(countRows(h, "SELECT token_hash FROM account_sessions"), 0);
    h.close();
  });

  test("answers a malformed login attempt like a wrong password, not like a bug", async () => {
    const h = harness();
    const garbage = await call(
      h,
      "/api/account/login",
      "POST",
      { email: EMAIL, verifier: "not-a-verifier" },
      { cookie: "" },
    );
    const wrong = await login(h, EMAIL, WRONG_SEED, { cookie: "" });

    assert.equal(garbage.status, 401);
    assert.deepEqual(await shape(garbage), await shape(wrong));
    h.close();
  });

  test("will not accept a password, only a verifier", async () => {
    const h = harness();
    // The password is not an accepted field at all. A client that sent one would
    // be holding it somewhere this API cannot see and cannot scrub.
    const response = await call(
      h,
      "/api/account/login",
      "POST",
      { email: EMAIL, password: PASSWORD_SEED },
      { cookie: "" },
    );
    assert.equal(response.status, 401);
    h.close();
  });

  test("the salt and the verifier are never echoed back", async () => {
    const h = harness();
    await register(h);
    const text = await (await login(h)).text();

    assert.equal(text.includes(testSalt(PASSWORD_SEED)), false, "the response leaked the salt");
    assert.equal(text.includes(verifierFor(PASSWORD_SEED)), false, "the response leaked the verifier");
    h.close();
  });
});

describe("Phase 2 - sessions", () => {
  test("stores only the hash of the session token", async () => {
    const h = harness();
    await register(h);
    const raw = cookieOf(await login(h)).value;

    assert.match(raw, /^[0-9a-f]{64}$/);
    assert.equal(
      singleRow<{ token_hash: string }>(h, "SELECT token_hash FROM account_sessions").token_hash,
      await sha256Hex(raw),
    );
    assert.equal(
      JSON.stringify(h.db.query("SELECT * FROM account_sessions")).includes(raw),
      false,
      "the raw session token is readable in the table",
    );
    h.close();
  });

  test("issues an opaque random token, not a signed one", async () => {
    const h = harness();
    await register(h);

    const first = cookieOf(await login(h)).value;
    const second = cookieOf(await login(h, EMAIL, PASSWORD_SEED, { cookie: "" })).value;

    assert.notEqual(first, second, "two logins issued the same token");
    // A JWT is three dot-separated base64 segments beginning `eyJ`. There is no
    // signature here at all: the token is a secret and the server keeps only a
    // hash of it, so there is nothing for a client to decode or forge.
    assert.equal(first.split(".").length, 1);
    assert.equal(first.startsWith("eyJ"), false);
    assert.equal(countRows(h, "SELECT token_hash FROM account_sessions"), 2);
    h.close();
  });

  test("refuses a fabricated session", async () => {
    const h = harness();
    const tokens = ["0".repeat(64), "a".repeat(64), "not-a-token"];

    for (const token of tokens) {
      const response = await me(h, { cookie: accountCookie(token) });
      assert.equal(response.status, 401, `accepted the fabricated token ${token.slice(0, 8)}`);
    }
    assert.equal((await me(h, { cookie: "" })).status, 401, "accepted no cookie at all");
    h.close();
  });

  test("refuses a session whose account no longer exists", async () => {
    const h = harness();
    await register(h);
    const token = cookieOf(await login(h)).value;

    // Deleting the account takes the session with it, so there is no orphan row a
    // stale cookie could ever resolve against.
    h.db.run("DELETE FROM accounts WHERE email = ?", EMAIL);
    assert.equal(countRows(h, "SELECT token_hash FROM account_sessions"), 0);

    assert.equal((await me(h, { cookie: accountCookie(token) })).status, 401);
    h.close();
  });

  test("refuses an expired session and forgets it", async () => {
    const h = harness();
    await register(h);
    const token = cookieOf(await login(h)).value;

    ageSession(h, 3);
    assert.equal((await me(h, { cookie: accountCookie(token) })).status, 401);
    assert.equal(countRows(h, "SELECT token_hash FROM account_sessions"), 0, "the dead row survived");
    h.close();
  });

  test("a session cannot even be stored already-expired", async () => {
    // A row that expired before it was written is nonsense, and the schema says so.
    // Which means expiry is decided by a comparison, not by a stored flag - and a
    // test cannot produce an expired session by writing one.
    const h = harness();
    await register(h);
    await login(h);

    assert.throws(
      () => h.db.run("UPDATE account_sessions SET expires_at = '2000-01-01T00:00:00Z'"),
      /CHECK constraint failed/,
    );
    h.close();
  });

  test("a disabled account cannot use the session it already has", async () => {
    const h = harness();
    await register(h);
    const token = cookieOf(await login(h)).value;

    // Working right up to the moment of the decision.
    assert.equal((await me(h, { cookie: accountCookie(token) })).status, 200);

    disableAccount(h, EMAIL);
    assert.equal((await me(h, { cookie: accountCookie(token) })).status, 401);
    assert.equal(countRows(h, "SELECT token_hash FROM account_sessions"), 0, "the session outlived the disable");
    h.close();
  });

  test("reads last_seen_at on the cadence, not on every request", async () => {
    const h = harness();
    await register(h);
    const token = cookieOf(await login(h)).value;

    // Backdated by half a minute: inside the cadence, so nothing should be
    // written, but *outside* the resolution of the stored timestamp. An earlier
    // version of this test read the row immediately after login, which could only
    // pass by luck - the login and any rewrite land in the same second, so
    // "unchanged" and "rewritten to the same instant" are the same string.
    const recent = new Date(Date.now() - 30_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    h.db.run("UPDATE account_sessions SET created_at = ?, last_seen_at = ?", recent, recent);
    assert.equal((await me(h, { cookie: accountCookie(token) })).status, 200);
    assert.equal(
      singleRow<{ last_seen_at: string }>(h, "SELECT last_seen_at FROM account_sessions").last_seen_at,
      recent,
      "the row was rewritten inside the touch interval",
    );

    // Backdate past the interval and it is rewritten - both columns, in one
    // statement, so they cannot disagree about when the session was last used.
    const stale = new Date(Date.now() - TOUCH_INTERVAL_MS - 60_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    h.db.run("UPDATE account_sessions SET created_at = ?, last_seen_at = ?", stale, stale);
    assert.equal((await me(h, { cookie: accountCookie(token) })).status, 200);

    const after = singleRow<{ last_seen_at: string; expires_at: string }>(
      h,
      "SELECT last_seen_at, expires_at FROM account_sessions",
    );
    assert.notEqual(after.last_seen_at, stale);
    // Expiry slid with it. Asserted as a gap rather than as "the value changed",
    // because the rewrite lands in the same second as the read and two ISO
    // timestamps one second apart are the same string often enough to matter.
    assert.equal(
      Date.parse(after.expires_at) - Date.parse(after.last_seen_at),
      24 * 3600 * 1000,
      "expiry did not slide with last_seen_at",
    );
    h.close();
  });

  test("reports the remaining lifetime, not the full one", async () => {
    const h = harness();
    await register(h);
    const token = cookieOf(await login(h)).value;

    // Halve what is left, so "still 24 hours" cannot pass by accident. The
    // timestamps move together because the schema refuses `expires_at <=
    // created_at`, which the "cannot be stored already-expired" test asserts.
    h.db.run(
      `UPDATE account_sessions
          SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-23 hours'),
              expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 hour')`,
    );
    const response = await me(h, { cookie: accountCookie(token) });
    const body = await response.json<{ session: { expires_in_seconds: number } }>();
    assert.ok(
      body.session.expires_in_seconds <= 3600 && body.session.expires_in_seconds > 3500,
      `expected about an hour, got ${body.session.expires_in_seconds}`,
    );
    h.close();
  });

  test("caps how many sessions one account can hold", async () => {
    const h = harness({ accountSessionMaxPerAccount: "2" });
    await register(h);

    // Three logins, three distinct cookies, so this is three sessions and not one
    // session being refreshed.
    const first = cookieOf(await login(h)).value;
    await me(h, { cookie: accountCookie(first) });
    const second = cookieOf(await login(h, EMAIL, PASSWORD_SEED, { cookie: "" })).value;
    await me(h, { cookie: accountCookie(second) });
    const third = cookieOf(await login(h, EMAIL, PASSWORD_SEED, { cookie: "" })).value;

    assert.equal(countRows(h, "SELECT token_hash FROM account_sessions"), 2);
    assert.equal((await me(h, { cookie: accountCookie(third) })).status, 200);
    // The most recently used survive; the oldest is the one dropped.
    assert.equal((await me(h, { cookie: accountCookie(first) })).status, 401);
    h.close();
  });

  test("logout revokes this session and leaves other devices alone", async () => {
    const h = harness();
    await register(h);

    const desktop = cookieOf(await login(h)).value;
    const laptop = cookieOf(await login(h, EMAIL, PASSWORD_SEED, { cookie: "" })).value;
    assert.notEqual(desktop, laptop);

    const response = await logout(h, { cookie: accountCookie(desktop) });
    assert.equal(response.status, 200);
    const cleared = response.headers.get("set-cookie") ?? "";
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, new RegExp(`^__Host-${ACCOUNT_SESSION_COOKIE}=;`));

    assert.equal((await me(h, { cookie: accountCookie(desktop) })).status, 401);
    assert.equal(
      (await me(h, { cookie: accountCookie(laptop) })).status,
      200,
      "logging out on one device signed out another",
    );
    assert.equal(countRows(h, "SELECT token_hash FROM account_sessions"), 1);
    h.close();
  });

  test("logout works with no session, so a stale cookie can always be cleared", async () => {
    const h = harness();
    assert.equal((await logout(h, { cookie: "" })).status, 200);

    await register(h);
    const token = cookieOf(await login(h)).value;
    ageSession(h, 3);
    assert.equal((await logout(h, { cookie: accountCookie(token) })).status, 200);
    h.close();
  });

  test("the two auth systems do not open each other's doors", async () => {
    const bootstrapToken = "bootstrap-token-32-characters-long!!";
    const h = harness({ bootstrapToken });

    const bootstrapped = await call(
      h,
      "/api/admin/bootstrap",
      "POST",
      {
        bootstrap_token: bootstrapToken,
        username: "wafi",
        verifier: verifierFor("admin"),
        salt: testSalt("admin"),
        iterations: DEFAULT_ITERATIONS,
      },
      { admin: true },
    );
    assert.equal(bootstrapped.status, 201);
    const adminToken = cookieOf(bootstrapped).value;
    assert.ok(adminToken, "the admin bootstrap did not sign in");

    await register(h);
    const accountToken = cookieOf(await login(h, EMAIL, PASSWORD_SEED, { cookie: "" })).value;

    assert.equal((await me(h, { cookie: accountCookie(accountToken) })).status, 200);
    assert.equal(
      (await call(h, "/api/admin/me", "GET", undefined, { cookie: accountCookie(accountToken) })).status,
      401,
      "an account cookie authenticated an admin route",
    );
    assert.equal(
      (await me(h, { cookie: `wafx_admin=${adminToken}` })).status,
      401,
      "an admin cookie authenticated an account route",
    );
    h.close();
  });
});

describe("Phase 2 - CSRF", () => {
  const MUTATIONS: [string, Record<string, unknown>][] = [
    ["/api/account/register", registrationBody(EMAIL, PASSWORD_SEED)],
    ["/api/account/login", { email: EMAIL, verifier: verifierFor(PASSWORD_SEED) }],
    ["/api/account/logout", {}],
  ];

  test("a cross-site account mutation is refused", async () => {
    const h = harness();
    for (const [path, body] of MUTATIONS) {
      // A form on another origin sends the victim's origin...
      const foreign = await call(h, path, "POST", body, {
        origin: "https://evil.example",
        cookie: "",
      });
      assert.equal(foreign.status, 403, `accepted a foreign-origin POST ${path}`);

      // ...and can be made to send no origin at all, which is refused too.
      const silent = await call(h, path, "POST", body, { noOrigin: true, cookie: "" });
      assert.equal(silent.status, 403, `accepted an originless POST ${path}`);
    }
    h.close();
  });

  test("a read is not blocked by the origin check", async () => {
    const h = harness();
    assert.equal(
      (await call(h, "/api/account/auth/params?email=a@b.test", "GET", undefined, { origin: "https://evil.example" }))
        .status,
      200,
    );
    h.close();
  });

  test("the refusal never mentions the admin panel", async () => {
    const h = harness();
    const response = await login(h, EMAIL, PASSWORD_SEED, {
      origin: "https://evil.example",
      cookie: "",
    });
    const body = (await response.json<{ error: { message: string } }>());
    assert.equal(body.error.message.toLowerCase().includes("admin"), false);
    h.close();
  });

  test("no account route asks for X-WAFI-Admin", async () => {
    const h = harness();
    // Every account mutation succeeds without the header, which is all the
    // desktop app's Rust client will send.
    await register(h);
    assert.equal((await login(h)).status, 200);
    assert.equal((await me(h)).status, 200);
    assert.equal((await logout(h)).status, 200);

    // And sending it changes nothing, so there is no accidental dependency.
    assert.equal((await login(h, EMAIL, PASSWORD_SEED, { admin: true, cookie: "" })).status, 200);
    h.close();
  });

  test("admin routes still require the panel's own header", async () => {
    const h = harness();
    const response = await call(
      h,
      "/api/admin/login",
      "POST",
      { username: "wafi", verifier: "0".repeat(64) },
      { cookie: "" },
    );
    assert.equal(response.status, 403);
    const body = (await response.json<{ error: { message: string } }>());
    assert.match(body.error.message, /x-wafi-admin/i);
    h.close();
  });

  test("the account allowlist is the account origin plus anything configured", async () => {
    const h = harness({
      accountOrigin: TEST_ACCOUNT_ORIGIN,
      accountOrigins: "https://app2.wafix.test",
    });

    for (const origin of [TEST_ACCOUNT_ORIGIN, "https://app2.wafix.test"]) {
      assert.equal(
        (await login(h, EMAIL, PASSWORD_SEED, { origin, cookie: "" })).status,
        401,
        `${origin} was not accepted`,
      );
    }
    assert.equal(
      (await login(h, EMAIL, PASSWORD_SEED, { origin: TEST_ORIGIN, cookie: "" })).status,
      403,
      "the API's own origin was accepted as an app origin",
    );
    h.close();
  });

  test("the cookie follows the app origin, not the API's", async () => {
    const loopback = "http://localhost:8787";
    const h = harness({ accountOrigin: loopback });
    await register(h, EMAIL, PASSWORD_SEED, { origin: loopback });
    const cookie = cookieOf(await login(h, EMAIL, PASSWORD_SEED, { origin: loopback }));

    // A loopback app origin has to work in local development, and a `__Host-` or
    // `Secure` cookie would simply never be set there.
    assert.equal(cookie.name, ACCOUNT_SESSION_COOKIE);
    assert.equal(cookie.header.includes("Secure"), false);
    assert.match(cookie.header, /; HttpOnly/);
    h.close();
  });
});

describe("Phase 2 - rate limiting", () => {
  test("login attempts are limited per address", async () => {
    const h = harness({ accountLoginMaxAttempts: "2" });
    await register(h);

    assert.equal((await login(h, EMAIL, WRONG_SEED, { cookie: "" })).status, 401);
    assert.equal((await login(h, EMAIL, WRONG_SEED, { cookie: "" })).status, 401);
    const third = await login(h, EMAIL, WRONG_SEED, { cookie: "" });

    assert.equal(third.status, 429);
    assert.ok(third.headers.get("retry-after"), "a 429 must say when to come back");
    assert.equal(countRows(h, "SELECT token_hash FROM account_sessions"), 0);
    h.close();
  });

  test("login attempts are limited per IP, not by one global counter", async () => {
    const h = harness({ accountLoginMaxAttempts: "1" });
    const at = (ip: string, email: string) => login(h, email, PASSWORD_SEED, { cookie: "", ip });

    // One attempt here, one from elsewhere: both allowed, and neither address has
    // spent anything. So the limiter is per IP.
    assert.equal((await at("203.0.113.1", "a@example.com")).status, 401);
    assert.equal((await at("203.0.113.2", "b@example.com")).status, 401);

    // The first address is now out of budget.
    assert.equal((await at("203.0.113.1", "c@example.com")).status, 429);

    // A third address, which has spent nothing, is unaffected. This is the half
    // that matters: a shared counter would lock every visitor out the moment one
    // of them ran out.
    assert.equal((await at("203.0.113.3", "d@example.com")).status, 401);
    h.close();
  });

  test("a successful login clears that address's own budget", async () => {
    const h = harness({ accountLoginMaxAttempts: "2" });
    await register(h);

    assert.equal((await login(h, EMAIL, WRONG_SEED, { cookie: "" })).status, 401);
    assert.equal((await login(h, EMAIL, PASSWORD_SEED, { cookie: "" })).status, 200);

    // Success resets the counter, so a careful person who fumbled once is not left
    // throttled afterwards.
    assert.equal((await login(h, EMAIL, WRONG_SEED, { cookie: "" })).status, 401);
    assert.equal((await login(h, EMAIL, WRONG_SEED, { cookie: "" })).status, 401);
    assert.equal((await login(h, EMAIL, WRONG_SEED, { cookie: "" })).status, 429);
    h.close();
  });

  test("registrations are limited per IP, per day", async () => {
    const h = harness({ accountRegisterMaxPerDay: "2" });
    assert.equal((await register(h, "a@example.com")).status, 200);
    assert.equal((await register(h, "b@example.com")).status, 200);

    assert.equal((await register(h, "c@example.com")).status, 429);
    assert.equal(countRows(h, "SELECT id FROM accounts"), 2, "a refused registration created an account");
    h.close();
  });

  test("rate-limit keys are hashes, so the table holds no address and no IP", async () => {
    const h = harness();
    await call(h, "/api/account/register", "POST", registrationBody(EMAIL, PASSWORD_SEED), {
      ip: "203.0.113.9",
    });
    await call(h, "/api/account/login", "POST", { email: EMAIL, verifier: verifierFor(WRONG_SEED) }, {
      ip: "203.0.113.9",
    });

    const buckets = (h.db.query("SELECT bucket FROM rate_limits") as { bucket: string }[]).map(
      (row) => row.bucket,
    );
    assert.ok(buckets.length > 0, "no buckets were written, so this asserts nothing");

    const joined = buckets.join(" ");
    assert.equal(joined.includes("example.com"), false, "an email address is readable in rate_limits");
    assert.equal(joined.includes("203.0.113.9"), false, "an IP address is readable in rate_limits");
    h.close();
  });

  test("account limits are their own, and tighter than the admin figures", () => {
    const config = readConfig({ PUBLIC_ORIGIN: TEST_ORIGIN } as unknown as Env);

    assert.equal(config.loginMaxAttempts, 10, "the admin figure changed");
    assert.equal(config.accountLoginMaxAttempts, 5, "accounts must be tighter than the panel");
    assert.equal(config.accountWindowMinutes, 15);
    assert.equal(config.accountRegisterMaxPerDay, 5);
    assert.equal(config.accountSessionTtlHours, 24);
    assert.equal(config.accountSessionMaxPerAccount, 10);
  });

  test("the account origin defaults to the API's own", () => {
    const config = readConfig({ PUBLIC_ORIGIN: TEST_ORIGIN } as unknown as Env);

    assert.equal(config.accountOrigin, TEST_ORIGIN);
    assert.deepEqual(config.accountOrigins, [TEST_ORIGIN]);
    assert.equal(config.publicOrigin, TEST_ORIGIN, "the admin origin must be untouched");
  });

  test("a misconfigured account limit refuses to start", () => {
    assert.throws(
      () =>
        readConfig({
          PUBLIC_ORIGIN: TEST_ORIGIN,
          ACCOUNT_LOGIN_MAX_ATTEMPTS: "0",
        } as unknown as Env),
      /ACCOUNT_LOGIN_MAX_ATTEMPTS/,
    );
    assert.throws(
      () =>
        readConfig({
          PUBLIC_ORIGIN: TEST_ORIGIN,
          ACCOUNT_ORIGINS: "not-an-origin",
        } as unknown as Env),
      /origin/i,
    );
  });
});

describe("Phase 2 - privacy", () => {
  test("no public route mutates, so no public route needs an origin check", () => {
    const mutating = publicRoutes.routes
      .filter((route) => !["GET", "HEAD"].includes(route.method))
      .map((route) => `${route.method} ${route.path}`);
    assert.deepEqual(
      mutating,
      [],
      "a mutating public route would be mounted with no CSRF check",
    );
  });

  test("nothing about the caller is written down", async () => {
    const h = harness();
    const fingerprint = {
      ip: "203.0.113.9",
      userAgent: "WafiX/1.0.0 (Windows NT 10.0; Win64)",
    };

    await call(h, "/api/account/register", "POST", registrationBody(EMAIL, PASSWORD_SEED), fingerprint);
    await call(h, "/api/account/login", "POST", { email: EMAIL, verifier: verifierFor(PASSWORD_SEED) }, fingerprint);
    const token = cookieOf(await login(h, EMAIL, PASSWORD_SEED, { cookie: "", ...fingerprint })).value;
    await me(h, { cookie: accountCookie(token), ...fingerprint });
    await logout(h, { cookie: accountCookie(token), ...fingerprint });

    // Every table a person can appear in, dumped whole.
    const everything = JSON.stringify([
      ...h.db.query("SELECT * FROM accounts"),
      ...h.db.query("SELECT * FROM account_sessions"),
      ...h.db.query("SELECT * FROM account_tokens"),
      ...h.db.query("SELECT * FROM pro_grants"),
    ]);

    assert.equal(everything.includes("203.0.113.9"), false, "an IP address was stored");
    assert.equal(everything.includes("WafiX/1.0.0"), false, "a user agent was stored");
    assert.equal(everything.toLowerCase().includes("windows nt"), false);
    h.close();
  });

  test("an account sign-in is not an audited operator action", async () => {
    const h = harness();
    await register(h);
    const token = cookieOf(await login(h)).value;
    await me(h, { cookie: accountCookie(token) });
    await logout(h, { cookie: accountCookie(token) });

    // `admin_audit` is the one place in this database with an `ip` column. It is an
    // operator trail, it is joined to no account, and nothing a person does in the
    // app may land in it.
    assert.equal(countRows(h, "SELECT id FROM admin_audit"), 0);
    h.close();
  });

  test("no session token is ever returned in a body", async () => {
    const h = harness();
    await register(h);
    const raw = cookieOf(await login(h)).value;

    assert.equal((await (await me(h)).text()).includes(raw), false);
    const params = await (await call(h, "/api/account/auth/params?email=a@b.test", "GET")).text();
    assert.equal(params.includes(raw), false);
    h.close();
  });

  test("auth params hands out a decoy for an address it cannot help with", async () => {
    const h = harness();
    await register(h);
    await register(h, "disabled@example.com", "another seed");
    disableAccount(h, "disabled@example.com");

    const read = async (email: string) => {
      const response = await call(
        h,
        `/api/account/auth/params?email=${encodeURIComponent(email)}`,
        "GET",
      );
      return await response.json<{ salt: string; iterations: number }>();
    };

    const known = await read(EMAIL);
    const unknown = await read("nobody@example.com");
    const disabled = await read("disabled@example.com");

    assert.equal(known.salt, testSalt(PASSWORD_SEED));
    assert.equal(known.iterations, DEFAULT_ITERATIONS);

    // Each answer is compared against the salt actually stored for *that* address,
    // not against the first account's. Comparing both to the first one would pass
    // even if a disabled account were handed its own real salt.
    const cases: [string, { salt: string; iterations: number }, string][] = [
      ["unknown address", unknown, testSalt(PASSWORD_SEED)],
      ["disabled account", disabled, testSalt("another seed")],
    ];

    for (const [label, answer, storedSalt] of cases) {
      assert.equal(answer.iterations, DEFAULT_ITERATIONS, `${label}: different shape`);
      assert.equal(answer.salt.length, storedSalt.length, `${label}: different shape`);
      // The assertion that matters: a salt the caller could use to confirm the
      // address exists is worse than no answer at all, because it turns a decoy
      // into an oracle. A disabled account is included because "exists and is
      // disabled" is exactly the thing worth not confirming.
      assert.notEqual(answer.salt, storedSalt, `${label}: a stored salt was handed out`);
    }
    h.close();
  });
});

describe("Phase 2 - response headers", () => {
  test("an account response carries the standard hardening headers", async () => {
    const h = harness();
    await register(h);
    const response = await me(h);

    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    // Per-user state must never sit in a shared cache.
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("vary"), "Cookie, Origin");
    h.close();
  });

  test("a refused account response carries them too", async () => {
    const h = harness();
    const response = await me(h, { cookie: "" });

    assert.equal(response.status, 401);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    h.close();
  });
});