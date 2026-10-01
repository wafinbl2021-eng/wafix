/**
 * Authentication and session tests.
 *
 * The password model is worth restating, because several assertions below only
 * make sense against it:
 *
 *   The admin panel runs PBKDF2-SHA256 in the browser and sends the resulting
 *   32-byte verifier. The Worker stores SHA-256 of that verifier and compares
 *   SHA-256 of whatever arrives against it.
 *
 * So a test cannot log in with a password. It sends a verifier, which is what
 * the panel would send. `fakeVerifier` stands in for "whatever the browser
 * derived", and the point of the hash round-trip is that neither value is
 * directly usable as the other.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { harness, fakeVerifier, testSalt, TEST_ORIGIN } from "./harness.ts";
import { sha256Hex } from "../src/crypto.ts";
import {
  clearCookieHeader,
  parseCookies,
  readSessionToken,
  sessionCookieHeader,
} from "../src/session.ts";

const BOOTSTRAP_TOKEN = "bootstrap-token-32-characters-long!!";
const USERNAME = "wafi";

/** Creates the first admin through the real endpoint, and signs in. */
async function bootstrap(
  h: ReturnType<typeof harness>,
  options: { username?: string; password?: string; token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const password = options.password ?? "correct horse battery staple";
  return h.json<Record<string, unknown>>("/api/admin/bootstrap", {
    method: "POST",
    admin: true,
    body: JSON.stringify({
      bootstrap_token: options.token ?? BOOTSTRAP_TOKEN,
      username: options.username ?? USERNAME,
      verifier: fakeVerifier(password),
      salt: testSalt(options.username ?? USERNAME),
    }),
  });
}

describe("bootstrap", () => {
  test("creates the first admin and signs in", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      const { status, body } = await bootstrap(h);
      assert.equal(status, 201);
      assert.equal((body.admin as { username: string }).username, USERNAME);
      assert.ok(h.signedIn, "no session cookie was issued");
    } finally {
      h.close();
    }
  });

  test("refuses a second admin, even with a valid token", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h);
      const { status, body } = await bootstrap(h, { username: "someone-else" });
      assert.equal(status, 409);
      assert.equal((body.error as { code: string }).code, "bootstrap_unavailable");
    } finally {
      h.close();
    }
  });

  test("refuses a wrong token", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      const { status } = await bootstrap(h, { token: "not-the-token-at-all-000000000" });
      assert.equal(status, 403);
      assert.ok(!h.signedIn);
    } finally {
      h.close();
    }
  });

  test("refuses when BOOTSTRAP_TOKEN is not configured, and says so", async () => {
    // Silently accepting a bootstrap with no token would be far worse than
    // failing: it would mean the first request to reach the URL owns the panel.
    const h = harness();
    try {
      const { status, body } = await bootstrap(h);
      assert.equal(status, 500);
      assert.match((body.error as { message: string }).message, /BOOTSTRAP_TOKEN/);
    } finally {
      h.close();
    }
  });

  test("stores a hash of the verifier, not the verifier", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      const password = "a memorable password";
      const verifier = fakeVerifier(password);
      await h.json("/api/admin/bootstrap", {
        method: "POST",
        admin: true,
        body: JSON.stringify({
          bootstrap_token: BOOTSTRAP_TOKEN,
          username: USERNAME,
          verifier,
          salt: testSalt(),
        }),
      });

      const row = h.db.sqlite
        .prepare("SELECT password_hash, password_salt, iterations FROM admins WHERE username = ?")
        .get(USERNAME) as { password_hash: string; password_salt: string; iterations: number };

      // A database dump must not contain a working credential.
      assert.notEqual(row.password_hash, verifier);
      assert.notEqual(row.password_hash, await sha256Hex(password));
      // And the value the panel must send is the hash, not the stored one.
      assert.equal(row.password_hash, await sha256Hex(verifier));
      assert.equal(row.iterations, 600_000);
    } finally {
      h.close();
    }
  });

  test("records the attempt in the audit log, including a failure", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h, { token: "wrong-token-but-long-enough-00000" });
      await bootstrap(h);

      const rows = h.db.sqlite
        .prepare("SELECT action FROM admin_audit ORDER BY id")
        .all() as { action: string }[];
      // The failed attempt is recorded too: "who tried to claim this?" is a
      // question the log should be able to answer.
      assert.equal(rows.length, 2);
      assert.ok(rows.some((r) => r.action === "admin.bootstrap"));
    } finally {
      h.close();
    }
  });
});

