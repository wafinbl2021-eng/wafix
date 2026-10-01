/**
 * Public API tests.
 *
 * The public surface is the whole attack surface, so these tests concentrate on
 * what an unauthenticated caller can see: only published rows, only external
 * URLs, and never a draft that exists in the database.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { harness } from "./harness.ts";

interface VersionJson {
  id: string;
  version: string;
  installer_type: string;
  installer_mode: string;
  installer_url_kind: string;
  installer_url: string;
  installer_sha256: string | null;
}

interface AppJson {
  id: string;
  name: string;
  description: string;
  published?: boolean;
  featured: boolean;
  category_id: string | null;
  category_name: string | null;
  versions: VersionJson[];
  latest_version: string | null;
}

/** Seeds one app with one published external version. */
function seedApp(
  h: ReturnType<typeof harness>,
  options: {
    id: string;
    name?: string;
    published?: boolean;
    featured?: boolean;
    category?: string | null;
    version?: string;
    versionPublished?: boolean;
    urlKind?: string;
    installerMode?: string;
    installerType?: string;
  },
): void {
  if (options.category) {
    h.db.sqlite
      .prepare("INSERT OR IGNORE INTO app_categories (id, name) VALUES (?, ?)")
      .run(options.category, options.category);
  }
  h.db.sqlite
    .prepare(
      `INSERT INTO apps (id, name, description, category_id, published, featured, icon_kind)
       VALUES (?, ?, '', ?, ?, ?, 'none')`,
    )
    .run(
      options.id,
      options.name ?? options.id,
      options.category ?? null,
      options.published === false ? 0 : 1,
      options.featured === true ? 1 : 0,
    );
  seedVersion(h, options.id, {
    version: options.version ?? "1.0",
    published: options.versionPublished,
    urlKind: options.urlKind,
    installerMode: options.installerMode,
    installerType: options.installerType,
  });
}

/** Adds a version to an app that {@link seedApp} already created. */
function seedVersion(
  h: ReturnType<typeof harness>,
  appId: string,
  options: {
    version: string;
    published?: boolean;
    urlKind?: string;
    installerMode?: string;
    installerType?: string;
    releaseDate?: string;
  },
): void {
  h.db.sqlite
    .prepare(
      `INSERT INTO app_versions (id, app_id, version, installer_type, installer_mode,
                                 installer_url_kind, installer_url, published, release_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `v-${appId}-${options.version}`,
      appId,
      options.version,
      options.installerType ?? "exe",
      options.installerMode ?? "silent",
      options.urlKind ?? "external",
      `https://downloads.example/${appId}-${options.version}.exe`,
      options.published === false ? 0 : 1,
      options.releaseDate ?? options.version,
    );
}

