/**
 * Admin sessions.
 *
 * Design points worth stating, because each is a decision rather than a
 * default:
 *
 * - The cookie holds a 32-byte random token. Only its SHA-256 is stored, so a
 *   database dump cannot be replayed as a login.
 * - Cookies are `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`. The
 *   browser will not expose the token to the panel's JavaScript, so an XSS in
 *   the panel cannot read the session out of storage. `SameSite=Strict` is the
 *   first half of the CSRF defence; the Origin check in middleware/csrf.ts is
 *   the second, because a browser can be made to omit SameSite behaviour by
 *   nothing but being old, and defence in depth is cheap here.
 * - Sessions slide: each verified request pushes `expires_at` forward, so a
 *   12-hour session means 12 hours of use rather than 12 hours from login.
 * - Sessions cascade from `admins`, so disabling an operator takes effect at
 *   once instead of whenever their cookie happens to expire.
 */

import type { Config } from "./env.ts";
import type { Db } from "./db.ts";
import { nowIso, sessionExpiry } from "./db.ts";
import { newSessionToken, sha256Hex } from "./crypto.ts";

export const SESSION_COOKIE = "wafx_admin";

export interface AdminSession {
  readonly adminId: string;
  readonly username: string;
  /** Sliding expiry, seconds from now. Drives the cookie's Max-Age. */
  readonly expiresInSeconds: number;
}

export interface AdminRow {
  readonly id: string;
  readonly username: string;
  readonly password_hash: string;
  readonly password_salt: string;
  readonly iterations: number;
  readonly disabled: number;
}

/**
 * Parses a Cookie header into a map.
 *
 * Written by hand rather than pulled in as a dependency: this is the only cookie
 * the Worker reads, and a header parser is exactly the kind of code that should
 * be short enough to read.
 */
export function parseCookies(header: string | undefined | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (name === "") continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    // A duplicate name is ambiguous; refusing to guess is safer than letting
    // the first or last one win.
    if (out.has(name)) out.set(name, "");
    else out.set(name, value);
  }
  return out;
}

/**
 * Serialises the session cookie.
 *
 * `__Host-` prefix is used when the origin is https. It is a browser-enforced
 * guarantee that the cookie has no Domain attribute and Path=/, which blocks a
 * subdomain from setting a cookie that shadows this one - the cookie-tossing
 * attack that `SameSite` alone does not cover.
 */
export function sessionCookieHeader(token: string, ttlSeconds: number, secure: boolean): string {
  const name = secure ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
  const attributes = [
    `${name}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(ttlSeconds))}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** Cookie that clears the session. Same name and path, so it actually matches. */
export function clearCookieHeader(secure: boolean): string {
  const name = secure ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function readSessionToken(cookieHeader: string | undefined | null): string | null {
  const cookies = parseCookies(cookieHeader);
  for (const candidate of [SESSION_COOKIE, `__Host-${SESSION_COOKIE}`]) {
    const value = cookies.get(candidate);
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

/** Creates a session row and returns the raw token, which exists only here. */
export async function create(db: Db, adminId: string, config: Config): Promise<string> {
  const token = newSessionToken();
  const tokenHash = await sha256Hex(token);
  await db.run(
    `INSERT INTO admin_sessions (token_hash, admin_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
    tokenHash,
    adminId,
    nowIso(),
    sessionExpiry(config),
    nowIso(),
  );
  return token;
}

/**
 * Resolves a token to a session, or null.
 *
 * `disabled` is re-read on every request rather than trusted from a cookie or a
 * cached session, so `admins.disabled = 1` revokes access immediately. Expired
 * rows are deleted on sight, which keeps the table from accumulating dead
 * sessions without needing a cron trigger.
 */
export async function resolve(
  db: Db,
  token: string,
  config: Config,
): Promise<AdminSession | null> {
  const tokenHash = await sha256Hex(token);
  const row = await db.first<{
    admin_id: string;
    username: string;
    expires_at: string;
    disabled: number;
  }>(
    `SELECT s.admin_id, s.expires_at, a.username, a.disabled
       FROM admin_sessions s
       JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = ?`,
    tokenHash,
  );

  if (!row) return null;
  if (Number(row.disabled) === 1) {
    await db.run("DELETE FROM admin_sessions WHERE token_hash = ?", tokenHash);
    return null;
  }

  if (Date.parse(String(row.expires_at)) <= Date.now()) {
    await db.run("DELETE FROM admin_sessions WHERE token_hash = ?", tokenHash);
    return null;
  }

  const expiresAt = sessionExpiry(config);
  await db.run(
    "UPDATE admin_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
    nowIso(),
    expiresAt,
    tokenHash,
  );

  return {
    adminId: String(row.admin_id),
    username: String(row.username),
    expiresInSeconds: config.sessionTtlHours * 3600,
  };
}

export async function destroy(db: Db, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await db.run("DELETE FROM admin_sessions WHERE token_hash = ?", tokenHash);
}

/** Used after a password change: every session but the current one dies. */
export async function destroyAllForAdmin(db: Db, adminId: string, exceptToken?: string): Promise<void> {
  if (exceptToken === undefined) {
    await db.run("DELETE FROM admin_sessions WHERE admin_id = ?", adminId);
    return;
  }
  const keep = await sha256Hex(exceptToken);
  await db.run("DELETE FROM admin_sessions WHERE admin_id = ? AND token_hash <> ?", adminId, keep);
}

export function adminByUsername(db: Db, username: string): Promise<AdminRow | null> {
  return db.first<AdminRow>(
    `SELECT id, username, password_hash, password_salt, iterations, disabled
       FROM admins WHERE username = ?`,
    username.trim().toLowerCase(),
  );
}

export function adminById(db: Db, id: string): Promise<AdminRow | null> {
  return db.first<AdminRow>(
    `SELECT id, username, password_hash, password_salt, iterations, disabled
       FROM admins WHERE id = ?`,
    id,
  );
}

export function adminCount(db: Db): Promise<number> {
  return db
    .first<{ n: number }>("SELECT count(*) AS n FROM admins")
    .then((row) => Number(row?.n ?? 0));
}
