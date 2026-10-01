/**
 * Admin CRUD for categories, applications and application versions.
 *
 * Every route in this file sits behind the session guard, so authentication is
 * structural: a new route here cannot be reached unauthenticated, because the
 * guard is applied by the parent router in index.ts rather than per route.
 *
 * The important property throughout is that no field which reaches the desktop
 * app's installer path can be set to anything outside a closed set. URLs must be
 * https (or an R2 object key), `installer_type` is exe or msi, `installer_mode`
 * is silent/passive/interactive, and there is no field for arguments at all -
 * `Validator.shape` rejects one by name.
 */

import { Hono } from "hono";
import type { Context } from "hono";

import type { AdminEnv } from "../middleware/admin-guard.ts";
import { flag, num, str } from "../middleware/admin-guard.ts";
import { HttpError, conflict, notFound } from "../errors.ts";
import {
  ICON_KINDS,
  INSTALLER_MODES,
  INSTALLER_TYPES,
  URL_KINDS,
  Validator,
  def,
  toUrlKind,
} from "../validate.ts";
import { bool, nowIso } from "../db.ts";
import { record } from "../audit.ts";
import { readJsonObject } from "./body.ts";

export const catalogRoutes = new Hono<AdminEnv>();

/** Fields each resource accepts. Anything not listed is a 422. */
const CATEGORY_FIELDS = ["id", "name", "sort_order"] as const;
const APP_FIELDS = [
  "id",
  "name",
  "description",
  "category_id",
  "publisher",
  "icon_kind",
  "icon_url",
  "homepage_url",
  "featured",
  "published",
  "position",
] as const;
const VERSION_FIELDS = [
  "version",
  "installer_type",
  "installer_mode",
  "installer_url_kind",
  "installer_url",
  "installer_sha256",
  "installer_size_bytes",
  "published",
  "release_date",
] as const;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Reads the body as an object and asserts only known keys are present.
 *
 * `shape` is called before any field is read, so a payload carrying an
 * unrecognised or forbidden key is refused on that basis alone. Nothing
 * downstream has to remember to check.
 */
async function body(c: Context<AdminEnv>, allowed: readonly string[]) {
  const v = new Validator();
  const input = v.shape(await readJsonObject(c.req.raw), allowed);
  v.assert();
  return { v, input };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

catalogRoutes.get("/admin/categories", async (c) => {
  const rows = await c.get("db").all<{
    id: string;
    name: string;
    sort_order: number;
    n: number;
    published_n: number;
  }>(
    `SELECT c.id, c.name, c.sort_order,
            count(a.id) AS n,
            coalesce(sum(CASE WHEN a.published = 1 THEN 1 ELSE 0 END), 0) AS published_n
       FROM app_categories c
       LEFT JOIN apps a ON a.category_id = c.id
      GROUP BY c.id, c.name, c.sort_order
      ORDER BY c.sort_order ASC, c.name COLLATE NOCASE ASC`,
  );
  return c.json({
    categories: rows.map((row) => ({
      id: str(row.id),
      name: str(row.name),
      sort_order: num(row.sort_order),
      app_count: num(row.n),
      published_app_count: num(row.published_n),
    })),
  });
});

catalogRoutes.post("/admin/categories", async (c) => {
  const db = c.get("db");
  const { v, input } = await body(c, CATEGORY_FIELDS);

  const id = v.slug("id", input.id);
  const name = v.string("name", input.name, { required: true, min: 1, max: 80 });
  const sortOrder = v.integer("sort_order", input.sort_order, { fallback: 0, min: -1000, max: 1000 });
  v.assert();

  const existing = await db.first<{ id: string }>("SELECT id FROM app_categories WHERE id = ?", id);
  if (existing !== null) throw conflict("That category already exists");

  try {
    await db.run(
      "INSERT INTO app_categories (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)",
      id,
      name,
      sortOrder ?? 0,
      nowIso(),
    );
  } catch (error) {
    throw insertFailure(error, "category", def(id, "id"));
  }

  await record(db, { action: "category.create", target: def(id, "id"), adminId: c.get("admin").adminId, ip: c.get("ip") });
  return c.json({ category: { id: def(id, "id"), name, sort_order: sortOrder ?? 0 } }, 201);
});

catalogRoutes.patch("/admin/categories/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  if (!SLUG.test(id)) throw notFound("Category");

  const { v, input } = await body(c, CATEGORY_FIELDS);
  const name = v.string("name", input.name, { max: 80 });
  const sortOrder = v.integer("sort_order", input.sort_order, { min: -1000, max: 1000 });
  // A slug change would orphan every app pointing at it, so the id is fixed.
  if (input.id !== undefined && v.slug("id", input.id) !== id) {
    v.note("id", "A category id cannot be changed");
  }
  v.assert();

  const existing = await db.first<{ id: string }>("SELECT id FROM app_categories WHERE id = ?", id);
  if (existing === null) throw notFound("Category");

  await db.run(
    "UPDATE app_categories SET name = coalesce(?, name), sort_order = coalesce(?, sort_order) WHERE id = ?",
    name ?? null,
    sortOrder ?? null,
    id,
  );
  await record(db, { action: "category.update", target: id, adminId: c.get("admin").adminId, ip: c.get("ip") });
  return c.json({ ok: true, id });
});