describe("GET /api/admin/auth/params", () => {
  test("returns the stored salt and iteration count for a known admin", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h);
      const { status, body } = await h.json<{ salt: string; iterations: number }>(
        `/api/admin/auth/params?username=${USERNAME}`,
      );
      assert.equal(status, 200);
      assert.equal(body.salt, testSalt(USERNAME));
      assert.equal(body.iterations, 600_000);
    } finally {
      h.close();
    }
  });

  test("returns the same shape for an unknown user, so accounts cannot be enumerated", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h);

      const known = await h.json<{ salt: string; iterations: number }>(
        `/api/admin/auth/params?username=${USERNAME}`,
      );
      const unknown = await h.json<{ salt: string; iterations: number }>(
        "/api/admin/auth/params?username=nobody",
      );

      // A different salt and a different error would both be an oracle. The salt
      // differs - it has to, or the client could not derive anything - but the
      // status, the key set and the iteration count are identical.
      assert.equal(unknown.status, known.status);
      assert.deepEqual(Object.keys(unknown.body).sort(), Object.keys(known.body).sort());
      assert.equal(unknown.body.iterations, known.body.iterations);
      assert.notEqual(unknown.body.salt, known.body.salt);
    } finally {
      h.close();
    }
  });

  test("rejects a malformed username with 400 rather than treating it as unknown", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      const { status } = await h.json("/api/admin/auth/params?username=../etc");
      assert.equal(status, 400);
    } finally {
      h.close();
    }
  });
});

describe("login", () => {
  test("accepts the right verifier and issues a session", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h, { password: "the right password" });
      await h.request("/api/admin/logout", { method: "POST", admin: true });

      const { status, body } = await h.json<{ admin: { username: string } }>("/api/admin/login", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ username: USERNAME, verifier: fakeVerifier("the right password") }),
      });
      assert.equal(status, 200);
      assert.equal(body.admin.username, USERNAME);
      assert.ok(h.signedIn);
    } finally {
      h.close();
    }
  });

  test("refuses a wrong verifier", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h, { password: "the right password" });
      const { status, body } = await h.json<{ error: { code: string } }>("/api/admin/login", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ username: USERNAME, verifier: fakeVerifier("the wrong password") }),
      });
      assert.equal(status, 401);
      assert.equal(body.error.code, "unauthorized");
    } finally {
      h.close();
    }
  });

  test("cannot log in with the password itself", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      const password = "a memorable password";
      await bootstrap(h, { password });

      // This is the property that makes the design work: the panel never sends
      // the password, and the server never stored it, so sending it fails.
      const { status } = await h.json("/api/admin/login", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ username: USERNAME, verifier: password }),
      });
      assert.equal(status, 422); // rejected on shape, before any comparison
    } finally {
      h.close();
    }
  });

  test("cannot log in with the stored hash", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      const password = "a memorable password";
      await bootstrap(h, { password });

      // Stealing the database gives an attacker this value. It must not work:
      // the server hashes what arrives before comparing, so presenting the stored
      // hash produces a different hash and fails.
      const stored = (
        h.db.sqlite
          .prepare("SELECT password_hash FROM admins WHERE username = ?")
          .get(USERNAME) as { password_hash: string }
      ).password_hash;

      const { status } = await h.json("/api/admin/login", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ username: USERNAME, verifier: stored }),
      });
      assert.equal(status, 401);
    } finally {
      h.close();
    }
  });

  test("gives an unknown user and a wrong password the same response", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h, { password: "the right password" });

      const unknownUser = await h.json<{ error: unknown }>("/api/admin/login", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ username: "nobody", verifier: fakeVerifier("whatever") }),
      });
      const wrongPassword = await h.json<{ error: unknown }>("/api/admin/login", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ username: USERNAME, verifier: fakeVerifier("wrong") }),
      });

      // Byte-identical. A different message here is a username oracle.
      assert.equal(unknownUser.status, 401);
      assert.equal(wrongPassword.status, 401);
      assert.deepEqual(unknownUser.body, wrongPassword.body);
    } finally {
      h.close();
    }
  });

  test("refuses a disabled admin", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h);
      h.db.sqlite.prepare("UPDATE admins SET disabled = 1 WHERE username = ?").run(USERNAME);

      const { status } = await h.json("/api/admin/login", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ username: USERNAME, verifier: fakeVerifier("correct horse battery staple") }),
      });
      assert.equal(status, 401);
    } finally {
      h.close();
    }
  });

  test("rejects a verifier of the wrong shape before hashing it", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h);
      for (const verifier of ["short", "z".repeat(64), "A".repeat(64), "0".repeat(63), "0".repeat(65)]) {
        const { status } = await h.json("/api/admin/login", {
          method: "POST",
          admin: true,
          body: JSON.stringify({ username: USERNAME, verifier }),
        });
        assert.equal(status, 422, `verifier "${verifier.slice(0, 12)}" was not refused on shape`);
      }
    } finally {
      h.close();
    }
  });
});

