/**
 * Wafi X release metadata, and the audit log reader.
 *
 * Important: this is *not* the updater feed.
 *
 * Installed clients read `latest.json` from GitHub Releases, because
 * `src-tauri/src/update_identity.rs` pins both the artifact filename prefix and
 * the download host to a github.com release URL as an anti-replay check. The
 * routes here record what has been published; they do not serve it to clients
 * and nothing here can influence what an installed copy downloads.
 *
 * Publishing to GitHub itself is phase 3 work and is deliberately absent - no
 * `gh` CLI, no shell. When it arrives it will be the GitHub REST API over
 * `fetch` with a token held as a Worker secret, so there is never a command
 * line, on any machine, constructed from anything a browser could influence.
 */

import { Hono } from "hono";

import type { AdminEnv } from "../middleware/admin-guard.ts";
import { flag, num, str } from "../middleware/admin-guard.ts";
import { HttpError, conflict, notFound } from "../errors.ts";
import { CHANNELS, URL_KINDS, Validator, def, toUrlKind } from "../validate.ts";
import { bool, nowIso } from "../db.ts";
import { record } from "../audit.ts";
import { readJsonObject } from "./body.ts";

export const releaseRoutes = new Hono<AdminEnv>();

const RELEASE_FIELDS = [
  "version",
  "channel",
  "notes",
  "installer_url_kind",
  "installer_url",
  "installer_sha256",
  "installer_size_bytes",
  "nsis_signature",
  "msi_signature",
  "published",
  "release_date",
] as const;

/** A Tauri updater signature: base64, long, single line. */
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;

function readSignature(v: Validator, field: string, value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") {
    v.note(field, "Must be text");
    return undefined;
  }
  const out = value.trim();
  if (out.length > 4096 || out.includes("\n") || !SIGNATURE.test(out)) {
    v.note(field, "Not a valid signature");
    return undefined;
  }
  return out;
}

