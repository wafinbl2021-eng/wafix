/**
 * Security tests.
 *
 * These assert the properties the whole design exists to hold, rather than the
 * behaviour of any one endpoint:
 *
 *   - No endpoint accepts anything that could become a command on a user's
 *     machine, and no endpoint returns one either.
 *   - Nothing that reaches the desktop app's installer path can be set to a
 *     non-https URL or to a value outside its closed set.
 *   - Mutating requests require a same-origin signal, so a page on another origin
 *     cannot drive the API with a signed-in operator's cookie.
 *   - Nothing leaks: no admin rows, no drafts, no credentials, no internal detail.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { harness, fakeVerifier, testSalt } from "./harness.ts";

const BOOTSTRAP_TOKEN = "bootstrap-token-32-characters-long!!";

async function signedIn(options: { origin?: string } = {}): Promise<ReturnType<typeof harness>> {
  const h = harness({
    bootstrapToken: BOOTSTRAP_TOKEN,
    ...(options.origin === undefined ? {} : { publicOrigin: options.origin }),
  });
  await h.json("/api/admin/bootstrap", {
    method: "POST",
    admin: true,
    body: JSON.stringify({
      bootstrap_token: BOOTSTRAP_TOKEN,
      username: "wafi",
      verifier: fakeVerifier("pw"),
      salt: testSalt(),
    }),
  });
  return h;
}

const VERSION_PATH = "/api/admin/apps/firefox/versions";

/** A version payload that is valid in every respect except what a test changes. */
function validVersion(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: "1.0.0",
    installer_type: "exe",
    installer_mode: "silent",
    installer_url: "https://downloads.example/app-1.0.0.exe",
    ...overrides,
  });
}

async function withApp(h: ReturnType<typeof harness>): Promise<void> {
  await h.json("/api/admin/apps/firefox", {
    method: "PUT",
    admin: true,
    body: JSON.stringify({ name: "Firefox" }),
  });
}

// ---------------------------------------------------------------------------
// The core property: nothing here can execute anything
// ---------------------------------------------------------------------------

