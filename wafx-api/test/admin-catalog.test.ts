/**
 * Admin CRUD tests for categories, applications and versions.
 *
 * These run through the real endpoints, so they cover the panel's actual
 * vocabulary: the field names and shapes `admin/app.js` sends. A field the panel
 * sends that the API does not accept shows up here as a failure rather than as a
 * 422 in front of the operator.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { harness, fakeVerifier, testSalt } from "./harness.ts";

const BOOTSTRAP_TOKEN = "bootstrap-token-32-characters-long!!";

interface Category {
  id: string;
  name: string;
  sort_order: number;
  app_count: number;
  published_app_count: number;
}

interface AdminApp {
  id: string;
  name: string;
  description: string;
  publisher: string;
  category_id: string | null;
  icon_kind: string;
  icon_url: string | null;
  homepage_url: string | null;
  featured: boolean;
  published: boolean;
  position: number;
  version_count: number;
  published_version_count: number;
}

interface AdminVersion {
  id: string;
  version: string;
  installer_type: string;
  installer_mode: string;
  installer_url_kind: string;
  installer_url: string;
  installer_sha256: string | null;
  installer_size_bytes: number | null;
  published: boolean | number;
  release_date: string | null;
}

/** Signs in and returns the harness. Callers close it. */
async function signedIn(): Promise<ReturnType<typeof harness>> {
  const h = harness({ bootstrapToken: BOOTSTRAP_TOKEN });
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

const createApp = (
  h: ReturnType<typeof harness>,
  body: Record<string, unknown>,
  id = "firefox",
): Promise<{ status: number; body: Record<string, unknown> }> =>
  h.json(`/api/admin/apps/${id}`, { method: "PUT", admin: true, body: JSON.stringify(body) });

describe("categories", () => {
  test("creates, lists and returns the new category", async () => {
    const h = await signedIn();
    try {
      const created = await h.json<{ category: Category }>("/api/admin/categories", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ id: "browsers", name: "Browsers", sort_order: 1 }),
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.category.name, "Browsers");

      const list = await h.json<{ categories: Category[] }>("/api/admin/categories");
      assert.deepEqual(
        list.body.categories.map((c) => c.id),
        ["browsers"],
      );
      // A new category has nothing in it, and the panel renders this column.
      assert.equal(list.body.categories[0]!.app_count, 0);
      assert.equal(list.body.categories[0]!.published_app_count, 0);
    } finally {
      h.close();
    }
  });

  test("refuses a duplicate id", async () => {
    const h = await signedIn();
    try {
      const payload = { method: "POST", admin: true, body: JSON.stringify({ id: "media", name: "Media" }) } as const;
      assert.equal((await h.json("/api/admin/categories", payload)).status, 201);
      const again = await h.json<{ error: { code: string } }>("/api/admin/categories", payload);
      assert.equal(again.status, 409);
    } finally {
      h.close();
    }
  });

  test("patches only the fields that were sent", async () => {
    const h = await signedIn();
    try {
      await h.json("/api/admin/categories", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ id: "media", name: "Media", sort_order: 5 }),
      });
      await h.json("/api/admin/categories/media", {
        method: "PATCH",
        admin: true,
        body: JSON.stringify({ name: "Media players" }),
      });

      const list = await h.json<{ categories: Category[] }>("/api/admin/categories");
      assert.equal(list.body.categories[0]!.name, "Media players");
      // sort_order was not sent, so it must be unchanged - coalesce, not a
      // default that silently resets an operator's ordering.
      assert.equal(list.body.categories[0]!.sort_order, 5);
    } finally {
      h.close();
    }
  });

  test("deleting a category uncategorises its apps instead of deleting them", async () => {
    const h = await signedIn();
    try {
      await h.json("/api/admin/categories", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ id: "media", name: "Media" }),
      });
      await createApp(h, { name: "VLC", category_id: "media", published: true });

      const deleted = await h.json<{ uncategorised_apps: number }>("/api/admin/categories/media", {
        method: "DELETE",
        admin: true,
      });
      assert.equal(deleted.body.uncategorised_apps, 1);

      const apps = h.db.sqlite
        .prepare("SELECT category_id FROM apps WHERE id = 'firefox'")
        .get() as { category_id: string | null };
      // The app survives. Losing a category must never silently remove
      // applications from the catalog.
      assert.equal(apps.category_id, null);
    } finally {
      h.close();
    }
  });

  test("404s on a category that does not exist", async () => {
    const h = await signedIn();
    try {
      assert.equal(
        (await h.json("/api/admin/categories/nope", { method: "DELETE", admin: true })).status,
        404,
      );
    } finally {
      h.close();
    }
  });

  test("refuses a category pointing at an app that does not exist", async () => {
    const h = await signedIn();
    try {
      const { status } = await createApp(h, { name: "VLC", category_id: "ghost" });
      // Checked explicitly rather than left to the FK, so the operator is told
      // which field is wrong instead of getting a generic constraint message.
      assert.equal(status, 422);
      assert.equal(
        (h.db.sqlite.prepare("SELECT count(*) AS n FROM apps").get() as { n: number }).n,
        0,
      );
    } finally {
      h.close();
    }
  });
});