describe("GET /api/apps", () => {
  test("returns an empty list on a fresh database", async () => {
    const h = harness();
    try {
      const { status, body } = await h.json<{ apps: AppJson[]; count: number }>("/api/apps");
      assert.equal(status, 200);
      assert.deepEqual(body.apps, []);
      assert.equal(body.count, 0);
    } finally {
      h.close();
    }
  });

  test("returns a published app with its published version", async () => {
    const h = harness();
    try {
      seedApp(h, { id: "firefox", name: "Mozilla Firefox", version: "131.0" });
      const { body } = await h.json<{ apps: AppJson[] }>("/api/apps");

      assert.equal(body.apps.length, 1);
      const app = body.apps[0]!;
      assert.equal(app.id, "firefox");
      assert.equal(app.name, "Mozilla Firefox");
      assert.equal(app.versions.length, 1);
      assert.equal(app.versions[0]!.version, "131.0");
      assert.equal(app.latest_version, "131.0");
    } finally {
      h.close();
    }
  });

  test("hides an unpublished app entirely", async () => {
    const h = harness();
    try {
      seedApp(h, { id: "firefox" });
      seedApp(h, { id: "secret-tool", published: false });

      const { body } = await h.json<{ apps: AppJson[] }>("/api/apps");
      const ids = body.apps.map((a) => a.id);
      assert.deepEqual(ids, ["firefox"]);
      assert.ok(!JSON.stringify(body).includes("secret-tool"), "draft app leaked");
    } finally {
      h.close();
    }
  });

  test("hides an unpublished version but keeps the app", async () => {
    const h = harness();
    try {
      seedApp(h, { id: "firefox", version: "131.0" });
      seedVersion(h, "firefox", { version: "132.0", published: false });

      const { body } = await h.json<{ apps: AppJson[] }>("/api/apps");
      const app = body.apps[0]!;
      assert.deepEqual(
        app.versions.map((v) => v.version),
        ["131.0"],
      );
      // A draft version must not become the advertised latest.
      assert.equal(app.latest_version, "131.0");
    } finally {
      h.close();
    }
  });

  test("never exposes a public field that is not part of the response shape", async () => {
    const h = harness();
    try {
      seedApp(h, { id: "firefox" });
      const { body } = await h.json<Record<string, unknown>>("/api/apps");
      const app = (body.apps as AppJson[])[0]!;

      // Anything admin-only leaking here would be a real disclosure: a draft
      // flag, the panel's manual ordering, or a count of unpublished rows.
      // `updated_at` is deliberately absent too - it is the panel's edit
      // timestamp, not something a client acts on.
      for (const field of ["position", "created_at", "updated_at", "version_count", "published"]) {
        assert.ok(!(field in app), `public app response contains "${field}"`);
      }
    } finally {
      h.close();
    }
  });

  test("exposes installer mode, because the desktop app needs it to choose a fixed argv", async () => {
    const h = harness();
    try {
      seedApp(h, { id: "firefox", installerMode: "passive" });
      const { body } = await h.json<{ apps: AppJson[] }>("/api/apps");
      // The mode is a value from a three-item enum, not an argument string. The
      // client maps it to a hardcoded argument list in its own code.
      assert.equal(body.apps[0]!.versions[0]!.installer_mode, "passive");
    } finally {
      h.close();
    }
  });

  test("never includes an arguments field on a version", async () => {
    const h = harness();
    try {
      seedApp(h, { id: "firefox" });
      const { body } = await h.json<{ apps: AppJson[] }>("/api/apps");
      const version = body.apps[0]!.versions[0]!;

      for (const field of ["args", "argv", "arguments", "command", "flags", "params"]) {
        assert.ok(!(field in version), `public version contains "${field}"`);
      }
    } finally {
      h.close();
    }
  });

  test("filters to featured when asked", async () => {
    const h = harness();
    try {
      seedApp(h, { id: "firefox", featured: true });
      seedApp(h, { id: "vlc" });

      const { body } = await h.json<{ apps: AppJson[] }>("/api/apps?featured=1");
      assert.deepEqual(
        body.apps.map((a) => a.id),
        ["firefox"],
      );
    } finally {
      h.close();
    }
  });

  test("filters by category", async () => {
    const h = harness();
    try {
      seedApp(h, { id: "firefox", category: "browsers" });
      seedApp(h, { id: "vlc", category: "media" });

      const { body } = await h.json<{ apps: AppJson[] }>("/api/apps?category=browsers");
      assert.deepEqual(
        body.apps.map((a) => a.id),
        ["firefox"],
      );
    } finally {
      h.close();
    }
  });

  test("rejects a malformed category rather than passing it to SQL", async () => {
    const h = harness();
    try {
      // The parameter is bound, not interpolated, so this cannot inject SQL. The
      // test is here because the rejection is deliberate: a nonsense category is
      // a caller bug, and answering 200 with an empty list hides it.
      const { status } = await h.json("/api/apps?category=' OR 1=1--");
      assert.equal(status, 400);
    } finally {
      h.close();
    }
  });

  test("orders featured first, then by position, then by name", async () => {
    const h = harness();
    try {
      seedApp(h, { id: "vlc" });
      seedApp(h, { id: "firefox" });
      h.db.sqlite.prepare("UPDATE apps SET featured = 1 WHERE id = 'firefox'").run();

      const { body } = await h.json<{ apps: AppJson[] }>("/api/apps");
      assert.deepEqual(
        body.apps.map((a) => a.id),
        ["firefox", "vlc"],
      );
    } finally {
      h.close();
    }
  });
});

describe("GET /api/apps/:id", () => {
  test("returns one app", async () => {
    const h = harness();
    try {
      seedApp(h, { id: "firefox", name: "Firefox" });
      const { status, body } = await h.json<{ app: AppJson }>("/api/apps/firefox");
      assert.equal(status, 200);
      assert.equal(body.app.name, "Firefox");
    } finally {
      h.close();
    }
  });

  test("returns 404 for an unpublished app, indistinguishably from a missing one", async () => {
    const h = harness();
    try {
      seedApp(h, { id: "secret-tool", published: false });

      const draft = await h.json<{ error: { code: string; message: string } }>("/api/apps/secret-tool");
      const missing = await h.json<{ error: { code: string; message: string } }>("/api/apps/does-not-exist");

      // Identical, so the endpoint cannot be used to discover that a draft exists.
      assert.equal(draft.status, 404);
      assert.equal(missing.status, 404);
      assert.deepEqual(draft.body, missing.body);
    } finally {
      h.close();
    }
  });

  test("returns 404 for a non-slug id", async () => {
    const h = harness();
    try {
      const { status } = await h.json("/api/apps/FIREFOX");
      assert.equal(status, 404);
    } finally {
      h.close();
    }
  });
});

