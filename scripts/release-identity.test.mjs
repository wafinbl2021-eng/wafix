// Guards the release identity and the updater signing setup.
//
// Phase 3 added Wafi X branding and a signed-release path. Neither may quietly
// change the identity the already-shipped clients trust: `plugins.updater.pubkey`
// is the only key their updater will accept, and `productName`/`identifier`/
// `publisher` decide where Windows writes the app, its shortcut and its
// uninstaller entry. A drift in either is invisible in a build and only shows up
// on user machines, as an updater that silently never updates or an install that
// no longer replaces the previous version.
//
// These assertions fail loudly instead. Changing any of them on purpose is
// legitimate, but it should be a reviewed edit to this file rather than a
// side effect of reworking the bundle config.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));

const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));

// The base64 blob of the minisign public key compiled into every shipped build.
const COMMITTED_PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDFBNDA3NzYyMzQ4NjMyRDIKUldUU01vWTBZbmRBR3Z1bEN3N2xYK0VIeUwzaEo4UU1lS2ZMR25xMlFHZ2FuUEZvZENzcXdldDYK";

test("release identity is pinned", () => {
  assert.equal(conf.productName, "pc-tweaker-app");
  assert.equal(conf.identifier, "com.aurel.pc-tweaker-app");
  assert.equal(conf.bundle.publisher, "Aurelio Avila");
  assert.equal(
    conf.bundle.createUpdaterArtifacts,
    true,
    "signed updater artifacts are what the client verifies; turning this off would ship an unverifiable update",
  );
});

test("the updater key and feed are the ones shipped clients trust", () => {
  assert.equal(
    conf.plugins.updater.pubkey,
    COMMITTED_PUBKEY,
    "plugins.updater.pubkey changed. Existing installs verify against the old key, so rotating it silently breaks every update until a deliberate migration.",
  );

  const decoded = Buffer.from(conf.plugins.updater.pubkey, "base64").toString("utf8");
  assert.match(decoded, /minisign public key: [0-9A-F]{16}/);

  const endpoints = conf.plugins.updater.endpoints;
  assert.ok(Array.isArray(endpoints) && endpoints.length > 0, "the updater needs a feed");
  assert.ok(
    endpoints.some((url) =>
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download\/latest\.json$/.test(url),
    ),
    `expected a GitHub Releases latest.json endpoint, found: ${JSON.stringify(endpoints)}`,
  );
});

test("update_identity.rs still pins the artifact names and host", () => {
  // Not a byte-for-byte pin: the file is free to be edited. What must not change
  // silently is the contract it enforces, because it is the check that stops an
  // old signed artifact being replayed as a newer version.
  const source = read("src-tauri/src/update_identity.rs");
  assert.match(source, /pc-tweaker-app_\{version\}_x64-setup\.exe/);
  assert.match(source, /pc-tweaker-app_\{version\}_x64_en-US\.msi/);
  assert.match(source, /github\.com/);
  assert.match(
    source,
    /trusted comment: timestamp:/,
    "the minisign trusted comment is what binds a signature to a version",
  );
});

test("no updater private key is stored in the repository", () => {
  const ignored = read(".gitignore");
  assert.match(ignored, /\*\*\/\*\.key$/m, "minisign keys are *.key, which the credential block did not cover");

  // Nothing that looks like key material may be tracked...
  const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  if (tracked.status !== 0) {
    // A source checkout without git cannot be checked this way. The .gitignore
    // assertions above still stand, so skip rather than fail on tooling.
    return;
  }
  const keyFiles = tracked.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && /\.(key|pem|p12|pfx|minisig)$/i.test(line));
  assert.deepEqual(keyFiles, [], `key-shaped files are tracked in git: ${keyFiles.join(", ")}`);

  // ...and no tracked file may carry a minisign secret key inline. The public
  // key in tauri.conf.json is base64 of a two-line *public* key and is allowed.
  const secretKeyComment = /minisign (encrypted )?secret key/;
  for (const file of tracked.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    let contents;
    try {
      contents = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      continue; // binary or unreadable; not a place a key would hide as text
    }
    assert.ok(
      !secretKeyComment.test(contents),
      `${file} contains a minisign secret key comment`,
    );
  }
});

test("the signed build path exists and refuses a key it cannot vouch for", () => {
  assert.ok(exists("scripts/build-signed.ps1"), "scripts/build-signed.ps1 is the supported way to sign");

  const script = read("scripts/build-signed.ps1");
  // It has to actually compare the key against the committed pubkey, not just
  // find a key. A wrapper that signs with whatever it is handed produces
  // artifacts no client will install.
  assert.match(script, /minisign public key/);
  assert.match(script, /do not match/);
  // And it has to refuse a key that lives in the repository.
  assert.match(script, /is inside this repository/);
});