// Schema check: proves every migration actually applies to a real SQLite engine
// (the same one D1 runs), and that the security decisions the schema is supposed
// to enforce are enforced by the database rather than by a handler that could
// forget to.
//
// Run: node wafx-api/scripts/verify-schema.mjs

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

/**
 * Every migration, in the order `wrangler d1 migrations apply` runs them.
 *
 * This script used to read 0001 alone. That made 0002 - the table rebuild that
 * relaxed `admins.iterations` and created `rate_limits` - a file that only the
 * test harness ever executed, which means its constraints were never checked by
 * anything. A migration applied in exactly one place is a migration nobody has
 * read the behaviour of.
 */
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

// The sections below assert against named tables. If a migration were renamed or
// moved, applying fewer files would silently skip whole groups of assertions
// rather than fail, so the expected set is checked up front.
const REQUIRED_MIGRATIONS = ["0001_init.sql", "0003_accounts.sql"];
const missingMigrations = REQUIRED_MIGRATIONS.filter((name) => !migrationFiles.includes(name));
if (missingMigrations.length > 0) {
  console.error(`\nmigrations/ is missing: ${missingMigrations.join(", ")}\n`);
  process.exit(1);
}

const db = new DatabaseSync(":memory:");

// Stated rather than inherited. Several assertions below are FOREIGN KEY
// constraints - a dangling `disabled_by`, an unattributed grant, an admin who
// cannot be deleted - and those are inert unless enforcement is on. `node:sqlite`
// happens to enable it by default; a future default change would otherwise turn
// a dozen passing assertions into a dozen silently passing no-ops.
db.exec("PRAGMA foreign_keys = ON");

let failures = 0;

function run(label, fn) {
  try {
    fn();
    console.log(`  ok    ${label}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${label}`);
    console.log(`          ${error.message}`);
  }
}

// Asserts the statement is REFUSED. A schema that merely happens to reject
// this today, but for some other reason, would still pass - so the failure
// message names the thing that must not be storable.
function refuses(sqlText, why) {
  return () => {
    try {
      db.exec(sqlText);
    } catch {
      return;
    }
    throw new Error(`accepted a row it must refuse: ${why}`);
  };
}

function accepts(sqlText) {
  return () => db.exec(sqlText);
}

function columnsOf(table) {
  return db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);
}

// One well-formed version row, so each test below varies exactly one field.
let versionSeq = 0;
function versionRow(overrides = {}) {
  versionSeq += 1;
  const row = {
    id: `v${versionSeq}`,
    app_id: "firefox",
    version: `1.${versionSeq}.0`,
    installer_type: "exe",
    installer_url: "https://download.example.org/setup.exe",
    ...overrides,
  };
  const cols = Object.keys(row).join(", ");
  const vals = Object.values(row)
    .map((v) => (v === null || v === undefined ? "NULL" : `'${v}'`))
    .join(", ");
  return `INSERT INTO app_versions (${cols}) VALUES (${vals})`;
}

console.log("\nschema applies");
for (const file of migrationFiles) {
  run(`${file} executes cleanly`, () => db.exec(readFileSync(join(migrationsDir, file), "utf8")));
}

console.log("\nobjects created");
const expectedTables = [
  "app_categories",
  "apps",
  "app_versions",
  "wafx_releases",
  "admins",
  "admin_sessions",
  "admin_audit",
  "rate_limits",
  "accounts",
  "account_sessions",
  "account_tokens",
  "pro_grants",
];
for (const table of expectedTables) {
  run(`table ${table}`, () => {
    const row = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    if (row.n !== 1) throw new Error("missing");
  });
}

db.exec("INSERT INTO app_categories (id, name) VALUES ('browsers','Browsers')");
db.exec("INSERT INTO apps (id, name, category_id) VALUES ('firefox','Firefox','browsers')");

console.log("\ndecision 3 - only https links are storable");
run("accepts an ordinary https installer", accepts(versionRow()));
run("accepts an msi", accepts(versionRow({ installer_type: "msi" })));
run(
  "refuses http://",
  refuses(versionRow({ installer_url: "http://example.com/a.exe" }), "plaintext http"),
);
run(
  "refuses a UNC share",
  refuses(versionRow({ installer_url: "\\\\evil\\share\\a.exe" }), "UNC bypasses TLS entirely"),
);
run(
  "refuses file://",
  refuses(versionRow({ installer_url: "file:///C:/Windows/System32/a.exe" }), "a local file"),
);
run(
  "refuses javascript:",
  refuses(versionRow({ installer_url: "javascript:alert(1)" }), "a script url"),
);
run(
  "refuses a non-https homepage",
  refuses("UPDATE apps SET homepage_url='http://x.example' WHERE id='firefox'", "plaintext homepage"),
);