describe("applications", () => {
  test("creates an unpublished app that the public API cannot see", async () => {
    const h = await signedIn();
    try {
      const created = await createApp(h, { name: "Mozilla Firefox", publisher: "Mozilla" });
      assert.equal(created.status, 201);

      const publicList = await h.json<{ apps: unknown[] }>("/api/apps");
      assert.equal(publicList.body.apps.length, 0, "an unpublished app appeared publicly");

      const adminList = await h.json<{ apps: AdminApp[] }>("/api/admin/apps");
      assert.equal(adminList.body.apps.length, 1);
    } finally {
      h.close();
    }
  });

  test("publishing makes it visible, unpublishing hides it again", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "VLC", published: false });
      assert.equal((await h.json<{ apps: unknown[] }>("/api/apps")).body.apps.length, 0);

      await createApp(h, { name: "VLC", published: true });
      assert.equal((await h.json<{ apps: unknown[] }>("/api/apps")).body.apps.length, 1);

      await createApp(h, { name: "VLC", published: false });
      assert.equal((await h.json<{ apps: unknown[] }>("/api/apps")).body.apps.length, 0);
    } finally {
      h.close();
    }
  });

  test("PUT is an upsert: the second call updates rather than conflicting", async () => {
    const h = await signedIn();
    try {
      assert.equal((await createApp(h, { name: "VLC" })).status, 201);
      // The panel submits one form for both create and edit, so a repeated save
      // must not 409.
      const second = await createApp(h, { name: "VLC media player" });
      assert.equal(second.status, 200);

      const detail = await h.json<{ app: { name: string } }>("/api/admin/apps/firefox");
      assert.equal(detail.body.app.name, "VLC media player");
    } finally {
      h.close();
    }
  });

  test("refuses to change the id through the body", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "VLC" });
      const { status } = await createApp(h, { name: "VLC", id: "something-else" });
      // A changed id would break the desktop app's stored reference to this app.
      assert.equal(status, 422);
      assert.equal(
        (h.db.sqlite.prepare("SELECT count(*) AS n FROM apps").get() as { n: number }).n,
        1,
      );
    } finally {
      h.close();
    }
  });

  test("stores counts for the panel's list", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "VLC" });
      await h.json("/api/admin/apps/firefox/versions", {
        method: "POST",
        admin: true,
        body: JSON.stringify({
          version: "3.0.21",
          installer_type: "exe",
          installer_mode: "silent",
          installer_url: "https://get.videolan.org/vlc/3.0.21/vlc-3.0.21.exe",
          published: true,
        }),
      });

      const list = await h.json<{ apps: AdminApp[] }>("/api/admin/apps");
      assert.equal(list.body.apps[0]!.version_count, 1);
      assert.equal(list.body.apps[0]!.published_version_count, 1);
    } finally {
      h.close();
    }
  });

  test("deleting an app cascades to its versions", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "VLC" });
      await h.json("/api/admin/apps/firefox/versions", {
        method: "POST",
        admin: true,
        body: JSON.stringify({
          version: "3.0.21",
          installer_type: "exe",
          installer_url: "https://get.videolan.org/vlc.exe",
        }),
      });

      const deleted = await h.json<{ deleted_versions: number }>("/api/admin/apps/firefox", {
        method: "DELETE",
        admin: true,
      });
      assert.equal(deleted.body.deleted_versions, 1);
      assert.equal(
        (h.db.sqlite.prepare("SELECT count(*) AS n FROM app_versions").get() as { n: number }).n,
        0,
        "orphaned version rows survived the delete",
      );
    } finally {
      h.close();
    }
  });

  test("an icon of kind 'none' stores no URL", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "VLC", icon_kind: "none" });
      const row = h.db.sqlite
        .prepare("SELECT icon_kind, icon_url FROM apps WHERE id = 'firefox'")
        .get() as { icon_kind: string; icon_url: string | null };
      assert.equal(row.icon_kind, "none");
      // A URL beside icon_kind = 'none' would be a contradiction the CHECK
      // constraint rejects, so the validator drops it instead.
      assert.equal(row.icon_url, null);
    } finally {
      h.close();
    }
  });

  test("accepts an https icon and an https homepage", async () => {
    const h = await signedIn();
    try {
      await createApp(h, {
        name: "VLC",
        icon_kind: "external",
        icon_url: "https://cdn.example/vlc.png",
        homepage_url: "https://www.videolan.org/",
      });
      const row = h.db.sqlite
        .prepare("SELECT icon_url, homepage_url FROM apps WHERE id = 'firefox'")
        .get() as { icon_url: string; homepage_url: string };
      assert.equal(row.icon_url, "https://cdn.example/vlc.png");
      assert.equal(row.homepage_url, "https://www.videolan.org/");
    } finally {
      h.close();
    }
  });
});

