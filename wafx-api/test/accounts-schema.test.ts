/**
 * Phase 1 schema tests.
 *
 * `scripts/verify-schema.mjs` proves each constraint fires. These assert the
 * shape those constraints sit on: that the four agreed tables exist, that no
 * account column names a machine, and that the closed enumerations hold exactly
 * the values Wafi X 1.0.0 can act on.
 *
 * The overlap is deliberate. A constraint test cannot notice a column that was
 * never added, and a shape test cannot notice a constraint that quietly stopped
 * firing. Phase 1 is where both matter most, because every route written in
 * Phase 2 is written against this shape - and the privacy properties below are
 * the kind that are much cheaper to assert now than to unpick later.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "./harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");
const accountsMigration = join(migrationsDir, "0003_accounts.sql");

const ACCOUNT_TABLES = ["accounts", "account_sessions", "account_tokens", "pro_grants"] as const;

/**
 * The whole of each table, column by column.
 *
 * An allowlist rather than a denylist: adding a column to an account table
 * should be a change someone makes on purpose and updates here, not something
 * that can be done quietly and reviewed later.
 */
const EXPECTED_COLUMNS: Record<(typeof ACCOUNT_TABLES)[number], string[]> = {
  accounts: [
    "id",
    "email",
    "password_hash",
    "password_salt",
    "iterations",
    "disabled",
    "created_at",
    "last_login_at",
    "disabled_at",
    "disabled_by",
    "disabled_by_username",
  ],
  account_sessions: ["token_hash", "account_id", "created_at", "expires_at", "last_seen_at"],
  account_tokens: ["token_hash", "account_id", "purpose", "created_at", "expires_at", "used_at"],
  pro_grants: [
    "id",
    "account_id",
    "plan",
    "granted_at",
    "granted_by",
    "granted_by_username",
    "expires_at",
    "revoked_at",
    "revoked_by",
    "revoked_by_username",
    "revoke_reason",
    "note",
  ],
};

/**
 * Anything that would attach an account to a machine, a location or a habit.
 *
 * Matched exactly, so the failure names one column and a legitimate name is
 * never caught by accident.
 *
 * `admin_audit.ip` is the one device-adjacent column in the schema and is
 * absent here on purpose: it is an operator audit trail, it predates Phase 1,
 * and it is joined to no account. This list is about the account tables.
 */
const DEVICE_COLUMNS = [
  "machine_id",
  "machine_guid",
  "machineguid",
  "machine_name",
  "hwid",
  "hardware_id",
  "install_id",
  "device_id",
  "device_fingerprint",
  "fingerprint",
  "serial",
  "serial_number",
  "mac",
  "mac_address",
  "hostname",
  "computer_name",
  "user_agent",
  "ua",
  "ip",
  "ip_address",
  "remote_addr",
  "client_ip",
  "last_ip",
  "lat",
  "lon",
  "latitude",
  "longitude",
  "geo",
  "telemetry",
];

/** Stripe arrives after 1.0.0. A column that is always NULL is one someone trusts. */
const BILLING_COLUMNS = [
  "stripe_customer_id",
  "stripe_subscription_id",
  "stripe_price_id",
  "stripe_event_id",
  "customer_id",
  "subscription_id",
  "price_id",
  "webhook_event",
  "billing_customer",
  "invoice_id",
];

function schema(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // Several assertions below are FOREIGN KEY constraints, which are inert
  // unless enforcement is on. `node:sqlite` enables it by default; stated here
  // so a future default change cannot turn these into no-ops.
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Record<
    string,
    unknown
  >[];
  return rows.map((row) => String(row.name)).sort();
}

function tableSql(db: DatabaseSync, table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as
    | Record<string, unknown>
    | undefined;
  const sql = row?.sql;
  return typeof sql === "string" ? sql : "";
}

/**
 * The quoted values of a `CHECK (<column> IN (...))` clause, or null when the
 * clause is not there in that shape.
 *
 * Read out of the stored DDL rather than off a live database, because the claim
 * being tested is that the constraint is *declared*. A value could satisfy a
 * constraint that is not there at all.
 */
function enumValues(sql: string, column: string): string[] | null {
  const found = new RegExp(`${column} IN \\(([^)]*)\\)`).exec(sql);
  const body = found?.[1];
  if (body === undefined) return null;
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? "");
}