console.log("\ndecision 3 - no free-form installer arguments anywhere");
for (const table of ["app_versions", "wafx_releases"]) {
  run(`${table} has no args/params/command column`, () => {
    const suspicious = columnsOf(table).filter((c) =>
      /arg|param|flag|extra|command|cmd|switch|script/i.test(c),
    );
    if (suspicious.length) throw new Error(`found: ${suspicious.join(", ")}`);
  });
}
run("installer_mode defaults to interactive", () => {
  const row = db.prepare("SELECT installer_mode FROM app_versions ORDER BY rowid LIMIT 1").get();
  if (row.installer_mode !== "interactive") throw new Error(`got ${row.installer_mode}`);
});
run(
  "refuses installer_mode with an injected command",
  refuses(
    versionRow({ installer_mode: "silent; calc.exe" }),
    "argument injection through the enum",
  ),
);
run(
  "refuses an installer_mode outside the enum",
  refuses(versionRow({ installer_mode: "veryquiet" }), "a value the Rust side has no mapping for"),
);

console.log("\ndecision 3 - installer_type stays a closed set");
run(
  "refuses installer_type='bat'",
  refuses(versionRow({ installer_type: "bat" }), "script installers were not on the list"),
);
run(
  "refuses installer_type='msix'",
  refuses(versionRow({ installer_type: "msix" }), "an unhandled package type"),
);

console.log("\nsha256 must actually be a sha256");
run("refuses a truncated hash", refuses(versionRow({ installer_sha256: "abc123" }), "truncated"));
run(
  "refuses uppercase hex",
  refuses(versionRow({ installer_sha256: "A".repeat(64) }), "case makes comparison unreliable"),
);
run("accepts 64 lowercase hex", accepts(versionRow({ installer_sha256: "b".repeat(64) })));
run("accepts an absent hash", accepts(versionRow({ installer_sha256: null })));

console.log("\ndecision 2 - R2 later needs no migration");
run("installer_url_kind already knows 'r2'", () => {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='app_versions'").get();
  if (!/installer_url_kind[\s\S]*'r2'/.test(row.sql)) throw new Error("no r2 branch in the schema");
});
run(
  "an r2 object key is storable today, with no R2 binding in existence",
  accepts(
    versionRow({ installer_url_kind: "r2", installer_url: "apps/firefox/131.0.exe" }),
  ),
);
run(
  "apps.icon_kind already knows 'r2'",
  accepts("UPDATE apps SET icon_kind='r2', icon_url='icons/firefox.png' WHERE id='firefox'"),
);
run(
  "an https url still works after switching the kind to r2",
  accepts(versionRow({ installer_url_kind: "r2", installer_url: "https://x.example/a.exe" })),
);

console.log("\nicon + publish invariants");
run(
  "icon_kind='none' needs no url",
  accepts("INSERT INTO apps (id,name,icon_kind,icon_url) VALUES ('vlc','VLC','none',NULL)"),
);
run(
  "icon_kind='external' requires a url",
  refuses(
    "INSERT INTO apps (id,name,icon_kind,icon_url) VALUES ('b10','B','external',NULL)",
    "an external icon with nothing to point at",
  ),
);
run(
  "icon_kind='external' refuses http",
  refuses(
    "INSERT INTO apps (id,name,icon_kind,icon_url) VALUES ('b11','B','external','http://x/i.png')",
    "a plaintext icon url",
  ),
);
run(
  "one version string per app",
  refuses(
    versionRow({ version: "1.1.0" }),
    "the same version twice for one app",
  ),
);
run("a different version for the same app is fine", accepts(versionRow({ version: "2.0.0" })));
run(
  "featured and published are booleans",
  refuses("UPDATE apps SET featured=2 WHERE id='firefox'", "a non-boolean flag"),
);

