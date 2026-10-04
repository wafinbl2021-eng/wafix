/**
 * Audit log.
 *
 * Every mutating admin action lands here. The panel is the only place a
 * privileged operator touches data that ends up on 100 users' machines, so
 * "who unpublished that installer" is worth being able to answer afterwards.
 *
 * Failures are swallowed on purpose. An audit write must not roll back or 500 a
 * change that already succeeded, and losing one audit line is preferable to
 * making the panel unusable under disk pressure. The console note is the
 * signal that something is wrong.
 */

import type { Db } from "./db.ts";
import { nowIso } from "./db.ts";

export type AuditAction =
  | "admin.bootstrap"
  | "admin.login"
  | "admin.login_failed"
  | "admin.logout"
  | "admin.password_changed"
  | "category.create"
  | "category.update"
  | "category.delete"
  | "app.create"
  | "app.update"
  | "app.delete"
  | "app.publish"
  | "app.unpublish"
  | "version.create"
  | "version.update"
  | "version.delete"
  | "version.publish"
  | "version.unpublish"
  | "release.create"
  | "release.update"
  | "release.delete"
  | "release.publish"
  | "release.unpublish"
  | "account.pro_grant"
  | "account.pro_revoke"
  | "account.disable"
  | "account.enable";

export interface AuditEntry {
  readonly action: AuditAction;
  readonly target?: string;
  readonly adminId?: string;
  readonly ip?: string;
}

export async function record(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await db.run(
      "INSERT INTO admin_audit (admin_id, action, target, ip, at) VALUES (?, ?, ?, ?, ?)",
      entry.adminId ?? null,
      entry.action,
      entry.target ?? null,
      entry.ip ?? null,
      nowIso(),
    );
  } catch (error) {
    console.error(
      `audit write failed for ${entry.action}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