describe("rate limiting", () => {
  test("locks out after the configured number of attempts and sets Retry-After", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN, loginMaxAttempts: "3", loginWindowMinutes: "15" });
    try {
      await bootstrap(h);

      const attempt = () =>
        h.json<Record<string, unknown>>("/api/admin/login", {
          method: "POST",
          admin: true,
          body: JSON.stringify({ username: USERNAME, verifier: fakeVerifier("wrong") }),
        });

      assert.equal((await attempt()).status, 401);
      assert.equal((await attempt()).status, 401);
      assert.equal((await attempt()).status, 401);

      const locked = await h.request(
        "/api/admin/login",
        {
          method: "POST",
          admin: true,
          body: JSON.stringify({ username: USERNAME, verifier: fakeVerifier("wrong") }),
        },
      );
      assert.equal(locked.status, 429);
      assert.equal(/^\d+$/.exec(locked.headers.get("Retry-After") ?? "") !== null, true);

      // The correct password is refused too, which is the point: a lockout that
      // a correct guess could bypass is not a lockout.
      const correct = await h.json("/api/admin/login", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ username: USERNAME, verifier: fakeVerifier("correct horse battery staple") }),
      });
      assert.equal(correct.status, 429);
    } finally {
      h.close();
    }
  });

  test("counts per account as well as per IP", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN, loginMaxAttempts: "2", loginWindowMinutes: "15" });
    try {
      await bootstrap(h);

      const attempt = (ip: string) =>
        h.json("/api/admin/login", {
          method: "POST",
          admin: true,
          headers: { "cf-connecting-ip": ip },
          body: JSON.stringify({ username: USERNAME, verifier: fakeVerifier("wrong") }),
        });

      // Two failures from one address, then one from a different address. Only
      // the per-account bucket counts the third: it is keyed on the username
      // alone, so rotating addresses does not buy a fresh budget. A per-IP-only
      // limit, or an account bucket that included the IP, would answer 401 here.
      assert.equal((await attempt("10.0.0.1")).status, 401);
      assert.equal((await attempt("10.0.0.1")).status, 401);
      assert.equal((await attempt("10.0.0.2")).status, 429);
    } finally {
      h.close();
    }
  });

  test("a successful login clears the counters", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN, loginMaxAttempts: "3", loginWindowMinutes: "15" });
    try {
      await bootstrap(h);
      const wrong = () =>
        h.json("/api/admin/login", {
          method: "POST",
          admin: true,
          body: JSON.stringify({ username: USERNAME, verifier: fakeVerifier("wrong") }),
        });

      await wrong();
      await wrong();
      const ok = await h.json("/api/admin/login", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ username: USERNAME, verifier: fakeVerifier("correct horse battery staple") }),
      });
      assert.equal(ok.status, 200);

      // Two failures should be affordable again, not three-plus.
      assert.equal((await wrong()).status, 401);
      assert.equal((await wrong()).status, 401);
      assert.equal((await wrong()).status, 401);
      assert.equal((await wrong()).status, 429);
    } finally {
      h.close();
    }
  });

  test("the username in a bucket key is hashed, not stored", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h);
      await h.json("/api/admin/login", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ username: USERNAME, verifier: fakeVerifier("wrong") }),
      });

      const buckets = h.db.sqlite
        .prepare("SELECT bucket FROM rate_limits")
        .all() as { bucket: string }[];
      assert.ok(buckets.length > 0);
      for (const { bucket } of buckets) {
        assert.ok(!bucket.includes(USERNAME), `bucket key leaks the username: ${bucket}`);
      }
    } finally {
      h.close();
    }
  });
});