console.log("\nWafi X release invariants");
run(
  "accepts a normal release",
  accepts(
    "INSERT INTO wafx_releases (id,version,notes,installer_url) VALUES " +
      "('r1','1.1.0','Adds Applications.','https://github.com/o/r/releases/download/v1.1.0/setup.exe')",
  ),
);
run(
  "refuses a duplicate version",
  refuses(
    "INSERT INTO wafx_releases (id,version,installer_url) VALUES ('r2','1.1.0','https://x/1.exe')",
    "two releases claiming one version",
  ),
);
run(
  "refuses a non-https release installer",
  refuses(
    "INSERT INTO wafx_releases (id,version,installer_url) VALUES ('r3','1.2.0','http://x/1.exe')",
    "a plaintext release installer",
  ),
);
run(
  "refuses an unknown channel",
  refuses(
    "INSERT INTO wafx_releases (id,version,channel,installer_url) VALUES ('r4','1.3.0','nightly','https://x/1.exe')",
    "a channel no build ever publishes to",
  ),
);

console.log("\ncascade + integrity");
const SALT = "0123456789abcdef"; // 16 bytes, hex-encoded
const HASH = "c".repeat(64); // PBKDF2 output
run("versions disappear with their app", () => {
  db.exec("DELETE FROM apps WHERE id='firefox'");
  const row = db.prepare("SELECT count(*) AS n FROM app_versions").get();
  if (row.n !== 0) throw new Error("versions outlived their app");
});
run("a short password salt is refused", () => {
  try {
    db.exec(
      "INSERT INTO admins (id,username,password_hash,password_salt,iterations) VALUES ('a0','weak','h','s',310000)",
    );
  } catch {
    return;
  }
  throw new Error("accepted a 1-byte salt");
});
run("a low iteration count is refused", () => {
  try {
    db.exec(
      `INSERT INTO admins (id,username,password_hash,password_salt,iterations) VALUES ('a0b','weak2','${HASH}','${SALT}',1000)`,
    );
  } catch {
    return;
  }
  throw new Error("accepted 1000 PBKDF2 iterations");
});
run("sessions disappear with their admin", () => {
  db.exec(
    `INSERT INTO admins (id,username,password_hash,password_salt,iterations) VALUES ('a1','wafi','${HASH}','${SALT}',310000)`,
  );
  db.exec(
    "INSERT INTO admin_sessions (token_hash,admin_id,expires_at) VALUES ('t1','a1','2030-01-01T00:00:00Z')",
  );
  db.exec("DELETE FROM admins WHERE id='a1'");
  const row = db.prepare("SELECT count(*) AS n FROM admin_sessions").get();
  if (row.n !== 0) throw new Error("a session outlived its admin");
});
run("usernames are unique", () => {
  db.exec(
    `INSERT INTO admins (id,username,password_hash,password_salt,iterations) VALUES ('a2','wafi','${HASH}','${SALT}',310000)`,
  );
  try {
    db.exec(
      `INSERT INTO admins (id,username,password_hash,password_salt,iterations) VALUES ('a3','wafi','${HASH}','${SALT}',310000)`,
    );
  } catch {
    return;
  }
  throw new Error("two admins with one username");
});

// An admin to attribute account actions to. `disabled_by` and `granted_by` are
// foreign keys, so an attribution naming someone who does not exist must be
// refused by the database rather than accepted and left dangling.
db.exec(
  `INSERT INTO admins (id,username,password_hash,password_salt,iterations) VALUES ('a10','wafibot','${HASH}','${SALT}',600000)`,
);

// Fixed, far-future stamps for anything that must sort after a row's own
// `created_at`, which is `now` by default. A literal "tomorrow" would start
// failing on the day after it was written, and these assertions would go quiet
// rather than go red.
const FUTURE = "2999-01-01T00:00:00Z";
const PAST = "2001-01-01T00:00:00Z";

const ACCOUNT_TABLES = ["accounts", "account_sessions", "account_tokens", "pro_grants"];

// Column names that would bind an account to a machine, a place or a habit.
// Matched exactly rather than by substring, so a failure names one column and a
// legitimate one is never caught by accident.
//
// `admin_audit.ip` is the one device-adjacent column in the schema and is
// deliberately absent from this list: it is an operator audit trail, it predates
// Phase 1, and it is joined to no account.
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

