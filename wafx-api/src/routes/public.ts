/**
 * Public read routes.
 *
 * Everything here is unauthenticated and read-only. The shape of this file is
 * the security boundary: it is the entire set of things an unauthenticated
 * caller can reach, and none of it can change state or return anything that
 * would let a caller influence what the desktop app later executes.
 *
 * Unpublished rows are filtered in SQL, not in JavaScript, so a mistake in the
 * post-processing cannot expose a draft.
 */

import { Hono } from "hono";

import type { AdminEnv } from "../middleware/admin-guard.ts";
import { flag, num, str } from "../middleware/admin-guard.ts";
import { context } from "../middleware/admin-guard.ts";
import { HttpError } from "../errors.ts";

export const publicRoutes = new Hono<AdminEnv>();

/**
 * Visible versions: published ones only, newest first.
 *
 * The `installer_url_kind` filter is the reason this table has a discriminator
 * column at all. With no R2 bucket in phase 1, an `r2` row has no key that
 * resolves to a URL, so publishing it would hand the desktop app something it
 * cannot fetch. Filtering here means such a row is simply invisible rather than
 * a download failure at the user's end.
 */
const VISIBLE_VERSION = `
  SELECT v.id, v.version, v.installer_type, v.installer_mode,
         v.installer_url_kind, v.installer_url, v.installer_sha256,
         v.installer_size_bytes, v.release_date, v.created_at
    FROM app_versions v
   WHERE v.app_id = ? AND v.published = 1 AND v.installer_url_kind = 'external'
   ORDER BY v.release_date DESC, v.created_at DESC, v.id DESC
`;

interface VersionJson {
  id: string;
  version: string;
  installer_type: string;
  installer_mode: string;
  installer_url_kind: string;
  installer_url: string;
  installer_sha256: string | null;
  installer_size_bytes: number | null;
  release_date: string | null;
  created_at: string;
}

interface AppJson {
  id: string;
  name: string;
  description: string;
  publisher: string;
  icon_kind: string;
  icon_url: string | null;
  homepage_url: string | null;
  featured: boolean;
  category_id: string | null;
  category_name: string | null;
  versions: VersionJson[];
  /** The version the panel considers current: newest published. */
  latest_version: string | null;
}

function versionJson(row: Record<string, unknown>): VersionJson {
  return {
    id: str(row.id),
    version: str(row.version),
    installer_type: str(row.installer_type),
    installer_mode: str(row.installer_mode),
    installer_url_kind: str(row.installer_url_kind),
    installer_url: str(row.installer_url),
    installer_sha256: row.installer_sha256 === null ? null : str(row.installer_sha256),
    installer_size_bytes: row.installer_size_bytes === null ? null : num(row.installer_size_bytes),
    release_date: row.release_date === null ? null : str(row.release_date),
    created_at: str(row.created_at),
  };
}

/**
 * The list of applications.
 *
 * Query parameters are all optional and all allowlisted. `featured=1` is the
 * only filter the panel needs, and there is no free-text search parameter: a
 * `LIKE` against operator-supplied text is a scan, and on the free plan a scan
 * is how a request budget disappears.
 */
publicRoutes.get("/apps", context(), async (c) => {
  const db = c.get("db");
  const featuredOnly = c.req.query("featured") === "1";
  const category = c.req.query("category");

  const clauses = ["a.published = 1"];
  const params: string[] = [];
  if (featuredOnly) clauses.push("a.featured = 1");
  if (category !== undefined && category !== "") {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category)) {
      throw new HttpError("bad_request", "Invalid category");
    }
    clauses.push("a.category_id = ?");
    params.push(category);
  }

  const apps = await db.all<Record<string, unknown>>(
    `SELECT a.id, a.name, a.description, a.publisher, a.icon_kind, a.icon_url,
            a.homepage_url, a.featured, a.category_id, c.name AS category_name
       FROM apps a
       LEFT JOIN app_categories c ON c.id = a.category_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY a.featured DESC, a.position ASC, a.name COLLATE NOCASE ASC`,
    ...params,
  );

  const out: AppJson[] = [];
  for (const row of apps) {
    const id = str(row.id);
    const versions = await db.all<Record<string, unknown>>(VISIBLE_VERSION, id);
    const list = versions.map(versionJson);
    out.push({
      id,
      name: str(row.name),
      description: str(row.description),
      publisher: str(row.publisher),
      icon_kind: str(row.icon_kind),
      icon_url: row.icon_url === null ? null : str(row.icon_url),
      homepage_url: row.homepage_url === null ? null : str(row.homepage_url),
      featured: flag(row.featured),
      category_id: row.category_id === null ? null : str(row.category_id),
      category_name: row.category_name === null ? null : str(row.category_name),
      versions: list,
      latest_version: list[0]?.version ?? null,
    });
  }

  return c.json({ apps: out, count: out.length });
});