/**
 * Deletes a category. Apps in it are not deleted - the FK is ON DELETE SET NULL,
 * so they become uncategorised rather than disappearing. Losing a category
 * should never silently remove applications from the catalog.
 */
catalogRoutes.delete("/admin/categories/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  if (!SLUG.test(id)) throw notFound("Category");

  const affected = await db.first<{ n: number }>(
    "SELECT count(*) AS n FROM apps WHERE category_id = ?",
    id,
  );
  const { changes } = await db.run("DELETE FROM app_categories WHERE id = ?", id);
  if (changes === 0) throw notFound("Category");

  await record(db, {
    action: "category.delete",
    target: id,
    adminId: c.get("admin").adminId,
    ip: c.get("ip"),
  });
  return c.json({ ok: true, id, uncategorised_apps: num(affected?.n) });
});

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

catalogRoutes.get("/admin/apps", async (c) => {
  const db = c.get("db");
  const rows = await db.all<Record<string, unknown>>(
    `SELECT a.id, a.name, a.description, a.publisher, a.category_id,
            a.icon_kind, a.icon_url, a.homepage_url,
            a.featured, a.published, a.position, a.updated_at,
            (SELECT count(*) FROM app_versions v WHERE v.app_id = a.id) AS version_count,
            (SELECT count(*) FROM app_versions v WHERE v.app_id = a.id AND v.published = 1) AS published_version_count
       FROM apps a
      ORDER BY a.name COLLATE NOCASE ASC`,
  );
  return c.json({
    apps: rows.map((row) => ({
      id: str(row.id),
      name: str(row.name),
      description: str(row.description),
      publisher: str(row.publisher),
      category_id: row.category_id === null ? null : str(row.category_id),
      icon_kind: str(row.icon_kind),
      icon_url: row.icon_url === null ? null : str(row.icon_url),
      homepage_url: row.homepage_url === null ? null : str(row.homepage_url),
      featured: flag(row.featured),
      published: flag(row.published),
      position: num(row.position),
      updated_at: str(row.updated_at),
      version_count: num(row.version_count),
      published_version_count: num(row.published_version_count),
    })),
  });
});

/**
 * Creates or updates an application.
 *
 * `PUT /admin/apps/:id` rather than POST + PATCH, because the panel edits a form
 * and the fields are the same set either way. `id` is in the path and immutable:
 * renaming the slug would break the desktop app's stored reference to it.
 */