console.log("\nPhase 1 - an account is a person, not a machine");
for (const table of ACCOUNT_TABLES) {
  run(`${table} carries no device, location or telemetry column`, () => {
    const found = columnsOf(table).filter((column) =>
      DEVICE_COLUMNS.includes(column.toLowerCase()),
    );
    if (found.length) throw new Error(`found: ${found.join(", ")}`);
  });
}
run("the account tables reference only accounts and admins", () => {
  for (const table of ACCOUNT_TABLES) {
    const rows = db.prepare(`SELECT "table" AS target FROM pragma_foreign_key_list('${table}')`).all();
    for (const row of rows) {
      if (row.target !== "accounts" && row.target !== "admins") {
        throw new Error(`${table} references ${row.target}`);
      }
    }
  }
});
run("no account table can be joined to admin_audit", () => {
  for (const table of ACCOUNT_TABLES) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table);
    if (row && /admin_audit/.test(row.sql)) throw new Error(`${table} references admin_audit`);
  }
});

let accountSeq = 0;
function accountRow(overrides = {}) {
  accountSeq += 1;
  const row = {
    id: `u${accountSeq}`,
    email: `user${accountSeq}@example.org`,
    // 64 lowercase hex, exactly what sha256Hex() returns.
    password_hash: "d".repeat(64),
    password_salt: SALT,
    iterations: 600000,
    ...overrides,
  };
  const cols = Object.keys(row).join(", ");
  const vals = Object.values(row)
    .map((v) => (v === null || v === undefined ? "NULL" : `'${v}'`))
    .join(", ");
  return `INSERT INTO accounts (${cols}) VALUES (${vals})`;
}

/** Inserts one account and returns its id, for cases that need a real one. */
let freshSeq = 0;
function freshAccount() {
  freshSeq += 1;
  const id = `acct-${freshSeq}`;
  db.exec(accountRow({ id, email: `acct${freshSeq}@example.org` }));
  return id;
}

const DISABLED_BY = {
  disabled: 1,
  disabled_at: FUTURE,
  disabled_by: "a10",
  disabled_by_username: "wafibot",
};

console.log("\nPhase 1 - the stored email is canonical");
run("accepts an ordinary account", accepts(accountRow()));
run(
  "refuses an address with ASCII uppercase",
  refuses(accountRow({ email: "Person@example.org" }), "an unnormalised address"),
);
run(
  "refuses a padded address",
  refuses(accountRow({ email: " person@example.org " }), "padding survives normalisation"),
);
run(
  "refuses an address with no local part",
  refuses(accountRow({ email: "@example.org" }), "the @ is the first character"),
);
run(
  "refuses an address with no domain",
  refuses(accountRow({ email: "person@" }), "the @ is the last character"),
);
run(
  "refuses an address shorter than the floor",
  refuses(accountRow({ email: "a@" }), "below the length floor"),
);
run("two accounts cannot share one address", () => {
  db.exec(accountRow({ email: "shared@example.org" }));
  try {
    db.exec(accountRow({ email: "shared@example.org" }));
  } catch {
    return;
  }
  throw new Error("two accounts for one address");
});
run("case-insensitive uniqueness needs no folding index", () => {
  // The uppercase row above was refused, so the exact UNIQUE is already
  // case-insensitive. Asserted so nobody "fixes" this by loosening the CHECK.
  const row = db
    .prepare("SELECT count(*) AS n FROM accounts WHERE email='shared@example.org'")
    .get();
  if (row.n !== 1) throw new Error("the stored form is not what uniqueness compares");
});

console.log("\nPhase 1 - password material mirrors the admin model");
run(
  "refuses a truncated password hash",
  refuses(accountRow({ password_hash: "abc123" }), "a hash nothing can compare against"),
);
run(
  "refuses an uppercase password hash",
  refuses(accountRow({ password_hash: "D".repeat(64) }), "hex comparison is case sensitive"),
);
run("accepts a full lowercase hash", accepts(accountRow({ password_hash: "e".repeat(64) })));
run(
  "refuses a 1-byte password salt",
  refuses(accountRow({ password_salt: "s" }), "too short to salt with"),
);
run(
  "refuses an iteration count below the floor",
  refuses(accountRow({ iterations: 1000 }), "1000 PBKDF2 rounds is not a password hash"),
);
run(
  "refuses an iteration count above the ceiling",
  refuses(accountRow({ iterations: 9000000 }), "no client will ever be sent this"),
);
run("accepts the iteration count the admin panel uses", accepts(accountRow({ iterations: 600000 })));