describe("versions", () => {
  const version = (h: ReturnType<typeof harness>, body: Record<string, unknown>) =>
    h.json("/api/admin/apps/firefox/versions", {
      method: "POST",
      admin: true,
      body: JSON.stringify(body),
    });

  test("adds a version and returns it", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "Firefox" });
      const created = await version(h, {
        version: "131.0",
        installer_type: "exe",
        installer_mode: "silent",
        installer_url: "https://download.example/firefox-131.exe",
        installer_sha256: "a".repeat(64),
        installer_size_bytes: 84_000_000,
        release_date: "2026-01-15",
        published: true,
      });
      assert.equal(created.status, 201);

      const detail = await h.json<{ app: { versions: AdminVersion[] } }>("/api/admin/apps/firefox");
      const stored = detail.body.app.versions[0]!;
      assert.equal(stored.version, "131.0");
      assert.equal(stored.installer_mode, "silent");
      assert.equal(stored.installer_sha256, "a".repeat(64));
      assert.equal(stored.installer_size_bytes, 84_000_000);
    } finally {
      h.close();
    }
  });

  test("defaults installer_mode to interactive", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "Firefox" });
      await version(h, {
        version: "131.0",
        installer_type: "exe",
        installer_url: "https://download.example/firefox-131.exe",
      });
      const detail = await h.json<{ app: { versions: AdminVersion[] } }>("/api/admin/apps/firefox");
      // Interactive is the safe default: it shows the installer's own UI rather
      // than suppressing it on the user's behalf.
      assert.equal(detail.body.app.versions[0]!.installer_mode, "interactive");
    } finally {
      h.close();
    }
  });

  // ---------------------------------------------------------------------------
  // A direct https URL, with no upload and no checksum. This is the whole
  // convenience the catalog offers: paste a link to the installer and it works.
  // ---------------------------------------------------------------------------

  describe("a direct https installer URL is enough", () => {
    test("a version is created with no checksum field at all", async () => {
      const h = await signedIn();
      try {
        await createApp(h, { name: "Firefox" });
        const created = await version(h, {
          version: "131.0",
          installer_type: "exe",
          installer_mode: "silent",
          installer_url: "https://download.example/firefox-131.exe",
          published: true,
        });
        assert.equal(created.status, 201, "a missing checksum must not block creation");

        const detail = await h.json<{ app: { versions: AdminVersion[] } }>("/api/admin/apps/firefox");
        const stored = detail.body.app.versions[0]!;
        assert.equal(stored.installer_sha256, null, "stored as absent, not as an empty string");
        assert.equal(stored.installer_url, "https://download.example/firefox-131.exe");
        assert.equal(stored.installer_type, "exe");
        assert.equal(stored.installer_mode, "silent");
      } finally {
        h.close();
      }
    });

    test("an empty checksum is the same as omitting it, but a blank one is refused", async () => {
      // Three cases, and the third is deliberate rather than an oversight.
      //
      // Omitted and `""` both mean "no digest", and both are accepted - that is
      // the whole convenience being offered. A whitespace-only string is
      // *present*, so it is held to the rule for a present value and rejected,
      // rather than being silently dropped. Silently dropping it is the
      // surprising behaviour: an operator who typed spaces into the field would
      // get an unverified install and no indication of it.
      //
      // This cannot be reached through the panel, which trims before sending.
      const h = await signedIn();
      try {
        await createApp(h, { name: "Firefox" });

        const omitted = await version(h, {
          version: "7.0",
          installer_type: "msi",
          installer_url: "https://download.example/thing-7-0.msi",
        });
        assert.equal(omitted.status, 201);

        const empty = await version(h, {
          version: "7.1",
          installer_type: "msi",
          installer_url: "https://download.example/thing-7-1.msi",
          installer_sha256: "",
        });
        assert.equal(empty.status, 201, "{sha:?} should be treated as absent");

        const blank = await version(h, {
          version: "7.2",
          installer_type: "msi",
          installer_url: "https://download.example/thing-7-2.msi",
          installer_sha256: "   ",
        });
        assert.equal(blank.status, 422, "a present-but-blank digest is refused, not ignored");

        const detail = await h.json<{ app: { versions: AdminVersion[] } }>("/api/admin/apps/firefox");
        assert.equal(detail.body.app.versions.length, 2, "only the two accepted versions exist");
        for (const stored of detail.body.app.versions) {
          assert.equal(stored.installer_sha256, null, "stored as absent, not as an empty string");
        }
      } finally {
        h.close();
      }
    });

    test("both containers are accepted", async () => {
      const h = await signedIn();
      try {
        await createApp(h, { name: "Firefox" });
        for (const type of ["exe", "msi"]) {
          const created = await version(h, {
            version: type === "exe" ? "2.0" : "2.1",
            installer_type: type,
            installer_url: `https://download.example/thing.${type}`,
          });
          assert.equal(created.status, 201, `${type} should be accepted`);
        }
      } finally {
        h.close();
      }
    });

    test("all three install modes are accepted", async () => {
      const h = await signedIn();
      try {
        await createApp(h, { name: "Firefox" });
        for (const mode of ["silent", "passive", "interactive"]) {
          const created = await version(h, {
            version: mode === "silent" ? "3.0" : mode === "passive" ? "3.1" : "3.2",
            installer_type: "exe",
            installer_mode: mode,
            installer_url: `https://download.example/thing-${mode}.exe`,
          });
          assert.equal(created.status, 201, `${mode} should be accepted`);
        }
      } finally {
        h.close();
      }
    });

    test("http is refused and https is kept", async () => {
      const h = await signedIn();
      try {
        await createApp(h, { name: "Firefox" });
        const refused = await version(h, {
          version: "4.0",
          installer_type: "exe",
          installer_url: "http://download.example/thing.exe",
        });
        assert.equal(refused.status, 422, "plain http must not be accepted");
        assert.match(JSON.stringify(refused.body), /https/i);

        const accepted = await version(h, {
          version: "4.1",
          installer_type: "exe",
          installer_url: "https://download.example/thing.exe",
        });
        assert.equal(accepted.status, 201);
      } finally {
        h.close();
      }
    });

    test("an unparseable URL is refused", async () => {
      const h = await signedIn();
      try {
        await createApp(h, { name: "Firefox" });
        for (const bad of ["not a url", "ftp://download.example/thing.exe", "/local/path.exe"]) {
          const refused = await version(h, {
            version: "4.0",
            installer_type: "exe",
            installer_url: bad,
          });
          assert.equal(refused.status, 422, `{bad} should be refused`);
        }
      } finally {
        h.close();
      }
    });

    test("a URL carrying credentials is refused", async () => {
      // https://downloads.example@evil.example reads as downloads.example in a
      // status bar and resolves to evil.example.
      const h = await signedIn();
      try {
        await createApp(h, { name: "Firefox" });
        const refused = await version(h, {
          version: "4.0",
          installer_type: "exe",
          installer_url: "https://downloads.example:token@evil.example/thing.exe",
        });
        assert.equal(refused.status, 422);
        assert.match(JSON.stringify(refused.body), /credential/i);
      } finally {
        h.close();
      }
    });

    test("no field can carry an installer argument or a command", async () => {
      // The API never sends a command line, so there is nowhere to put one. Each
      // of these is a 422 naming the offending key rather than a silent drop.
      const h = await signedIn();
      try {
        await createApp(h, { name: "Firefox" });
        for (const [index, extra] of [
          { args: "/S /D=C:\\Windows" },
          { arguments: ["--quiet"] },
          { command: "powershell -enc AAAA" },
          { installer_args: "--run=setup.exe" },
          { program: "cmd.exe" },
          { shell: true },
        ].entries()) {
          const refused = await version(h, {
            version: `7.${index}`,
            installer_type: "exe",
            installer_url: `https://download.example/thing-${index}.exe`,
            ...extra,
          });
          assert.equal(refused.status, 422, `{${Object.keys(extra)[0]}} must be refused`);
        }
      } finally {
        h.close();
      }
    });

    test("a container or mode outside the closed sets is refused", async () => {
      const h = await signedIn();
      try {
        await createApp(h, { name: "Firefox" });
        for (const [index, bad] of [
          { installer_type: "bat" },
          { installer_mode: "silent; calc.exe" },
          { installer_type: "powershell" },
          { installer_mode: "--run=setup.exe" },
        ].entries()) {
          const refused = await version(h, {
            version: `7.${index}`,
            installer_type: "exe",
            installer_url: `https://download.example/thing-${index}.exe`,
            ...bad,
          });
          assert.equal(refused.status, 422, `{${JSON.stringify(bad)}} must be refused`);
        }
      } finally {
        h.close();
      }
    });

    test("r2 is still refused, because no bucket exists", async () => {
      // Support for it is untouched and still validated; there is simply nowhere
      // to put the bytes yet, so the panel must not be able to select it.
      const h = await signedIn();
      try {
        await createApp(h, { name: "Firefox" });
        const refused = await version(h, {
          version: "4.0",
          installer_type: "exe",
          installer_url_kind: "r2",
          installer_url: "installers/firefox.exe",
        });
        assert.equal(refused.status, 422);
        assert.match(JSON.stringify(refused.body), /R2/i);
      } finally {
        h.close();
      }
    });

    test("a version that already carries a checksum keeps working unchanged", async () => {
      // The existing shape must be untouched by any of the above: a hash is
      // still stored, still 64 hex, still normalised.
      const h = await signedIn();
      try {
        await createApp(h, { name: "Firefox" });
        const created = await version(h, {
          version: "131.0",
          installer_type: "exe",
          installer_url: "https://download.example/firefox-131.exe",
          installer_sha256: "A".repeat(64),
        });
        assert.equal(created.status, 201);

        const detail = await h.json<{ app: { versions: AdminVersion[] } }>("/api/admin/apps/firefox");
        const stored = detail.body.app.versions[0]!;
        assert.equal(
          stored.installer_sha256,
          "a".repeat(64),
          "stored lowercase, as it always was",
        );

        // And a malformed one is still a 422 rather than being quietly ignored,
        // because ignoring it would downgrade a verified install to an
        // unverified one without anyone noticing.
        const bad = await version(h, {
          version: "132.0",
          installer_type: "exe",
          installer_url: "https://download.example/firefox-132.exe",
          installer_sha256: "not-a-hash",
        });
        assert.equal(bad.status, 422);
      } finally {
        h.close();
      }
    });
  });

  test("refuses a duplicate version for the same app", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "Firefox" });
      const body = {
        version: "131.0",
        installer_type: "exe",
        installer_url: "https://download.example/firefox-131.exe",
      };
      assert.equal((await version(h, body)).status, 201);
      // A duplicate would give the public feed two rows for one version, with no
      // rule for which wins.
      assert.equal((await version(h, body)).status, 409);
    } finally {
      h.close();
    }
  });

  test("the same version number is allowed on a different app", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "Firefox" });
      await createApp(h, { name: "VLC" }, "vlc");
      const body = {
        version: "3.0.21",
        installer_type: "exe",
        installer_url: "https://download.example/app.exe",
      };
      assert.equal((await version(h, body)).status, 201);
      assert.equal(
        (await h.json("/api/admin/apps/vlc/versions", { method: "POST", admin: true, body: JSON.stringify(body) }))
          .status,
        201,
      );
    } finally {
      h.close();
    }
  });

  test("patching changes only the fields that were sent", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "Firefox" });
      await version(h, {
        version: "131.0",
        installer_type: "exe",
        installer_mode: "silent",
        installer_url: "https://download.example/firefox-131.exe",
        installer_sha256: "b".repeat(64),
      });
      const detail = await h.json<{ app: { versions: AdminVersion[] } }>("/api/admin/apps/firefox");
      const id = detail.body.app.versions[0]!.id;

      const patched = await h.json<{ ok: boolean }>(`/api/admin/versions/${id}`, {
        method: "PATCH",
        admin: true,
        body: JSON.stringify({ published: true }),
      });
      assert.equal(patched.status, 200);

      const after = await h.json<{ app: { versions: AdminVersion[] } }>("/api/admin/apps/firefox");
      const stored = after.body.app.versions[0]!;
      assert.equal(stored.published, true);
      // Untouched fields keep their values.
      assert.equal(stored.installer_url, "https://download.example/firefox-131.exe");
      assert.equal(stored.installer_sha256, "b".repeat(64));
    } finally {
      h.close();
    }
  });

  test("patching a URL keeps resolving against the stored kind", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "Firefox" });
      await version(h, {
        version: "131.0",
        installer_type: "exe",
        installer_url: "https://download.example/firefox-131.exe",
      });
      const detail = await h.json<{ app: { versions: AdminVersion[] } }>("/api/admin/apps/firefox");
      const id = detail.body.app.versions[0]!.id;

      // A new URL with no new kind is validated as an https URL, because that is
      // what the row already stores.
      assert.equal(
        (await h.json(`/api/admin/versions/${id}`, {
          method: "PATCH",
          admin: true,
          body: JSON.stringify({ installer_url: "https://other.example/firefox-132.exe" }),
        })).status,
        200,
      );
      // And it is not accepted as a bare object key, which only an explicit
      // kind change would allow.
      assert.equal(
        (await h.json(`/api/admin/versions/${id}`, {
          method: "PATCH",
          admin: true,
          body: JSON.stringify({ installer_url: "installers/firefox-132.exe" }),
        })).status,
        422,
      );
    } finally {
      h.close();
    }
  });

  test("clearing the hash is allowed, since a hash is optional", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "Firefox" });
      await version(h, {
        version: "131.0",
        installer_type: "exe",
        installer_url: "https://download.example/firefox-131.exe",
        installer_sha256: "c".repeat(64),
      });
      const detail = await h.json<{ app: { versions: AdminVersion[] } }>("/api/admin/apps/firefox");
      const id = detail.body.app.versions[0]!.id;

      await h.json(`/api/admin/versions/${id}`, {
        method: "PATCH",
        admin: true,
        body: JSON.stringify({ installer_sha256: null }),
      });
      const row = h.db.sqlite
        .prepare("SELECT installer_sha256 FROM app_versions WHERE id = ?")
        .get(id) as { installer_sha256: string | null };
      assert.equal(row.installer_sha256, null);
    } finally {
      h.close();
    }
  });

  test("deleting a version leaves the app", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "Firefox" });
      await version(h, {
        version: "131.0",
        installer_type: "exe",
        installer_url: "https://download.example/firefox-131.exe",
      });
      const detail = await h.json<{ app: { versions: AdminVersion[] } }>("/api/admin/apps/firefox");
      const id = detail.body.app.versions[0]!.id;

      assert.equal(
        (await h.json(`/api/admin/versions/${id}`, { method: "DELETE", admin: true })).status,
        200,
      );
      assert.equal(
        (h.db.sqlite.prepare("SELECT count(*) AS n FROM apps").get() as { n: number }).n,
        1,
      );
    } finally {
      h.close();
    }
  });

  test("404s for a version on an app that does not exist", async () => {
    const h = await signedIn();
    try {
      assert.equal(
        (
          await h.json("/api/admin/apps/ghost/versions", {
            method: "POST",
            admin: true,
            body: JSON.stringify({
              version: "4.0",
              installer_type: "exe",
              installer_url: "https://download.example/a.exe",
            }),
          })
        ).status,
        404,
      );
    } finally {
      h.close();
    }
  });
});

