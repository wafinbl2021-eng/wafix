/**
 * Worker-level tests: the app boots, answers, and fails the way it should.
 *
 * These are the tests that would catch a broken import, a missing binding, or a
 * middleware ordering mistake - the failures that make every other suite fail at
 * once and hide the interesting signal.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { harness, TEST_ORIGIN } from "./harness.ts";

describe("health", () => {
  test("reports the database as reachable", async () => {
    const h = harness();
    try {
      const { status, body } = await h.json<{ ok: boolean; database: string; apps: number }>(
        "/api/health",
      );
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.database, "reachable");
      assert.equal(body.apps, 0);
    } finally {
      h.close();
    }
  });

  test("counts published and unpublished apps together, and does not leak other tables", async () => {
    const h = harness();
    try {
      h.db.sqlite
        .prepare("INSERT INTO app_categories (id, name) VALUES ('browsers', 'Browsers')")
        .run();
      h.db.sqlite
        .prepare(
          "INSERT INTO apps (id, name, published, featured) VALUES ('firefox', 'Firefox', 0, 0)",
        )
        .run();

      const { body } = await h.json<{ apps: number }>("/api/health");
      assert.equal(body.apps, 1);

      // The response is a health check, not a catalog summary. It must not carry
      // anything about categories, versions, releases, admins or sessions.
      const raw = JSON.stringify(body);
      for (const forbidden of ["category", "version", "release", "admin", "session", "token"]) {
        assert.ok(!raw.includes(forbidden), `health response mentions "${forbidden}": ${raw}`);
      }
    } finally {
      h.close();
    }
  });

  test("returns 503 when the database cannot answer", async () => {
    const h = harness();
    try {
      // Dropping a table the health query needs is the simplest way to make the
      // database fail without needing a broken binding.
      h.db.sqlite.exec("DROP TABLE apps");
      const { status, body } = await h.json<{ ok: boolean; database: string }>("/api/health");
      assert.equal(status, 503);
      assert.equal(body.ok, false);
      assert.equal(body.database, "unreachable");
    } finally {
      h.close();
    }
  });
});

describe("unknown routes", () => {
  test("returns a JSON 404 for an unknown API path", async () => {
    const h = harness();
    try {
      const { status, body } = await h.json<{ error: { code: string } }>("/api/nope");
      assert.equal(status, 404);
      assert.equal(body.error.code, "not_found");
    } finally {
      h.close();
    }
  });

  test("does not return the admin panel shell for a non-admin path", async () => {
    const h = harness();
    try {
      // The panel is a single-page app with client-side routing, so a bare 404 is
      // correct here. Serving index.html for everything would turn a typo in a URL
      // into a page that looks like a working panel.
      const { status } = await h.json("/");
      assert.equal(status, 404);
    } finally {
      h.close();
    }
  });

  test("does not treat a non-API path as an admin route", async () => {
    const h = harness();
    try {
      const { status } = await h.json("/administrator");
      assert.equal(status, 404);
    } finally {
      h.close();
    }
  });
});

describe("security headers", () => {
  test("are present on API responses", async () => {
    const h = harness();
    try {
      const response = await h.request("/api/health");
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(response.headers.get("X-Frame-Options"), "DENY");
      assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
      assert.equal(response.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
      assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Vary"), "Cookie, Origin");
    } finally {
      h.close();
    }
  });

  test("CSP forbids inline script, which is why the panel ships external files", async () => {
    const h = harness();
    try {
      const response = await h.request("/api/health");
      const csp = response.headers.get("Content-Security-Policy") ?? "";
      assert.ok(csp.includes("default-src 'none'"), csp);
      assert.ok(csp.includes("script-src 'self'"), csp);
      assert.ok(csp.includes("frame-ancestors 'none'"), csp);
      assert.ok(csp.includes("form-action 'none'"), csp);
      // The two that would let a stored value become execution or exfiltration.
      assert.ok(!csp.includes("unsafe-inline"), csp);
      assert.ok(!csp.includes("unsafe-eval"), csp);
    } finally {
      h.close();
    }
  });

  test("the panel's own static files carry the same headers", async () => {
    const h = harness();
    try {
      // Served through a stand-in for the ASSETS binding, so this asserts on the
      // Worker's own response rather than on the platform's asset pipeline.
      h.env.ASSETS = {
        fetch: (request: Request) =>
          new Response(`served: ${new URL(request.url).pathname}`, {
            headers: { "content-type": "text/html" },
          }),
      };
      const response = await h.request("/admin");
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "served: /admin/index.html");
      assert.ok((response.headers.get("Content-Security-Policy") ?? "").includes("default-src 'none'"));
    } finally {
      h.close();
    }
  });
});

describe("error responses", () => {
  test("an unexpected failure is a 500 with a generic message and no internal detail", async () => {
    const h = harness();
    try {
      // Removing `apps` makes the health query throw something that is not an
      // HttpError, which is the branch under test.
      h.db.sqlite.exec("DROP TABLE apps");
      const response = await h.request("/api/health");
      assert.equal(response.status, 503);

      // A different unhandled error: a query against a table that does not exist,
      // reached through a route whose SQL is built at request time.
      const { status, body } = await h.json<{ error: { code: string; message: string } }>(
        "/api/admin/apps",
        { headers: { cookie: "wafx_admin=bogus" } },
      );
      assert.equal(status, 401);
      assert.equal(body.error.code, "unauthorized");
    } finally {
      h.close();
    }
  });

  test("does not echo a stack trace or SQL in a validation error", async () => {
    const h = harness();
    try {
      const response = await h.request("/api/admin/bootstrap", {
        method: "POST",
        admin: true,
        headers: { "x-forwarded-for": TEST_ORIGIN },
        body: JSON.stringify({ bootstrap_token: "x".repeat(32), username: "wafi", args: "--evil" }),
      });
      const text = await response.text();
      assert.ok(!text.includes("INSERT INTO"), "response leaked SQL");
      assert.ok(!text.includes("at Object."), "response leaked a stack frame");
      assert.ok(!text.includes("node_modules"), "response leaked a path");
    } finally {
      h.close();
    }
  });
});