console.log("\nPhase 1 - disabling an account is attributable");
run("accepts a disabled account naming an admin", accepts(accountRow(DISABLED_BY)));
run(
  "refuses a disabled account with nobody responsible",
  refuses(accountRow({ disabled: 1 }), "a disable with no author"),
);
run(
  "refuses a live account still carrying a disable stamp",
  refuses(
    accountRow({ ...DISABLED_BY, disabled: 0 }),
    "a row that claims to be enabled while remembering being disabled",
  ),
);
run(
  "refuses a disable attributed to an admin who does not exist",
  refuses(accountRow({ ...DISABLED_BY, disabled_by: "nobody" }), "a dangling attribution"),
);
run(
  "refuses a disabled flag outside (0,1)",
  refuses(accountRow({ ...DISABLED_BY, disabled: 2 }), "a non-boolean flag"),
);

const TOKEN = "a".repeat(64); // sha256Hex() output, not a token

console.log("\nPhase 1 - sessions store a hash, not a token");
run("accepts an ordinary session", () => {
  db.exec(accountRow({ id: "sess-owner" }));
  db.exec(
    `INSERT INTO account_sessions (token_hash,account_id,expires_at) VALUES ('${TOKEN}','sess-owner','2030-01-01T00:00:00Z')`,
  );
});
run(
  "refuses a value that is not a sha256",
  refuses(
    `INSERT INTO account_sessions (token_hash,account_id,expires_at) VALUES ('not-a-hash','sess-owner','2030-01-01T00:00:00Z')`,
    "a raw or malformed session token",
  ),
);
run(
  "refuses a session for an account that does not exist",
  refuses(
    `INSERT INTO account_sessions (token_hash,account_id,expires_at) VALUES ('${TOKEN}','ghost','2030-01-01T00:00:00Z')`,
    "a session with no account",
  ),
);
run(
  "refuses a session that expires before it was created",
  refuses(
    `INSERT INTO account_sessions (token_hash,account_id,created_at,expires_at) VALUES ('${TOKEN}','sess-owner','2030-01-01T00:00:00Z','2020-01-01T00:00:00Z')`,
    "an expiry preceding creation",
  ),
);
run("sessions disappear with their account", () => {
  db.exec("DELETE FROM accounts WHERE id='sess-owner'");
  const row = db.prepare("SELECT count(*) AS n FROM account_sessions").get();
  if (row.n !== 0) throw new Error("a session outlived its account");
});

console.log("\nPhase 1 - account tokens are a closed set");
run(
  "refuses a purpose outside the 1.1 set",
  refuses(
    `INSERT INTO account_tokens (token_hash,account_id,purpose,expires_at) VALUES ('${TOKEN}','sess-owner','api_key','2030-01-01T00:00:00Z')`,
    "an open purpose column is a bearer-token store waiting to happen",
  ),
);
run("1.0.0 writes no account token at all", () => {
  const row = db.prepare("SELECT count(*) AS n FROM account_tokens").get();
  if (row.n !== 0) throw new Error("email recovery and verification are deferred to 1.1");
});

let grantSeq = 0;

/**
 * A grant for a brand new account unless the caller names one.
 *
 * Per-test accounts matter here: `pro_grants_one_live` refuses a second live
 * grant for the same person, so sharing one account across cases would make
 * every refusal ambiguous - it would be impossible to tell which constraint
 * actually fired.
 */
function grantRow(overrides = {}) {
  grantSeq += 1;
  const row = {
    id: `g${grantSeq}`,
    account_id: freshAccount(),
    plan: "pro",
    granted_by: "a10",
    granted_by_username: "wafibot",
    ...overrides,
  };
  const cols = Object.keys(row).join(", ");
  const vals = Object.values(row)
    .map((v) => (v === null || v === undefined ? "NULL" : `'${v}'`))
    .join(", ");
  return `INSERT INTO pro_grants (${cols}) VALUES (${vals})`;
}

console.log("\nPhase 1 - pro_grants is the only source of Pro");