describe("no remote command execution surface", () => {
  /**
   * Every name an "extra installer arguments" field plausibly goes by. If any one
   * of these were accepted and stored, the desktop app would be launching an
   * attacker-chosen command line with elevated privileges.
   */
  const EXECUTION_FIELDS = [
    "args",
    "argv",
    "arguments",
    "params",
    "parameters",
    "flags",
    "switches",
    "installer_args",
    "installerArgs",
    "extra_args",
    "extraArgs",
    "command",
    "cmd",
    "commands",
    "command_line",
    "commandLine",
    "script",
    "shell",
    "exec",
    "run",
    "spawn",
    "powershell",
    "batch",
    "env",
    "environment",
  ];

  test("every execution-shaped field name is refused on every write endpoint", async () => {
    const h = await signedIn();
    try {
      await withApp(h);
      const endpoints: [string, string][] = [
        ["/api/admin/categories", "POST"],
        ["/api/admin/categories/media", "PATCH"],
        ["/api/admin/apps/firefox", "PUT"],
        [VERSION_PATH, "POST"],
      ];

      for (const [path, method] of endpoints) {
        for (const field of EXECUTION_FIELDS) {
          const body: unknown =
            path === "/api/admin/categories" || path === "/api/admin/categories/media"
              ? { name: "x", [field]: "--run=malware" }
              : path === VERSION_PATH
                ? JSON.parse(validVersion({ [field]: "--run=malware" }))
                : { name: "Firefox", [field]: "--run=malware" };

          const { status, body: response } = await h.json<{ error: { fields?: Record<string, string> } }>(
            path,
            { method, admin: true, body: JSON.stringify(body) },
          );

          assert.equal(
            status,
            422,
            `${method} ${path} accepted "${field}" (status ${status})`,
          );
          // The message has to name the field, or the operator reads "Unknown
          // field" and assumes they made a typo.
          assert.ok(
            response.error.fields?.[field] !== undefined,
            `${method} ${path} did not name "${field}" in its error`,
          );
        }
      }
    } finally {
      h.close();
    }
  });

  test("the forbidden-field message explains the policy, not just the failure", async () => {
    const h = await signedIn();
    try {
      await withApp(h);
      const { body } = await h.json<{ error: { fields?: Record<string, string> } }>(VERSION_PATH, {
        method: "POST",
        admin: true,
        body: validVersion({ args: "/S" }),
      });
      const message = body.error.fields?.args ?? "";
      assert.match(message, /never accepted/i, message);
      assert.match(message, /fixed in the app/i, message);
    } finally {
      h.close();
    }
  });

  test("no installer_mode expands into anything but the three known modes", async () => {
    const h = await signedIn();
    try {
      await withApp(h);
      // If installer_mode were free text, a value like `--quiet --run=setup.exe`
      // would flow into a privileged CreateProcess. It is a closed enum.
      for (const mode of ["silent /S", "--help", "$(whoami)", "interactive\nsilent", "/S"]) {
        const { status } = await h.json(VERSION_PATH, {
          method: "POST",
          admin: true,
          body: validVersion({ installer_mode: mode, version: `1.0.${Math.floor(Math.random() * 1e6)}` }),
        });
        assert.equal(status, 422, `installer_mode "${mode}" was accepted`);
      }

      // And nothing landed in the database.
      const { n } = h.db.sqlite
        .prepare("SELECT count(*) AS n FROM app_versions")
        .get() as { n: number };
      assert.equal(n, 0);
    } finally {
      h.close();
    }
  });

  test("installer_type is restricted to exe and msi", async () => {
    const h = await signedIn();
    try {
      await withApp(h);
      for (const type of ["bat", "cmd", "ps1", "msix", "appx", "jar", "sh", "dll", "exe.exe"]) {
        const { status } = await h.json(VERSION_PATH, {
          method: "POST",
          admin: true,
          body: validVersion({ installer_type: type, version: `2.0.${EXCEPT_KEYS[type] ?? "0"}` }),
        });
        assert.equal(status, 422, `installer_type "${type}" was accepted`);
      }
    } finally {
      h.close();
    }
  });

  test("the public feed never returns an execution-shaped field", async () => {
    const h = await signedIn();
    try {
      await withApp(h);
      await h.json(VERSION_PATH, {
        method: "POST",
        admin: true,
        body: validVersion({ published: true }),
      });
      await h.json("/api/admin/apps/firefox", {
        method: "PUT",
        admin: true,
        body: JSON.stringify({ name: "Firefox", published: true }),
      });

      for (const path of ["/api/apps", "/api/apps/firefox", "/api/meta"]) {
        const { body } = await h.json<Record<string, unknown>>(path);
        const raw = JSON.stringify(body);
        for (const field of EXECUTION_FIELDS) {
          assert.ok(!raw.includes(`"${field}"`), `${path} contains "${field}"`);
        }
      }
    } finally {
      h.close();
    }
  });

  test("no endpoint exists that could report or control a client machine", async () => {
    const h = await signedIn();
    try {
      // Named here because "is there an endpoint for X?" is the question this
      // design is meant to answer with a no, and a test is a better record of
      // that than a comment.
      const forbidden = [
        "device",
        "devices",
        "machines",
        "hosts",
        "clients",
        "telemetry",
        "heartbeat",
        "command",
        "commands",
        "execute",
        "exec",
        "run",
        "shell",
        "script",
        "tasks",
        "jobs",
        "install",
        "push",
        "remote",
        "report",
        "reports",
        "diagnostics",
        "events",
        "sessions/devices",
      ];
      for (const name of forbidden) {
        const { status } = await h.json(`/api/${name}`);
        assert.equal(status, 404, `/api/${name} exists`);
      }
    } finally {
      h.close();
    }
  });

  test("r2 is storable in the schema but refused by the API, since no bucket exists", async () => {
    const h = await signedIn();
    try {
      await withApp(h);
      const { status, body } = await h.json<{ error: { fields?: Record<string, string> } }>(
        VERSION_PATH,
        {
          method: "POST",
          admin: true,
          body: validVersion({
            installer_url_kind: "r2",
            installer_url: "installers/app.exe",
          }),
        },
      );
      // 422 with an explanation, not a stored row whose key resolves to nothing.
      assert.equal(status, 422);
      assert.match(body.error.fields?.installer_url_kind ?? "", /not enabled|bucket/i);
      assert.equal(
        (h.db.sqlite.prepare("SELECT count(*) AS n FROM app_versions").get() as { n: number }).n,
        0,
      );
    } finally {
      h.close();
    }
  });

  test("a public feed never contains an r2 row even if one exists", async () => {
    const h = await signedIn();
    try {
      // Inserted directly, bypassing the API, to simulate a row left behind by a
      // future storage migration. The read filter must make it invisible.
      h.db.sqlite
        .prepare(
          `INSERT INTO apps (id, name, published) VALUES ('stashed', 'Stashed', 1)`,
        )
        .run();
      h.db.sqlite
        .prepare(
          `INSERT INTO app_versions (id, app_id, version, installer_type, installer_mode,
                                     installer_url_kind, installer_url, published)
           VALUES ('sv1', 'stashed', '1.0.0', 'exe', 'silent', 'r2', 'installers/a.exe', 1)`,
        )
        .run();

      const { body } = await h.json<{ apps: { id: string; versions: unknown[] }[] }>("/api/apps");
      const stashed = body.apps.find((a) => a.id === "stashed");
      // The app appears, with no usable version - better than advertising a
      // version whose key the desktop app cannot resolve.
      assert.ok(stashed);
      assert.deepEqual(stashed.versions, []);
      assert.ok(!JSON.stringify(body).includes("installers/a.exe"));
    } finally {
      h.close();
    }
  });
});