describe("session cookies", () => {
  test("is HttpOnly, SameSite=Strict, Path=/ and Secure on https", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN, publicOrigin: TEST_ORIGIN });
    try {
      const response = await h.request("/api/admin/bootstrap", {
        method: "POST",
        admin: true,
        body: JSON.stringify({
          bootstrap_token: BOOTSTRAP_TOKEN,
          username: USERNAME,
          verifier: fakeVerifier("pw"),
          salt: testSalt(),
        }),
      });
      const cookie = response.headers.get("set-cookie") ?? "";
      assert.ok(cookie.includes("HttpOnly"), cookie);
      assert.ok(cookie.includes("SameSite=Strict"), cookie);
      assert.ok(cookie.includes("Path=/"), cookie);
      assert.ok(cookie.includes("Secure"), cookie);
      // __Host- is only valid with Secure + Path=/ + no Domain, and the browser
      // enforces it. It blocks a subdomain from shadowing this cookie.
      assert.ok(cookie.startsWith("__Host-"), cookie);
      assert.ok(!cookie.includes("Domain="), cookie);
    } finally {
      h.close();
    }
  });

  test("drops Secure and the __Host- prefix for a loopback origin, so local dev works", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN, publicOrigin: "http://localhost:8787" });
    try {
      const response = await h.request("/api/admin/bootstrap", {
        method: "POST",
        admin: true,
        headers: { origin: "http://localhost:8787" },
        body: JSON.stringify({
          bootstrap_token: BOOTSTRAP_TOKEN,
          username: USERNAME,
          verifier: fakeVerifier("pw"),
          salt: testSalt(),
        }),
      });
      const cookie = response.headers.get("set-cookie") ?? "";
      // A browser rejects a Secure cookie on plain http, so local dev would have
      // no session at all. Loopback is the one case this applies to.
      assert.ok(!cookie.includes("Secure"), cookie);
      assert.ok(!cookie.startsWith("__Host-"), cookie);
      assert.ok(cookie.includes("HttpOnly"), cookie);
      assert.ok(cookie.includes("SameSite=Strict"), cookie);
    } finally {
      h.close();
    }
  });

  test("stores only the hash of the token", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h);
      const token = h.sessionToken();
      assert.ok(token);

      const stored = h.db.sqlite
        .prepare("SELECT token_hash FROM admin_sessions")
        .all() as { token_hash: string }[];
      assert.equal(stored.length, 1);
      // A dump of admin_sessions must not be replayable as a login.
      assert.notEqual(stored[0]!.token_hash, token);
      assert.equal(stored[0]!.token_hash, await sha256Hex(token));
    } finally {
      h.close();
    }
  });

  test("logout clears the cookie and the session row", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h);
      const response = await h.request("/api/admin/logout", { method: "POST", admin: true });
      assert.ok((response.headers.get("set-cookie") ?? "").includes("Max-Age=0"));

      const remaining = h.db.sqlite
        .prepare("SELECT count(*) AS n FROM admin_sessions")
        .get() as { n: number };
      assert.equal(remaining.n, 0);
    } finally {
      h.close();
    }
  });

  test("ignores a token that was never issued", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      const { status } = await h.json("/api/admin/apps", {
        headers: { cookie: "wafx_admin=not-a-real-token" },
      });
      assert.equal(status, 401);
    } finally {
      h.close();
    }
  });

  test("requires a session for every admin route", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      const routes: [string, string][] = [
        ["GET", "/api/admin/me"],
        ["GET", "/api/admin/categories"],
        ["POST", "/api/admin/categories"],
        ["GET", "/api/admin/apps"],
        ["PUT", "/api/admin/apps/firefox"],
        ["GET", "/api/admin/apps/firefox"],
        ["DELETE", "/api/admin/apps/firefox"],
        ["GET", "/api/admin/apps/firefox/versions"],
        ["POST", "/api/admin/apps/firefox/versions"],
        ["PATCH", "/api/admin/versions/abc"],
        ["DELETE", "/api/admin/versions/abc"],
        ["GET", "/api/admin/releases"],
        ["POST", "/api/admin/releases"],
        ["PATCH", "/api/admin/releases/abc"],
        ["DELETE", "/api/admin/releases/abc"],
        ["GET", "/api/admin/audit"],
      ];

      for (const [method, path] of routes) {
        const { status } = await h.json(path, {
          method,
          admin: true,
          body: method === "GET" ? undefined : "{}",
        });
        // 401 rather than 404: the route exists and is gated, not absent.
        assert.equal(status, 401, `${method} ${path} answered ${status} without a session`);
      }
    } finally {
      h.close();
    }
  });

  test("disabling an admin revokes the session immediately", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h);
      assert.equal((await h.json("/api/admin/apps")).status, 200);

      h.db.sqlite.prepare("UPDATE admins SET disabled = 1").run();

      // Not "at the next cookie expiry": on the next request.
      const { status } = await h.json("/api/admin/apps");
      assert.equal(status, 401);
      const remaining = h.db.sqlite
        .prepare("SELECT count(*) AS n FROM admin_sessions")
        .get() as { n: number };
      assert.equal(remaining.n, 0, "revoked session row was not removed");
    } finally {
      h.close();
    }
  });

  test("an expired session is refused and removed", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h);
      h.db.sqlite
        .prepare("UPDATE admin_sessions SET expires_at = '2000-01-01T00:00:00Z'")
        .run();

      const { status } = await h.json("/api/admin/apps");
      assert.equal(status, 401);
      const remaining = h.db.sqlite
        .prepare("SELECT count(*) AS n FROM admin_sessions")
        .get() as { n: number };
      assert.equal(remaining.n, 0);
    } finally {
      h.close();
    }
  });

  test("a live session slides forward on use", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN, sessionTtlHours: "1" });
    try {
      await bootstrap(h);
      // One second left, rather than already expired: an expired session is
      // deleted on sight, so there would be nothing left to observe.
      h.db.sqlite
        .prepare("UPDATE admin_sessions SET expires_at = ?")
        .run(new Date(Date.now() + 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
      const response = await h.request("/api/admin/apps");
      assert.equal(response.status, 200);

      const row = h.db.sqlite
        .prepare("SELECT expires_at FROM admin_sessions")
        .get() as { expires_at: string };
      // Expiry is recomputed from the request time, not extended by the old
      // value, so a use after a long idle gap still gets a full window.
      const hoursAhead = (Date.parse(row.expires_at) - Date.now()) / 3_600_000;
      assert.ok(hoursAhead > 0.9, `expires_at was not slid forward: ${row.expires_at}`);
    } finally {
      h.close();
    }
  });
});