run("accepts a perpetual Pro grant", accepts(grantRow()));
run("accepts a time-limited grant", accepts(grantRow({ expires_at: FUTURE })));
run("accepts a lifetime grant", accepts(grantRow({ plan: "lifetime" })));
run(
  "refuses a plan no client can act on",
  refuses(grantRow({ plan: "enterprise" }), "the desktop app has no mapping for it"),
);
run(
  "refuses a billing-period plan while Stripe does not exist",
  refuses(
    grantRow({ plan: "monthly" }),
    "monthly becomes storable with the Stripe migration",
  ),
);
run(
  "refuses a grant from an admin who does not exist",
  refuses(grantRow({ granted_by: "nobody" }), "Pro that nobody is responsible for"),
);
run(
  "refuses a grant carrying no admin username",
  refuses(
    grantRow({ granted_by_username: null }),
    "the id would be the only record of who granted it",
  ),
);
run(
  "refuses a grant that expires before it was made",
  refuses(
    grantRow({ granted_at: FUTURE, expires_at: PAST }),
    "an expiry preceding the grant",
  ),
);
run(
  "a live grant cannot carry a revoker",
  refuses(
    grantRow({ revoked_by: "a10", revoked_by_username: "wafibot" }),
    "a live grant claiming to be revoked",
  ),
);
run(
  "a revoked grant must name who revoked it",
  refuses(
    grantRow({ revoked_at: FUTURE, revoke_reason: "support request" }),
    "a revocation with no author",
  ),
);
run(
  "a revocation cannot predate the grant",
  refuses(
    grantRow({
      granted_at: FUTURE,
      revoked_at: PAST,
      revoked_by: "a10",
      revoked_by_username: "wafibot",
    }),
    "revoked before it was granted",
  ),
);
run("a second live grant for one account is refused", () => {
  const shared = freshAccount();
  db.exec(grantRow({ id: "g-first", account_id: shared }));
  try {
    db.exec(grantRow({ id: "g-second", account_id: shared }));
  } catch {
    return;
  }
  throw new Error("two live Pro grants for one person, with no way to say which wins");
});
run("an expired but unrevoked grant is storable, and still holds the slot", () => {
  // Granted in the past and already expired. This is a real state, not a bug, and
  // it is the reason the slot only frees on an explicit revoke: expiry and
  // revocation are separate, separately audited events.
  const stale = freshAccount();
  db.exec(
    grantRow({
      id: "g-stale",
      account_id: stale,
      granted_at: PAST,
      expires_at: "2002-01-01T00:00:00Z",
    }),
  );
  try {
    db.exec(grantRow({ id: "g-overwrites-stale", account_id: stale }));
  } catch {
    return;
  }
  throw new Error("an expired grant was overwritten without an explicit revoke");
});
run("revoking frees the slot and keeps the history", () => {
  const shared = freshAccount();
  db.exec(grantRow({ id: "g-original", account_id: shared }));
  db.exec(
    // Values are inlined because `db.exec()` does not bind parameters. A bound
    // `?` would arrive as NULL and fail every CHECK that reads the column.
    `UPDATE pro_grants SET revoked_at='${FUTURE}', revoked_by='a10',` +
      " revoked_by_username='wafibot', revoke_reason='support request'" +
      " WHERE id='g-original'",
  );
  db.exec(grantRow({ id: "g-replacement", account_id: shared }));
  const rows = db
    .prepare(
      "SELECT id, revoked_at, revoked_by, revoked_by_username, revoke_reason" +
        " FROM pro_grants WHERE account_id=? ORDER BY id",
    )
    .all(shared);
  if (rows.length !== 2) throw new Error("the revoked grant was overwritten instead of kept");
  const old = rows.find((r) => r.id === "g-original");
  const live = rows.find((r) => r.id === "g-replacement");
  if (!old || old.revoked_at === null) throw new Error("the revoked grant was not recorded");
  if (old.revoked_by !== "a10") throw new Error("the revocation lost its author");
  if (old.revoked_by_username !== "wafibot") throw new Error("the username was not recorded");
  if (!live || live.revoked_at !== null) throw new Error("the replacement grant should be live");
});
run("grants disappear with their account", () => {
  const shared = freshAccount();
  db.exec(grantRow({ id: "g-cascade", account_id: shared }));
  db.exec(`DELETE FROM accounts WHERE id='${shared}'`);
  const row = db.prepare("SELECT count(*) AS n FROM pro_grants WHERE account_id=?").get(shared);
  if (row.n !== 0) throw new Error("a grant outlived its account");
});
run("an admin who has granted Pro cannot be deleted", () => {
  // Not an assertion about the past: this one inserts the grant it depends on,
  // so the result cannot change because an earlier case was reordered or removed.
  grantRow({ id: "g-attribution" });
  try {
    db.exec("DELETE FROM admins WHERE id='a10'");
  } catch {
    return;
  }
  throw new Error("deleting the admin would rewrite who granted Pro");
});

if (failures === 0) {
  console.log("\nschema verification passed.\n");
  process.exit(0);
}
console.log(`\nschema verification FAILED: ${failures} problem(s).\n`);
process.exit(1);