function rowJson(row: Record<string, unknown>) {
  return {
    id: str(row.id),
    version: str(row.version),
    channel: str(row.channel),
    notes: str(row.notes),
    installer_url_kind: str(row.installer_url_kind),
    installer_url: str(row.installer_url),
    installer_sha256: row.installer_sha256 === null ? null : str(row.installer_sha256),
    installer_size_bytes: row.installer_size_bytes === null ? null : num(row.installer_size_bytes),
    has_nsis_signature: row.nsis_signature !== null && str(row.nsis_signature) !== "",
    has_msi_signature: row.msi_signature !== null && str(row.msi_signature) !== "",
    published: flag(row.published),
    release_date: row.release_date === null ? null : str(row.release_date),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

const SELECT_ALL = `
  SELECT id, version, channel, notes, installer_url_kind, installer_url,
         installer_sha256, installer_size_bytes, nsis_signature, msi_signature,
         published, release_date, created_at, updated_at
    FROM wafx_releases
`;

releaseRoutes.get("/admin/releases", async (c) => {
  const rows = await c.get("db").all<Record<string, unknown>>(
    `${SELECT_ALL} ORDER BY release_date DESC, created_at DESC`,
  );
  return c.json({ releases: rows.map(rowJson) });
});

releaseRoutes.get("/admin/releases/:id", async (c) => {
  const row = await c.get("db").first<Record<string, unknown>>(
    `${SELECT_ALL} WHERE id = ?`,
    c.req.param("id"),
  );
  if (row === null) throw notFound("Release");
  return c.json({ release: rowJson(row) });
});

releaseRoutes.post("/admin/releases", async (c) => {
  const db = c.get("db");
  const v = new Validator();
  const input = v.shape(await readJsonObject(c.req.raw), RELEASE_FIELDS);

  const version = v.semver("version", input.version);
  const channel = v.oneOf("channel", input.channel, CHANNELS, { fallback: "stable" });
  const notes = v.string("notes", input.notes, { max: 20_000 });
  const urlKind = v.oneOf("installer_url_kind", input.installer_url_kind, URL_KINDS, {
    fallback: "external",
  });
  const url = v.urlWithKind("installer_url", urlKind, input.installer_url, { required: true });
  const sha256 = v.sha256("installer_sha256", input.installer_sha256);
  const size = v.integer("installer_size_bytes", input.installer_size_bytes, { min: 1, max: 2 ** 53 });
  const nsisSignature = readSignature(v, "nsis_signature", input.nsis_signature);
  const msiSignature = readSignature(v, "msi_signature", input.msi_signature);
  const published = v.boolean("published", input.published, false);
  const releaseDate = v.date("release_date", input.release_date);
  v.assert();

  // `assert` has already turned every failure into a 422, so the required fields
  // are present from here on.
  const versionLabel = def(version, "version");

  if (urlKind === "r2") {
    throw new HttpError(
      "validation_failed",
      "R2 storage is not enabled",
      { fields: { installer_url_kind: "No bucket is configured, so use an external https URL" } },
    );
  }

  const clash = await db.first<{ id: string }>(
    "SELECT id FROM wafx_releases WHERE version = ?",
    version,
  );
  if (clash !== null) throw conflict(`Version ${versionLabel} is already recorded`);

  const id = crypto.randomUUID();
  const stamp = nowIso();
  try {
    await db.run(
      `INSERT INTO wafx_releases (id, version, channel, notes, installer_url_kind,
                                  installer_url, installer_sha256, installer_size_bytes,
                                  nsis_signature, msi_signature, published, release_date,
                                  created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      version,
      channel ?? "stable",
      notes ?? "",
      urlKind,
      url,
      sha256 ?? null,
      size ?? null,
      nsisSignature ?? null,
      msiSignature ?? null,
      bool(published ?? false),
      releaseDate ?? null,
      stamp,
      stamp,
    );
  } catch (error) {
    throw writeFailure(error, `release ${versionLabel}`);
  }

  await record(db, {
    action: published ? "release.publish" : "release.create",
    target: version,
    adminId: c.get("admin").adminId,
    ip: c.get("ip"),
  });

  return c.json({ release: { id, version, channel: channel ?? "stable", published: published ?? false } }, 201);
});

releaseRoutes.patch("/admin/releases/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const existing = await db.first<Record<string, unknown>>(
    "SELECT * FROM wafx_releases WHERE id = ?",
    id,
  );
  if (existing === null) throw notFound("Release");

  const v = new Validator();
  const input = v.shape(await readJsonObject(c.req.raw), RELEASE_FIELDS);

  const version = input.version === undefined ? undefined : v.semver("version", input.version);
  const channel = input.channel === undefined ? undefined : v.oneOf("channel", input.channel, CHANNELS);
  const notes = input.notes === undefined ? undefined : v.string("notes", input.notes, { max: 20_000 });
  const urlKind =
    input.installer_url_kind === undefined
      ? undefined
      : v.oneOf("installer_url_kind", input.installer_url_kind, URL_KINDS);
  // An edited URL is resolved against the stored kind when the kind is not also
  // being changed, so an https URL cannot be turned into an object key (or the
  // reverse) by omitting one field.
  const effectiveKind = urlKind ?? toUrlKind(existing.installer_url_kind) ?? "external";
  const url =
    input.installer_url === undefined
      ? undefined
      : v.urlWithKind("installer_url", effectiveKind, input.installer_url, { required: true });
  const sha256 =
    input.installer_sha256 === undefined
      ? undefined
      : input.installer_sha256 === null || input.installer_sha256 === ""
        ? null
        : (v.sha256("installer_sha256", input.installer_sha256) ?? undefined);
  const size = v.integer("installer_size_bytes", input.installer_size_bytes, { min: 1, max: 2 ** 53 });
  const nsisSignature = readSignature(v, "nsis_signature", input.nsis_signature);
  const msiSignature = readSignature(v, "msi_signature", input.msi_signature);
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
      "SELECT id FROM wafx_releases WHERE version = ? AND id <> ?",
      version,
      id,
    );
    if (clash !== null) throw conflict(`Version ${version} is already recorded`);
  }

  try {
    await db.run(
      `UPDATE wafx_releases SET version = coalesce(?, version),
                                channel = coalesce(?, channel),
                                notes = coalesce(?, notes),
                                installer_url_kind = coalesce(?, installer_url_kind),
                                installer_url = coalesce(?, installer_url),
                                installer_sha256 = ?,
                                installer_size_bytes = coalesce(?, installer_size_bytes),
                                nsis_signature = coalesce(?, nsis_signature),
                                msi_signature = coalesce(?, msi_signature),
                                published = coalesce(?, published),
                                release_date = coalesce(?, release_date),
                                updated_at = ?
        WHERE id = ?`,
      version ?? null,
      channel ?? null,
      notes ?? null,
      urlKind ?? null,
      url ?? null,
      input.installer_sha256 === undefined ? str(existing.installer_sha256) : (sha256 ?? null),
      size ?? null,
      // coalesce keeps "absent means unchanged"; to clear a signature the panel
      // sends an empty string, which becomes NULL.
      input.nsis_signature === undefined ? str(existing.nsis_signature) : (nsisSignature ?? null),
      input.msi_signature === undefined ? str(existing.msi_signature) : (msiSignature ?? null),
      published === undefined ? null : bool(published),
      releaseDate ?? null,
      nowIso(),
      id,
    );
  } catch (error) {
    throw writeFailure(error, `release ${id}`);
  }

  const nowPublished = published ?? flag(existing.published);
  await record(db, {
    action: nowPublished !== flag(existing.published)
      ? nowPublished
        ? "release.publish"
        : "release.unpublish"
      : "release.update",
    target: version ?? str(existing.version),
    adminId: c.get("admin").adminId,
    ip: c.get("ip"),
  });

  return c.json({ ok: true, id });
});

releaseRoutes.delete("/admin/releases/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const existing = await db.first<{ version: string }>(
    "SELECT version FROM wafx_releases WHERE id = ?",
    id,
  );
  if (existing === null) throw notFound("Release");

  const { changes } = await db.run("DELETE FROM wafx_releases WHERE id = ?", id);
  if (changes === 0) throw notFound("Release");

  await record(db, {
    action: "release.delete",
    target: str(existing.version),
    adminId: c.get("admin").adminId,
    ip: c.get("ip"),
  });
  return c.json({ ok: true, id });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Reads the audit log, newest first.
 *
 * `limit` is bounded because this endpoint is paginated from the panel and an
 * unbounded read would be the one route capable of returning more rows than the
 * table holds.
 */
releaseRoutes.get("/admin/audit", async (c) => {
  const db = c.get("db");
  const limitParam = c.req.query("limit");
  const limit = Math.min(200, Math.max(1, Number(limitParam ?? 100) || 100));

  const rows = await db.all<{
    id: number;
    admin_id: string | null;
    action: string;
    target: string | null;
    ip: string | null;
    at: string;
    username: string | null;
  }>(
    `SELECT l.id, l.admin_id, l.action, l.target, l.ip, l.at, a.username
       FROM admin_audit l
       LEFT JOIN admins a ON a.id = l.admin_id
      ORDER BY l.at DESC, l.id DESC
      LIMIT ?`,
    limit,
  );

  return c.json({
    entries: rows.map((row) => ({
      id: num(row.id),
      admin_id: row.admin_id === null ? null : str(row.admin_id),
      username: row.username === null ? null : str(row.username),
      action: str(row.action),
      target: row.target === null ? null : str(row.target),
      ip: row.ip === null ? null : str(row.ip),
      at: str(row.at),
    })),
    count: rows.length,
  });
});

function writeFailure(error: unknown, what: string): HttpError {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`admin write failed for ${what}: ${detail}`);
  if (/UNIQUE constraint failed/i.test(detail)) return conflict("That version is already recorded");
  if (/CHECK constraint failed/i.test(detail)) {
    return new HttpError("validation_failed", "That value is not allowed");
  }
  return new HttpError("internal", "The change could not be saved");
}