describe("password change", () => {
  test("changes the verifier and revokes other sessions", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      const password = "first password";
      await bootstrap(h, { password });
      const originalSalt = testSalt(USERNAME);

      // A second browser, signed in with the same account.
      h.db.sqlite
        .prepare(
          "INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)",
        )
        .run(
          await sha256Hex("second-session-token"),
          (h.db.sqlite.prepare("SELECT id FROM admins").get() as { id: string }).id,
          "2099-01-01T00:00:00Z",
        );

      const { status, body } = await h.json<{ salt: string; iterations: number }>(
        "/api/admin/password",
        {
          method: "POST",
          admin: true,
          body: JSON.stringify({
            current_verifier: fakeVerifier(password),
            new_verifier: fakeVerifier("second password"),
          }),
        },
      );
      assert.equal(status, 200);
      // The server generates the salt on a change, so the stored one rotates and
      // the same password never yields the same verifier twice.
      assert.match(body.salt, /^[0-9a-f]{32}$/);
      assert.notEqual(body.salt, originalSalt);
      assert.equal(body.iterations, 600_000);

      const remaining = h.db.sqlite
        .prepare("SELECT count(*) AS n FROM admin_sessions")
        .get() as { n: number };
      // The other session dies; the caller's own survives so they are not booted
      // out of the panel by changing the password.
      assert.equal(remaining.n, 1);
    } finally {
      h.close();
    }
  });

  test("refuses a wrong current verifier", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h, { password: "first password" });
      const { status } = await h.json("/api/admin/password", {
        method: "POST",
        admin: true,
        body: JSON.stringify({
          current_verifier: fakeVerifier("not it"),
          new_verifier: fakeVerifier("second password"),
        }),
      });
      assert.equal(status, 401);
    } finally {
      h.close();
    }
  });

  test("the new password works and the old one does not", async () => {
    const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
    try {
      await bootstrap(h, { password: "first password" });
      await h.json("/api/admin/password", {
        method: "POST",
        admin: true,
        body: JSON.stringify({
          current_verifier: fakeVerifier("first password"),
          new_verifier: fakeVerifier("second password"),
        }),
      });
      await h.request("/api/admin/logout", { method: "POST", admin: true });

      const withNew = await h.json("/api/admin/login", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ username: USERNAME, verifier: fakeVerifier("second password") }),
      });
      assert.equal(withNew.status, 200);

      const withOld = await h.json("/api/admin/login", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ username: USERNAME, verifier: fakeVerifier("first password") }),
      });
      assert.equal(withOld.status, 401);
    } finally {
      h.close();
    }
  });
});