describe("GET /api/categories", () => {
  test("counts only published apps in each category", async () => {
    const h = harness();
    try {
      h.db.sqlite
        .prepare("INSERT INTO app_categories (id, name, sort_order) VALUES ('browsers', 'Browsers', 0)")
        .run();
      h.db.sqlite
        .prepare("INSERT INTO app_categories (id, name, sort_order) VALUES ('media', 'Media', 1)")
        .run();
      seedApp(h, { id: "firefox", category: "browsers" });
      seedApp(h, { id: "vlc", category: "media" });
      seedApp(h, { id: "obscure", category: "browsers", published: false });

      const { body } = await h.json<{ categories: { id: string; app_count: number }[] }>(
        "/api/categories",
      );
      const byId = Object.fromEntries(body.categories.map((c) => [c.id, c.app_count]));
      // The draft is counted by the admin list, not this one.
      assert.equal(byId.browsers, 1);
      assert.equal(byId.media, 1);
    } finally {
      h.close();
    }
  });

  test("orders by sort_order", async () => {
    const h = harness();
    try {
      h.db.sqlite
        .prepare("INSERT INTO app_categories (id, name, sort_order) VALUES ('zzz', 'Last', 10)")
        .run();
      h.db.sqlite
        .prepare("INSERT INTO app_categories (id, name, sort_order) VALUES ('aaa', 'First', 1)")
        .run();

      const { body } = await h.json<{ categories: { id: string }[] }>("/api/categories");
      assert.deepEqual(
        body.categories.map((c) => c.id),
        ["aaa", "zzz"],
      );
    } finally {
      h.close();
    }
  });
});

describe("GET /api/meta", () => {
  test("advertises the catalog contract", async () => {
    const h = harness();
    try {
      const { body } = await h.json<Record<string, unknown>>("/api/meta");
      assert.equal(body.schema_version, 1);
      assert.deepEqual(body.installer_modes, ["silent", "passive", "interactive"]);
      assert.deepEqual(body.installer_types, ["exe", "msi"]);
      // Only 'external' is usable, so only 'external' is advertised.
      assert.deepEqual(body.url_kinds, ["external"]);
    } finally {
      h.close();
    }
  });

  test("states that the updater feed is GitHub, not this API", async () => {
    const h = harness();
    try {
      const { body } = await h.json<{ updater_feed: string }>("/api/meta");
      // update_identity.rs pins the download host, so this API is not the feed.
      // Advertising it here makes that explicit rather than a thing to remember.
      assert.equal(body.updater_feed, "github-releases");
    } finally {
      h.close();
    }
  });
});

describe("GET /api/releases/latest", () => {
  test("returns null when nothing is published", async () => {
    const h = harness();
    try {
      const { body } = await h.json<{ release: unknown }>("/api/releases/latest");
      assert.equal(body.release, null);
    } finally {
      h.close();
    }
  });

  test("returns the newest published release", async () => {
    const h = harness();
    try {
      h.db.sqlite
        .prepare(
          `INSERT INTO wafx_releases (id, version, channel, notes, installer_url_kind,
                                     installer_url, published, release_date)
           VALUES ('r1', '1.0.0', 'stable', 'first', 'external', 'https://x.example/1.exe', 1, '2026-01-01')`,
        )
        .run();
      h.db.sqlite
        .prepare(
          `INSERT INTO wafx_releases (id, version, channel, notes, installer_url_kind,
                                     installer_url, published, release_date)
           VALUES ('r2', '2.0.0', 'stable', 'draft', 'external', 'https://x.example/2.exe', 0, '2026-06-01')`,
        )
        .run();

      const { body } = await h.json<{ release: { version: string; notes: string } }>(
        "/api/releases/latest",
      );
      // The unpublished 2.0.0 is newer by date and must still not win.
      assert.equal(body.release.version, "1.0.0");
      assert.equal(body.release.notes, "first");
    } finally {
      h.close();
    }
  });

  test("is not shaped like a Tauri updater response", async () => {
    const h = harness();
    try {
      h.db.sqlite
        .prepare(
          `INSERT INTO wafx_releases (id, version, channel, installer_url_kind, installer_url, published)
           VALUES ('r1', '1.0.0', 'stable', 'external', 'https://x.example/1.exe', 1)`,
        )
        .run();

      const { status, body } = await h.json<{ release: Record<string, unknown> }>(
        "/api/releases/latest",
      );
      assert.equal(status, 200);
      // The Tauri contract is a flat {version, pub_date, url, signature} with a
      // 204 for "no update". This returns a wrapped object with no signature, so
      // a client pointed here by mistake fails instead of installing something.
      assert.ok(body.release && typeof body.release === "object");
      assert.ok(!("signature" in body.release), "response looks like an updater feed");
      assert.ok(!("pub_date" in body.release), "response looks like an updater feed");
    } finally {
      h.close();
    }
  });
});