catalogRoutes.put("/admin/apps/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  if (!SLUG.test(id)) {
    throw new HttpError("validation_failed", "Invalid id", {
      fields: { id: "Use lowercase letters, digits and single hyphens" },
    });
  }

  const { v, input } = await body(c, APP_FIELDS);

  const name = v.string("name", input.name, { required: true, min: 1, max: 120 });
  const description = v.string("description", input.description, { max: 2000 });
  const publisher = v.string("publisher", input.publisher, { max: 120 });
  const homepage = v.httpsUrl("homepage_url", input.homepage_url);

  const iconKind = v.oneOf("icon_kind", input.icon_kind, ICON_KINDS, { fallback: "none" });
  // A kind of 'none' yields no value: the validator treats it as absent rather
  // than demanding a URL for something that should not exist.
  const iconValue = v.urlWithKind("icon_url", iconKind, input.icon_url);

  const categoryId =
    input.category_id === undefined || input.category_id === null || input.category_id === ""
      ? null
      : (v.slug("category_id", input.category_id) ?? null);

  const featured = v.boolean("featured", input.featured, false);
  const published = v.boolean("published", input.published, false);
  const position = v.integer("position", input.position, { fallback: 0, min: -1000, max: 1000 });

  if (input.id !== undefined && v.slug("id", input.id) !== id) {
    v.note("id", "An application id cannot be changed");
  }
  v.assert();

  // A category must exist, or the app silently lands uncategorised.
  if (categoryId !== null) {
    const category = await db.first<{ id: string }>(
      "SELECT id FROM app_categories WHERE id = ?",
      categoryId,
    );
    if (category === null) {
      throw new HttpError("validation_failed", "Unknown category", {
        fields: { category_id: "No such category" },
      });
    }
  }

  // Read the current published flag as part of the same lookup that decides
  // create-vs-update. Re-reading it after the UPDATE would always report the
  // value just written, so "went live" and "was edited" would be indistinguishable
  // in the audit log.
  const existing = await db.first<{ id: string; published: number }>(
    "SELECT id, published FROM apps WHERE id = ?",
    id,
  );
  const wasPublished = flag(existing?.published);
  const stamp = nowIso();

  if (existing === null) {
    try {
      await db.run(
        `INSERT INTO apps (id, name, description, category_id, publisher,
                           icon_kind, icon_url, homepage_url,
                           featured, published, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        name,
        description ?? "",
        categoryId,
        publisher ?? "",
        iconKind ?? "none",
        iconValue ?? null,
        homepage ?? null,
        bool(featured ?? false),
        bool(published ?? false),
        position ?? 0,
        stamp,
        stamp,
      );
    } catch (error) {
      throw insertFailure(error, "application", id);
    }
    await record(db, { action: "app.create", target: id, adminId: c.get("admin").adminId, ip: c.get("ip") });
    return c.json({ app: { id, name, published: published ?? false } }, 201);
  }

  await db.run(
    `UPDATE apps SET name = ?, description = ?, category_id = ?, publisher = ?,
                     icon_kind = ?, icon_url = ?, homepage_url = ?,
                     featured = ?, published = ?, position = ?, updated_at = ?
      WHERE id = ?`,
    name,
    description ?? "",
    categoryId,
    publisher ?? "",
    iconKind ?? "none",
    iconValue ?? null,
    homepage ?? null,
    bool(featured ?? false),
    bool(published ?? false),
    position ?? 0,
    stamp,
    id,
  );

  const nowPublished = published ?? false;
  if (wasPublished !== nowPublished) {
    await record(db, {
      action: nowPublished ? "app.publish" : "app.unpublish",
      target: id,
      adminId: c.get("admin").adminId,
      ip: c.get("ip"),
    });
  } else {
    await record(db, { action: "app.update", target: id, adminId: c.get("admin").adminId, ip: c.get("ip") });
  }

  return c.json({ app: { id, name, published: nowPublished } });
});

catalogRoutes.get("/admin/apps/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  if (!SLUG.test(id)) throw notFound("Application");

  const row = await db.first<Record<string, unknown>>("SELECT * FROM apps WHERE id = ?", id);
  if (row === null) throw notFound("Application");

  const versions = await db.all<Record<string, unknown>>(
    `SELECT id, version, installer_type, installer_mode, installer_url_kind,
            installer_url, installer_sha256, installer_size_bytes,
            published, release_date, created_at
       FROM app_versions WHERE app_id = ?
      ORDER BY created_at DESC`,
    id,
  );

  return c.json({
    app: {
      id: str(row.id),
      name: str(row.name),
      description: str(row.description),
      publisher: str(row.publisher),
      category_id: row.category_id === null ? null : str(row.category_id),
      icon_kind: str(row.icon_kind),
      icon_url: row.icon_url === null ? null : str(row.icon_url),
      homepage_url: row.homepage_url === null ? null : str(row.homepage_url),
      featured: flag(row.featured),
      published: flag(row.published),
      position: num(row.position),
      created_at: str(row.created_at),
      updated_at: str(row.updated_at),
      versions: versions.map((v) => ({
        id: str(v.id),
        version: str(v.version),
        installer_type: str(v.installer_type),
        installer_mode: str(v.installer_mode),
        installer_url_kind: str(v.installer_url_kind),
        installer_url: str(v.installer_url),
        installer_sha256: v.installer_sha256 === null ? null : str(v.installer_sha256),
        installer_size_bytes: v.installer_size_bytes === null ? null : num(v.installer_size_bytes),
        published: flag(v.published),
        release_date: v.release_date === null ? null : str(v.release_date),
        created_at: str(v.created_at),
      })),
    },
  });
});

/**
 * Deletes an application and, by cascade, its versions.
 *
 * Unpublishing is usually what is wanted, and it is reversible; this is not.
 * The audit log records it either way.
 */
catalogRoutes.delete("/admin/apps/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  if (!SLUG.test(id)) throw notFound("Application");

  const versions = await db.first<{ n: number }>(
    "SELECT count(*) AS n FROM app_versions WHERE app_id = ?",
    id,
  );
  const { changes } = await db.run("DELETE FROM apps WHERE id = ?", id);
  if (changes === 0) throw notFound("Application");

  await record(db, { action: "app.delete", target: id, adminId: c.get("admin").adminId, ip: c.get("ip") });
  return c.json({ ok: true, id, deleted_versions: num(versions?.n) });
});

// ---------------------------------------------------------------------------
// Application versions
// ---------------------------------------------------------------------------

catalogRoutes.get("/admin/apps/:id/versions", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  if (!SLUG.test(id)) throw notFound("Application");

  const rows = await db.all<Record<string, unknown>>(
    `SELECT id, version, installer_type, installer_mode, installer_url_kind,
            installer_url, installer_sha256, installer_size_bytes,
            published, release_date, created_at
       FROM app_versions WHERE app_id = ? ORDER BY created_at DESC`,
    id,
  );
  return c.json({ versions: rows.map((v) => ({ ...v, id: str(v.id) })) });
});

/**
 * Adds a version to an application.
 *
 * `installer_url` is resolved against `installer_url_kind` before it is stored,
 * so the column always holds either an absolute https URL or an object key -
 * never a mixture, and never a `javascript:` or UNC value dressed up as a path.
 * `installer_mode` is checked against the closed list, and there is no field for
 * arguments: `shape` rejects one by name before this code runs.
 */
catalogRoutes.post("/admin/apps/:id/versions", async (c) => {
  const db = c.get("db");
  const appId = c.req.param("id");
  if (!SLUG.test(appId)) throw notFound("Application");

  const app = await db.first<{ id: string; name: string }>(
    "SELECT id, name FROM apps WHERE id = ?",
    appId,
  );
  if (app === null) throw notFound("Application");

  const { v, input } = await body(c, VERSION_FIELDS);

  const version = v.version("version", input.version);
  const installerType = v.oneOf("installer_type", input.installer_type, INSTALLER_TYPES, {
    required: true,
  });
  const installerMode = v.oneOf("installer_mode", input.installer_mode, INSTALLER_MODES, {
    fallback: "interactive",
  });
  const urlKind = v.oneOf("installer_url_kind", input.installer_url_kind, URL_KINDS, {
    fallback: "external",
  });
  const url = v.urlWithKind("installer_url", urlKind, input.installer_url, { required: true });
  const sha256 = v.sha256("installer_sha256", input.installer_sha256);
  const size = v.integer("installer_size_bytes", input.installer_size_bytes, { min: 1, max: 2 ** 53 });
  const published = v.boolean("published", input.published, false);
  const releaseDate = v.date("release_date", input.release_date);
  v.assert();

  // Past this point `assert` has already turned every failure into a 422, so the
  // required fields are present. `def` says that to the compiler, which is what
  // lets these values go into a message without a guard for `undefined`.
  const versionLabel = def(version, "version");
  const type = def(installerType, "installer_type");

  if (urlKind === "r2") {
    throw new HttpError(
      "validation_failed",
      "R2 storage is not enabled",
      { fields: { installer_url_kind: "No bucket is configured, so use an external https URL" } },
    );
  }

  const clash = await db.first<{ id: string }>(
    "SELECT id FROM app_versions WHERE app_id = ? AND version = ?",
    appId,
    version,
  );
  if (clash !== null) {
    throw conflict(`${app.name} already has a version ${versionLabel}. Edit it instead.`);
  }

  const id = crypto.randomUUID();
  try {
    await db.run(
      `INSERT INTO app_versions (id, app_id, version, installer_type, installer_mode,
                                 installer_url_kind, installer_url, installer_sha256,
                                 installer_size_bytes, published, release_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      appId,
      versionLabel,
      type,
      installerMode ?? "interactive",
      urlKind,
      url,
      sha256 ?? null,
      size ?? null,
      bool(published ?? false),
      releaseDate ?? null,
      nowIso(),
    );
  } catch (error) {
    throw insertFailure(error, "version", `${appId} ${versionLabel}`);
  }

  await record(db, {
    action: published ? "version.publish" : "version.create",
    target: `${appId} ${versionLabel}`,
    adminId: c.get("admin").adminId,
    ip: c.get("ip"),
  });

  return c.json(
    {
      version: {
        id,
        app_id: appId,
        version: versionLabel,
        installer_type: type,
        published: published ?? false,
      },
    },
    201,
  );
});