describe("audit log", () => {
  test("records each write with the admin and the target", async () => {
    const h = await signedIn();
    try {
      await h.json("/api/admin/categories", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ id: "media", name: "Media" }),
      });
      await createApp(h, { name: "VLC", category_id: "media" });

      const { body } = await h.json<{
        entries: { action: string; target: string; username: string }[];
      }>("/api/admin/audit");
      const actions = body.entries.map((e) => e.action);
      assert.ok(actions.includes("category.create"), actions.join(", "));
      assert.ok(actions.includes("app.create"), actions.join(", "));

      const create = body.entries.find((e) => e.action === "app.create")!;
      assert.equal(create.target, "firefox");
      // Without this, the log cannot answer "who changed this".
      assert.equal(create.username, "wafi");
    } finally {
      h.close();
    }
  });

  test("records a publish separately from an update", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "VLC", published: false });
      await createApp(h, { name: "VLC", published: true });

      const { body } = await h.json<{ entries: { action: string }[] }>("/api/admin/audit");
      const actions = body.entries.map((e) => e.action);
      // "This went live" and "someone typed in the form" are different events and
      // an operator reviewing a change wants to tell them apart.
      assert.ok(actions.includes("app.publish"), actions.join(", "));
      assert.ok(!actions.includes("app.update"), actions.join(", "));
    } finally {
      h.close();
    }
  });

  test("respects the limit parameter", async () => {
    const h = await signedIn();
    try {
      for (let i = 0; i < 5; i += 1) {
        await h.json("/api/admin/categories", {
          method: "POST",
          admin: true,
          body: JSON.stringify({ id: `cat-${i}`, name: `Cat ${i}` }),
        });
      }
      const { body } = await h.json<{ entries: unknown[]; count: number }>("/api/admin/audit?limit=2");
      assert.equal(body.entries.length, 2);
    } finally {
      h.close();
    }
  });

  test("never records a verifier, a hash or a token", async () => {
    const h = await signedIn();
    try {
      await createApp(h, { name: "VLC" });
      const token = h.sessionToken();
      const { body } = await h.json<Record<string, unknown>>("/api/admin/audit?limit=200");
      const raw = JSON.stringify(body);

      assert.ok(token);
      assert.ok(!raw.includes(token), "the audit log contains a session token");
      // The verifier the panel sent is a credential; it must not be logged.
      assert.ok(!raw.includes(fakeVerifier("pw")), "the audit log contains a verifier");
      assert.ok(!raw.includes("password_hash"), "the audit log contains a password hash");
    } finally {
      h.close();
    }
  });
});