describe("cookie helpers", () => {
  test("parseCookies reads a normal header", () => {
    const cookies = parseCookies("a=1; b=2; c=3");
    assert.equal(cookies.get("a"), "1");
    assert.equal(cookies.get("b"), "2");
    assert.equal(cookies.get("c"), "3");
  });

  test("parseCookies handles an empty or missing header", () => {
    assert.equal(parseCookies(undefined).size, 0);
    assert.equal(parseCookies("").size, 0);
    assert.equal(parseCookies(null).size, 0);
  });

  test("parseCookies refuses to guess between duplicate names", () => {
    // Ambiguity here is a session-fixation opportunity: an attacker who can add a
    // cookie of the same name wins if the server picks first or last.
    const cookies = parseCookies("wafx_admin=first; wafx_admin=second");
    assert.equal(cookies.get("wafx_admin"), "");
    assert.equal(readSessionToken("wafx_admin=first; wafx_admin=second"), null);
  });

  test("parseCookies tolerates a quoted value and stray whitespace", () => {
    const cookies = parseCookies('  a = "1" ;b=2;');
    assert.equal(cookies.get("a"), "1");
    assert.equal(cookies.get("b"), "2");
  });

  test("readSessionToken accepts either cookie name", () => {
    assert.equal(readSessionToken("wafx_admin=t"), "t");
    assert.equal(readSessionToken("__Host-wafx_admin=t"), "t");
    assert.equal(readSessionToken("other=1"), null);
  });

  test("clearCookieHeader matches the name and path used to set it", () => {
    // A clear that does not match the original name or path leaves the cookie in
    // place, so signing out would appear to work and then not.
    const set = sessionCookieHeader("token", 3600, true);
    const clear = clearCookieHeader(true);
    assert.ok(set.startsWith("__Host-wafx_admin="));
    assert.ok(clear.startsWith("__Host-wafx_admin="));
    for (const attribute of ["Path=/", "HttpOnly", "SameSite=Strict"]) {
      assert.ok(clear.includes(attribute), `clear cookie is missing ${attribute}: ${clear}`);
    }
    assert.ok(clear.includes("Max-Age=0"));
  });
});