catalogRoutes.patch("/admin/versions/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const { v, input } = await body(c, VERSION_FIELDS);

  const existing = await db.first<Record<string, unknown>>(
    "SELECT * FROM app_versions WHERE id = ?",
    id,
  );
  if (existing === null) throw notFound("Version");

  const version = input.version === undefined ? undefined : v.version("version", input.version);
  const installerType =
    input.installer_type === undefined
      ? undefined
      : v.oneOf("installer_type", input.installer_type, INSTALLER_TYPES);
  const installerMode =
    input.installer_mode === undefined
      ? undefined
      : v.oneOf("installer_mode", input.installer_mode, INSTALLER_MODES);
  const urlKind =
    input.installer_url_kind === undefined
      ? undefined
      : v.oneOf("installer_url_kind", input.installer_url_kind, URL_KINDS);

  // A changed URL with no changed kind re-resolves against the *stored* kind, so
  // an edit to an https URL cannot silently become an object key or vice versa.
  // `toUrlKind` narrows what came out of the database; if that were ever
  // something outside the set, the field is left alone rather than resolved
  // against a kind nobody chose.
  const effectiveKind = urlKind ?? toUrlKind(existing.installer_url_kind) ?? "external";
  const url =
    input.installer_url === undefined
      ? undefined
      : v.urlWithKind("installer_url", effectiveKind, input.installer_url, { required: true });

  // Three states for the hash, and they have to stay distinct: a field that was
  // not sent keeps what is stored, an explicit null clears it, and a value
  // replaces it. Collapsing "not sent" into "cleared" would silently drop an
  // operator's hash on every unrelated edit.
  let sha256: string | null | undefined;
  if (input.installer_sha256 === undefined) {
    sha256 = undefined;
  } else if (input.installer_sha256 === null) {
    sha256 = null;
  } else {
    sha256 = v.sha256("installer_sha256", input.installer_sha256);
  }
  const size = v.integer("installer_size_bytes", input.installer_size_bytes, { min: 1, max: 2 ** 53 });
  const published = v.boolean("published", input.published);
  const releaseDate = v.date("release_date", input.release_date);
  v.assert();

  if (effectiveKind === "r2") {
    throw new HttpError(
      "validation_failed",
      "R2 storage is not enabled",
      { fields: { installer_url_kind: "No bucket is configured, so use an external https URL" } },
    );
  }

  if (version !== undefined && version !== str(existing.version)) {
    const clash = await db.first<{ id: string }>(
      "SELECT id FROM app_versions WHERE app_id = ? AND version = ? AND id <> ?",
      str(existing.app_id),
      version,
      id,
    );
    if (clash !== null) throw conflict(`That version already exists for this application.`);
  }

  try {
    await db.run(
      `UPDATE app_versions SET version = coalesce(?, version),
                               installer_type = coalesce(?, installer_type),
                               installer_mode = coalesce(?, installer_mode),
                               installer_url_kind = coalesce(?, installer_url_kind),
                               installer_url = coalesce(?, installer_url),
                               installer_sha256 = ?,
                               installer_size_bytes = coalesce(?, installer_size_bytes),
                               published = coalesce(?, published),
                               release_date = coalesce(?, release_date)
        WHERE id = ?`,
      version ?? null,
      installerType ?? null,
      installerMode ?? null,
      // The kind is only written when the request changed it. Passing null here
      // would blank the column rather than keep the stored value.
      urlKind ?? str(existing.installer_url_kind),
      url ?? null,
      // The one column that is not coalesced, because clearing the hash is a
      // legitimate edit. The unchanged case passes the stored value through - but
      // as a real null, since `str(null)` is the empty string and an empty string
      // violates the column's CHECK.
      sha256 === undefined
        ? (existing.installer_sha256 === null ? null : str(existing.installer_sha256))
        : sha256,
      size ?? null,
      published === undefined ? null : bool(published),
      releaseDate ?? null,
      id,
    );
  } catch (error) {
    throw insertFailure(error, "version", id);
  }

  const nowPublished = published ?? flag(existing.published);
  const was = flag(existing.published);
  await record(db, {
    action: nowPublished !== was ? (nowPublished ? "version.publish" : "version.unpublish") : "version.update",
    target: `${str(existing.app_id)} ${version ?? str(existing.version)}`,
    adminId: c.get("admin").adminId,
    ip: c.get("ip"),
  });

  return c.json({ ok: true, id });
});