describe("Phase 1 - accounts schema", () => {
  test("0003 creates exactly the four agreed tables", () => {
    const sql = readFileSync(accountsMigration, "utf8");
    const created = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);
    assert.deepEqual(
      [...created].sort(),
      [...ACCOUNT_TABLES].sort(),
      "0003 must add accounts, account_sessions, account_tokens and pro_grants - nothing else",
    );
  });

  test("each account table is exactly the agreed column set", () => {
    const db = schema();
    for (const table of ACCOUNT_TABLES) {
      assert.deepEqual(
        columnsOf(db, table),
        [...EXPECTED_COLUMNS[table]].sort(),
        `${table} does not have the agreed columns - nothing may be added without updating this list`,
      );
    }
  });

  test("no account table binds an account to a machine, a place or a habit", () => {
    const db = schema();
    for (const table of ACCOUNT_TABLES) {
      const found = columnsOf(db, table).filter((column) =>
        DEVICE_COLUMNS.includes(column.toLowerCase()),
      );
      assert.deepEqual(found, [], `${table} gained a device or telemetry column`);
    }
  });

  test("a session row describes a login, not a device", () => {
    // Stated separately because it is the sharpest edge of the rule above: this
    // is the table that would tempt an implementer into recording where the
    // login came from, and nothing in Phase 2 should want that.
    const db = schema();
    const forbidden = columnsOf(db, "account_sessions").filter((column) =>
      ["ip", "ip_address", "client_ip", "remote_addr", "user_agent", "ua", "device_id"].includes(
        column.toLowerCase(),
      ),
    );
    assert.deepEqual(forbidden, []);
  });

  test("the account tables reference only accounts and admins", () => {
    const db = schema();
    for (const table of ACCOUNT_TABLES) {
      const rows = db
        .prepare(`SELECT "table" AS target FROM pragma_foreign_key_list('${table}')`)
        .all() as Record<string, unknown>[];
      for (const row of rows) {
        assert.ok(
          ["accounts", "admins"].includes(String(row.target)),
          `${table} references ${String(row.target)}, which is neither accounts nor admins`,
        );
      }
    }
  });

  test("accounts carries the same password material as admins", () => {
    // Same client-side PBKDF2 model, same storage shape. A divergence here would
    // mean one login path stretches in the browser and the other does not.
    const db = schema();
    const admins = columnsOf(db, "admins");
    const accounts = columnsOf(db, "accounts");
    for (const column of ["password_hash", "password_salt", "iterations"]) {
      assert.ok(admins.includes(column), `admins lost ${column}`);
      assert.ok(accounts.includes(column), `accounts lost ${column}`);
    }
    for (const bound of ["iterations >= 100000", "iterations <= 5000000"]) {
      assert.ok(
        tableSql(db, "admins").includes(bound),
        `admins no longer enforces \`${bound}\``,
      );
      assert.ok(
        tableSql(db, "accounts").includes(bound),
        `accounts no longer enforces \`${bound}\``,
      );
    }
  });

  test("Pro lives only in pro_grants", () => {
    // `backend/` carries the split this avoids: `users.plan` beside an
    // `entitlements` table, with no way to say which one is authoritative when
    // they disagree. One table answers the question, so there is nothing to
    // reconcile and nobody can be locked out by a stale column.
    const db = schema();
    const onAccounts = columnsOf(db, "accounts").filter((column) => /^pro|is_pro|plan$/.test(column));
    assert.deepEqual(onAccounts, [], "accounts must not carry Pro state beside pro_grants");
  });

  test("token purposes are closed to the three flows deferred to 1.1", () => {
    const db = schema();
    const listed = enumValues(tableSql(db, "account_tokens"), "purpose");
    assert.ok(listed, "account_tokens.purpose must be an explicit closed set");
    assert.deepEqual(listed.sort(), ["email_change", "email_verify", "password_reset"]);
  });

  test("grant plans are closed to what 1.0.0 can actually produce", () => {
    // `lifetime` is not hypothetical: the desktop app gates four lifetime tools
    // on `plan == "lifetime"`. The Stripe-era plans are absent on purpose and
    // arrive with the Stripe migration, which rebuilds the table the way 0002
    // rebuilt `admins`.
    const db = schema();
    const listed = enumValues(tableSql(db, "pro_grants"), "plan");
    assert.ok(listed, "pro_grants.plan must be an explicit closed set");
    assert.deepEqual(listed.sort(), ["lifetime", "pro"]);
  });

  test("no account table carries a Stripe column", () => {
    const db = schema();
    for (const table of ACCOUNT_TABLES) {
      const found = columnsOf(db, table).filter((column) =>
        BILLING_COLUMNS.includes(column.toLowerCase()),
      );
      assert.deepEqual(found, [], `${table} carries billing state that has no value in 1.0.0`);
    }
  });

  test("deleting an account removes its sessions, tokens and grants", () => {
    const db = schema();
    db.exec(
      "INSERT INTO admins (id,username,password_hash,password_salt,iterations)" +
        " VALUES ('a1','wafi','" +
        "d".repeat(64) +
        "','0123456789abcdef',600000)",
    );
    db.exec(
      "INSERT INTO accounts (id,email,password_hash,password_salt,iterations)" +
        " VALUES ('u1','one@example.org','" +
        "d".repeat(64) +
        "','0123456789abcdef',600000)",
    );
    db.exec(
      "INSERT INTO account_sessions (token_hash,account_id,expires_at)" +
        " VALUES ('" +
        "a".repeat(64) +
        "','u1','2999-01-01T00:00:00Z')",
    );
    db.exec(
      "INSERT INTO account_tokens (token_hash,account_id,purpose,expires_at)" +
        " VALUES ('" +
        "b".repeat(64) +
        "','u1','email_verify','2999-01-01T00:00:00Z')",
    );
    db.exec(
      "INSERT INTO pro_grants (id,account_id,granted_by,granted_by_username)" +
        " VALUES ('g1','u1','a1','wafi')",
    );

    db.exec("DELETE FROM accounts WHERE id = 'u1'");

    for (const table of ["account_sessions", "account_tokens", "pro_grants"]) {
      const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as Record<string, unknown>;
      assert.equal(Number(row.n), 0, `${table} outlived the account it belongs to`);
    }
  });

  test("the accounts migration names no other product and holds no key material", () => {
    // Phase 0.1 moved Wafi X to its own product identity. Schema is not a place
    // where the old one can leak back in, and nothing here may ever hold key
    // material - the Wafi X license key is minted in Phase 5 and lives outside
    // the repository.
    const sql = readFileSync(accountsMigration, "utf8");
    for (const forbidden of ["pctweaker", "pc tweaker", "aurelioavila", "-----begin"]) {
      assert.ok(
        !sql.toLowerCase().includes(forbidden),
        `0003_accounts.sql mentions \`${forbidden}\``,
      );
    }
  });
});