/** Distinct version numbers, so a loop's later iterations are not duplicates. */
const EXCEPT_KEYS: Record<string, number> = {
  bat: 1,
  cmd: 2,
  ps1: 3,
  msix: 4,
  appx: 5,
  jar: 6,
  sh: 7,
  dll: 8,
  "exe.exe": 9,
};

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

describe("https only", () => {
  const NON_HTTPS = [
    "http://downloads.example/app.exe",
    "ftp://downloads.example/app.exe",
    "file:///C:/Windows/System32/cmd.exe",
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "//downloads.example/app.exe",
    "\\\\evil.example\\share\\app.exe",
    "C:\\Windows\\System32\\cmd.exe",
    "/etc/passwd",
  ];

  test("refuses a non-https installer URL", async () => {
    const h = await signedIn();
    try {
      await withApp(h);
      for (const [index, url] of NON_HTTPS.entries()) {
        const { status } = await h.json(VERSION_PATH, {
          method: "POST",
          admin: true,
          body: validVersion({ installer_url: url, version: `3.0.${index}` }),
        });
        assert.equal(status, 422, `installer_url "${url}" was accepted`);
      }
      assert.equal(
        (h.db.sqlite.prepare("SELECT count(*) AS n FROM app_versions").get() as { n: number }).n,
        0,
      );
    } finally {
      h.close();
    }
  });

  test("refuses a non-https homepage or icon", async () => {
    const h = await signedIn();
    try {
      for (const field of ["homepage_url", "icon_url"]) {
        const { status } = await h.json("/api/admin/apps/firefox", {
          method: "PUT",
          admin: true,
          body: JSON.stringify({
            name: "Firefox",
            icon_kind: field === "icon_url" ? "external" : "none",
            [field]: "http://insecure.example/x",
          }),
        });
        assert.equal(status, 422, `${field} accepted an http URL`);
      }
    } finally {
      h.close();
    }
  });

  test("refuses a URL carrying embedded credentials", async () => {
    const h = await signedIn();
    try {
      await withApp(h);
      const { status } = await h.json(VERSION_PATH, {
        method: "POST",
        admin: true,
        body: validVersion({ installer_url: "https://downloads.example@evil.example/app.exe" }),
      });
      // That URL renders as "downloads.example" and resolves to evil.example.
      assert.equal(status, 422);
    } finally {
      h.close();
    }
  });

  test("refuses a release URL that is not https", async () => {
    const h = await signedIn();
    try {
      const { status } = await h.json("/api/admin/releases", {
        method: "POST",
        admin: true,
        body: JSON.stringify({
          version: "1.2.3",
          channel: "stable",
          installer_url: "http://downloads.example/wafix.exe",
          notes: "n",
        }),
      });
      assert.equal(status, 422);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

describe("cross-origin requests", () => {
  /** Every mutating route, so the middleware is tested everywhere it applies. */
  const MUTATIONS: [string, string, Record<string, unknown>][] = [
    ["/api/admin/bootstrap", "POST", { bootstrap_token: BOOTSTRAP_TOKEN, username: "x", verifier: "0".repeat(64), salt: "a".repeat(32) }],
    ["/api/admin/login", "POST", { username: "wafi", verifier: "0".repeat(64) }],
    ["/api/admin/logout", "POST", {}],
    ["/api/admin/password", "POST", { current_verifier: "0".repeat(64), new_verifier: "1".repeat(64) }],
    ["/api/admin/categories", "POST", { id: "x", name: "X" }],
    ["/api/admin/categories/x", "PATCH", { name: "X" }],
    ["/api/admin/categories/x", "DELETE", {}],
    ["/api/admin/apps/x", "PUT", { name: "X" }],
    ["/api/admin/apps/x", "DELETE", {}],
    ["/api/admin/apps/x/versions", "POST", { version: "1.0.0", installer_type: "exe", installer_url: "https://a.example/b.exe" }],
    ["/api/admin/versions/v1", "PATCH", { published: true }],
    ["/api/admin/versions/v1", "DELETE", {}],
    ["/api/admin/releases", "POST", { version: "1.2.3", channel: "stable", installer_url: "https://a.example/b.exe" }],
    ["/api/admin/releases/r1", "PATCH", { notes: "n" }],
    ["/api/admin/releases/r1", "DELETE", {}],
  ];

  test("a request with a foreign Origin is refused on every mutating route", async () => {
    const h = await signedIn();
    try {
      for (const [path, method, body] of MUTATIONS) {
        const { status } = await h.json(path, {
          method,
          admin: true,
          csrf: false,
          headers: { origin: "https://evil.example" },
          body: JSON.stringify(body),
        });
        // 403, and never anything that suggests the request was considered.
        assert.equal(status, 403, `${method} ${path} accepted a foreign Origin (status ${status})`);
      }

      // Nothing was written by any of them. Checked field by field rather than
      // with deepEqual, because node:sqlite returns null-prototype objects.
      const counts = h.db.sqlite
        .prepare(
          `SELECT (SELECT count(*) FROM app_categories) AS c,
                  (SELECT count(*) FROM apps) AS a,
                  (SELECT count(*) FROM app_versions) AS v,
                  (SELECT count(*) FROM wafx_releases) AS r`,
        )
        .get() as { c: number; a: number; v: number; r: number };
      assert.equal(counts.c, 0, "a category was created by a cross-origin request");
      assert.equal(counts.a, 0, "an application was created by a cross-origin request");
      assert.equal(counts.v, 0, "a version was created by a cross-origin request");
      assert.equal(counts.r, 0, "a release was created by a cross-origin request");
    } finally {
      h.close();
    }
  });

  test("a request with no custom header is refused, even from the right origin", async () => {
    const h = await signedIn();
    try {
      // Origin alone is not enough: a cross-origin form post carries the right
      // Origin for a same-origin target in some browsers, and no custom header
      // can be set by a form at all. Requiring both means a form cannot reach
      // this API.
      const { status } = await h.json("/api/admin/categories", {
        method: "POST",
        csrf: false,
        headers: { origin: "https://wafx-api.test" },
        body: JSON.stringify({ id: "smuggled", name: "Smuggled" }),
      });
      assert.equal(status, 403);
      assert.equal(
        (h.db.sqlite.prepare("SELECT count(*) AS n FROM app_categories").get() as { n: number }).n,
        0,
      );
    } finally {
      h.close();
    }
  });

  test("a request with a foreign Referer and no Origin is refused", async () => {
    const h = await signedIn();
    try {
      const { status } = await h.json("/api/admin/categories", {
        method: "POST",
        csrf: false,
        headers: { referer: "https://evil.example/page" },
        body: JSON.stringify({ id: "smuggled", name: "Smuggled" }),
      });
      assert.equal(status, 403);
    } finally {
      h.close();
    }
  });

  test("a same-origin Referer with no Origin is accepted", async () => {
    const h = await signedIn();
    try {
      const { status } = await h.json("/api/admin/categories", {
        method: "POST",
        csrf: false,
        admin: true,
        headers: { referer: "https://wafx-api.test/admin/" },
        body: JSON.stringify({ id: "tools", name: "Tools" }),
      });
      assert.equal(status, 201);
    } finally {
      h.close();
    }
  });

  test("a request with neither Origin nor Referer is accepted with the admin header", async () => {
    // This is the path `scripts/seed-admin.ts` and `curl` take: a terminal is not
    // a browser and sends neither header. The custom header is what keeps this
    // safe - a page on another origin cannot set it without a CORS preflight
    // this Worker never approves.
    const h = await signedIn();
    try {
      const { status } = await h.json("/api/admin/categories", {
        method: "POST",
        csrf: false,
        admin: true,
        body: JSON.stringify({ id: "media", name: "Media" }),
      });
      assert.equal(status, 201);
    } finally {
      h.close();
    }
  });

  test("the same-origin request the panel actually sends is accepted", async () => {
    const h = await signedIn();
    try {
      const { status } = await h.json("/api/admin/categories", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ id: "media", name: "Media" }),
      });
      // Otherwise the check above would be indistinguishable from a broken panel.
      assert.equal(status, 201);
    } finally {
      h.close();
    }
  });

  test("a read is not blocked by the cross-origin check", async () => {
    const h = await signedIn();
    try {
      // The catalog is public and cross-origin readable by design - the desktop
      // app is a different origin from this API. Blocking reads would break it.
      assert.equal((await h.json("/api/apps")).status, 200);
      assert.equal((await h.json("/api/admin/apps")).status, 200);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Request limits
// ---------------------------------------------------------------------------

describe("request limits", () => {
  test("refuses an oversized body without reading it into a buffer", async () => {
    const h = await signedIn();
    try {
      await withApp(h);
      const { status } = await h.json(VERSION_PATH, {
        method: "POST",
        admin: true,
        body: JSON.stringify({
          ...JSON.parse(validVersion()),
          notes: "x".repeat(2_000_000),
        }),
      });
      // The description column allows 2000 characters, so a megabyte of notes is
      // refused either way - what matters is that it is refused rather than
      // parsed.
      assert.ok(status === 413 || status === 422, `unexpected status ${status}`);
    } finally {
      h.close();
    }
  });

  test("refuses a body that is not JSON", async () => {
    const h = await signedIn();
    try {
      const { status } = await h.json("/api/admin/categories", {
        method: "POST",
        admin: true,
        body: "not json at all",
      });
      assert.equal(status, 400);
    } finally {
      h.close();
    }
  });

  test("refuses a JSON body that is not an object", async () => {
    const h = await signedIn();
    try {
      for (const body of ["[1,2,3]", '"a string"', "42", "null"]) {
        const { status } = await h.json("/api/admin/categories", {
          method: "POST",
          admin: true,
          body,
        });
        assert.equal(status, 400, `body ${body} was accepted`);
      }
    } finally {
      h.close();
    }
  });

  test("a wrong content type is refused", async () => {
    const h = await signedIn();
    try {
      const { status } = await h.json("/api/admin/categories", {
        method: "POST",
        admin: true,
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ id: "x", name: "X" }),
      });
      assert.ok(status === 400 || status === 415, `unexpected status ${status}`);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

describe("nothing leaks", () => {
  test("an unauthenticated caller learns nothing about admin accounts", async () => {
    const h = await signedIn();
    try {
      for (const path of ["/api/admin/apps", "/api/admin/categories", "/api/admin/audit", "/api/admin/me", "/api/admin/releases"]) {
        const { status, body } = await h.json<Record<string, unknown>>(path, {
          headers: { cookie: "wafx_admin=made-up" },
        });
        // 401, and the body carries no data from any table.
        assert.equal(status, 401, `${path} answered ${status} to a forged cookie`);
        const raw = JSON.stringify(body);
        for (const leak of ["wafi", "password", "salt", "hash", "admins", "sessions"]) {
          assert.ok(!raw.includes(leak), `${path} mentions "${leak}" in a 401`);
        }
      }
    } finally {
      h.close();
    }
  });

  test("the public catalog excludes unpublished rows at every level", async () => {
    const h = await signedIn();
    try {
      await h.json("/api/admin/categories", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ id: "tools", name: "Tools" }),
      });
      await h.json("/api/admin/apps/visible", {
        method: "PUT",
        admin: true,
        body: JSON.stringify({ name: "Visible", category_id: "tools", published: true }),
      });
      await h.json("/api/admin/apps/hidden", {
        method: "PUT",
        admin: true,
        body: JSON.stringify({ name: "Hidden Draft", category_id: "tools", published: false }),
      });

      const list = await h.json<{ body: unknown }>("/api/apps");
      const raw = JSON.stringify(list.body);
      assert.ok(!raw.includes("hidden"), "a draft app id leaked");
      assert.ok(!raw.includes("Hidden Draft"), "a draft app name leaked");

      const detail = await h.json("/api/apps/hidden");
      assert.equal(detail.status, 404);
      assert.ok(!JSON.stringify(detail.body).includes("Hidden"));
    } finally {
      h.close();
    }
  });

  test("a published app with only a draft version is not advertised as installable", async () => {
    const h = await signedIn();
    try {
      await h.json("/api/admin/apps/draftonly", {
        method: "PUT",
        admin: true,
        body: JSON.stringify({ name: "Draft Only", published: true }),
      });
      await h.json("/api/admin/apps/draftonly/versions", {
        method: "POST",
        admin: true,
        body: validVersion(),
      });

      const { body } = await h.json<{ apps: { id: string; latest_version: string | null }[] }>("/api/apps");
      const app = body.apps.find((a) => a.id === "draftonly");
      assert.ok(app);
      // No published version means nothing to install. Saying so explicitly is
      // better than a null the client has to interpret.
      assert.equal(app.latest_version, null);
    } finally {
      h.close();
    }
  });

  test("an error response carries no SQL, no path and no stack", async () => {
    const h = await signedIn();
    try {
      const probes: [string, string, Record<string, unknown>][] = [
        ["/api/admin/apps", "PUT", { name: "x", category_id: "ghost" }],
        [VERSION_PATH, "POST", validVersionAsObject()],
        ["/api/admin/categories", "POST", { id: "Bad Slug!", name: "x" }],
        ["/api/admin/releases", "POST", { version: "not-a-version", channel: "stable", installer_url: "https://a.example/b" }],
      ];

      for (const [path, method, body] of probes) {
        const response = await h.request(path, {
          method,
          admin: true,
          body: JSON.stringify(body),
        });
        const text = await response.text();
        for (const leak of ["SELECT ", "INSERT INTO", "UPDATE ", "sqlite", "node_modules", "at Object.", "harness.ts", "src/"]) {
          assert.ok(!text.includes(leak), `${method} ${path} leaked "${leak}": ${text.slice(0, 200)}`);
        }
      }
    } finally {
      h.close();
    }
  });

  test("a constraint failure does not echo the submitted value", async () => {
    const h = await signedIn();
    try {
      // Duplicate category, with a distinctive value in the name. The 409 must
      // not repeat it, so a log of responses cannot be used to read stored data.
      await h.json("/api/admin/categories", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ id: "dup", name: "Original" }),
      });
      const { status, body } = await h.json<{ error: { message: string } }>("/api/admin/categories", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ id: "dup", name: "SENTINEL-SHOULD-NOT-APPEAR" }),
      });
      assert.equal(status, 409);
      assert.ok(!JSON.stringify(body).includes("SENTINEL"), "the response echoed the submitted value");
      // And the stored value is untouched.
      const row = h.db.sqlite
        .prepare("SELECT name FROM app_categories WHERE id = 'dup'")
        .get() as { name: string };
      assert.equal(row.name, "Original");
    } finally {
      h.close();
    }
  });
});

function validVersionAsObject(): Record<string, unknown> {
  return {
    version: "not a version",
    installer_type: "bat",
    installer_url: "http://insecure.example/x",
  };
}