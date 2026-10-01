// Phase 0 check: proves migrations/0001_init.sql actually applies to a real
// SQLite engine (the same one D1 runs), and that the security decisions the
// schema is supposed to enforce are enforced by the database rather than by a
// handler that could forget to.
//
// Run: node wafx-api/scripts/verify-schema.mjs

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "migrations", "0001_init.sql"), "utf8");

const db = new DatabaseSync(":memory:");

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
run("0001_init.sql executes cleanly", () => db.exec(schemaSql));

console.log("\nobjects created");
const expectedTables = [
  "app_categories",
  "apps",
  "app_versions",
  "wafx_releases",
  "admins",
  "admin_sessions",
  "admin_audit",
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

if (failures === 0) {
  console.log("\nschema verification passed.\n");
  process.exit(0);
}
console.log(`\nschema verification FAILED: ${failures} problem(s).\n`);
process.exit(1);