/** One application, with its published versions. */
publicRoutes.get("/apps/:id", context(), async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new HttpError("not_found", "Application not found");
  }

  const row = await db.first<Record<string, unknown>>(
    `SELECT a.id, a.name, a.description, a.publisher, a.icon_kind, a.icon_url,
            a.homepage_url, a.featured, a.category_id, c.name AS category_name
       FROM apps a
       LEFT JOIN app_categories c ON c.id = a.category_id
      WHERE a.id = ? AND a.published = 1`,
    id,
  );
  if (!row) {
    // Unpublished and nonexistent return the same body, so the endpoint cannot
    // be used to discover that a draft exists.
    throw new HttpError("not_found", "Application not found");
  }

  const versions = await db.all<Record<string, unknown>>(VISIBLE_VERSION, id);
  const list = versions.map(versionJson);

  return c.json({
    app: {
      id: str(row.id),
      name: str(row.name),
      description: str(row.description),
      publisher: str(row.publisher),
      icon_kind: str(row.icon_kind),
      icon_url: row.icon_url === null ? null : str(row.icon_url),
      homepage_url: row.homepage_url === null ? null : str(row.homepage_url),
      featured: flag(row.featured),
      category_id: row.category_id === null ? null : str(row.category_id),
      category_name: row.category_name === null ? null : str(row.category_name),
      versions: list,
      latest_version: list[0]?.version ?? null,
    } satisfies AppJson,
  });
});

publicRoutes.get("/categories", context(), async (c) => {
  const rows = await c.get("db").all<{ id: string; name: string; n: number }>(
    `SELECT c.id, c.name, count(a.id) AS n
       FROM app_categories c
       LEFT JOIN apps a ON a.category_id = c.id AND a.published = 1
      GROUP BY c.id, c.name, c.sort_order
      ORDER BY c.sort_order ASC, c.name COLLATE NOCASE ASC`,
  );
  return c.json({
    categories: rows.map((row) => ({
      id: str(row.id),
      name: str(row.name),
      app_count: num(row.n),
    })),
  });
});

/**
 * Wafi X release metadata, for the panel's own diagnostics.
 *
 * This is deliberately not the updater feed. Installed copies read
 * `latest.json` from GitHub Releases, because
 * `src-tauri/src/update_identity.rs` pins both the artifact filename and the
 * download host. Nothing here can influence that, and this route is not shaped
 * like the Tauri updater contract (no 204, no signature field), so pointing a
 * client at it by mistake fails loudly instead of installing something.
 */
publicRoutes.get("/releases/latest", context(), async (c) => {
  const row = await c.get("db").first<Record<string, unknown>>(
    `SELECT version, channel, notes, published, release_date, updated_at
       FROM wafx_releases
      WHERE published = 1
      ORDER BY release_date DESC, created_at DESC
      LIMIT 1`,
  );
  if (!row) {
    return c.json({ release: null });
  }
  return c.json({
    release: {
      version: str(row.version),
      channel: str(row.channel),
      notes: str(row.notes),
      published: flag(row.published),
      release_date: row.release_date === null ? null : str(row.release_date),
    },
  });
});

/**
 * Build metadata. Tells a client which catalog shape to expect, so the desktop
 * app can refuse a feed it does not understand rather than misreading it.
 */
publicRoutes.get("/meta", context(), (c) =>
  c.json({
    service: "wafx-api",
    schema_version: 1,
    // Advertised so a mismatched client fails loudly instead of silently.
    updater_feed: "github-releases",
    installer_modes: ["silent", "passive", "interactive"],
    installer_types: ["exe", "msi"],
    url_kinds: ["external"],
  }),
);