catalogRoutes.delete("/admin/versions/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const existing = await db.first<{ app_id: string; version: string }>(
    "SELECT app_id, version FROM app_versions WHERE id = ?",
    id,
  );
  if (existing === null) throw notFound("Version");

  const { changes } = await db.run("DELETE FROM app_versions WHERE id = ?", id);
  if (changes === 0) throw notFound("Version");

  await record(db, {
    action: "version.delete",
    target: `${str(existing.app_id)} ${str(existing.version)}`,
    adminId: c.get("admin").adminId,
    ip: c.get("ip"),
  });
  return c.json({ ok: true, id });
});

/**
 * Turns a constraint violation into a readable error.
 *
 * The driver's message is logged, not returned: it embeds the SQL, and the SQL
 * embeds what was submitted.
 */
function insertFailure(error: unknown, what: string, id: string): HttpError {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`admin write failed for ${what} ${id}: ${detail}`);
  if (/UNIQUE constraint failed/i.test(detail)) {
    return conflict(`${what} "${id}" already exists`);
  }
  if (/CHECK constraint failed/i.test(detail)) {
    return new HttpError("validation_failed", "That value is not allowed");
  }
  if (/FOREIGN KEY constraint failed/i.test(detail)) {
    return new HttpError("validation_failed", "That references something that does not exist");
  }
  return new HttpError("internal", "The change could not be saved");
}
