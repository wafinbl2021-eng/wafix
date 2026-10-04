// Guards the release identity and the updater signing setup.
//
// Wafi X is a separate product from PC Tweaker and is released independently:
// its own repository, its own signing key and its own artifact names.
// `plugins.updater.pubkey` is the only key the client will accept, and
// `productName`/`identifier`/`publisher` decide where Windows writes the app,
// its shortcut and its uninstaller entry. A drift in either is invisible in a
// build and only shows up on user machines, as an updater that silently never
// updates or an install that no longer replaces the previous version.
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

// The single place Wafi X releases live. PC Tweaker's repository is not a
// fallback: a feed served from there could offer artifacts this build's
// signing key cannot vouch for, and one served from a mirror could serve
// anything at all.
const WAFIX_REPO = "wafinbl2021-eng/wafix";

// The base64 blob of the Wafi X minisign public key compiled into every build.
//
// 2026-10-04 — ROTATED. The previous key id was E8F6107E4288E376 and its private
// key is not recoverable from this machine, so no future release could be signed
// with it. The key id is now E39359C78CAE9427. This is a reviewed edit, exactly
// the case the note above describes, and it is deliberately NOT silent: an
// install built against the old key will reject anything signed by the new one,
// so every shipped client must be on the new key before the next release goes
// out. The matching private key lives outside the repository.
const COMMITTED_PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEUzOTM1OUM3OENBRTk0MjcKUldRbmxLNk14MW1UNDZXalZmSWxxSFBHVURuNFBQcE9EOEh1S3Z1QWlYSEVBbmVXY3ppWnFuZ04K";

test("release identity is pinned", () => {
  assert.equal(conf.productName, "wafix");
  assert.equal(conf.identifier, "app.wafix.desktop");
  assert.equal(conf.bundle.publisher, "Wafi");
  assert.equal(
    conf.bundle.createUpdaterArtifacts,
    true,
    "signed updater artifacts are what the client verifies; turning this off would ship an unverifiable update",
  );
});

test("the updater key and feed are Wafi X's own", () => {
  assert.equal(
    conf.plugins.updater.pubkey,
    COMMITTED_PUBKEY,
    "plugins.updater.pubkey changed. Existing installs verify against the old key, so rotating it silently breaks every update until a deliberate migration.",
  );

  const decoded = Buffer.from(conf.plugins.updater.pubkey, "base64").toString("utf8");
  assert.match(decoded, /minisign public key: [0-9A-F]{16}/);

  // The key PC Tweaker shipped under belongs to that publisher and must never
  // be reused here: a release signed with it would be indistinguishable from
  // one coming out of the PC Tweaker repository.
  assert.doesNotMatch(
    decoded,
    /1A407762348632D2/,
    "this is PC Tweaker's published key id; Wafi X needs a key of its own",
  );

  const endpoints = conf.plugins.updater.endpoints;
  assert.ok(Array.isArray(endpoints) && endpoints.length > 0, "the updater needs a feed");
  assert.deepEqual(
    endpoints,
    [`https://github.com/${WAFIX_REPO}/releases/latest/download/latest.json`],
    `the updater must read exactly one feed, from Wafi X's own repository; found: ${JSON.stringify(endpoints)}`,
  );
  assert.ok(
    endpoints.every((url) => /^https:\/\//.test(url)),
    "updater endpoints must be HTTPS; the plugin will not verify an update fetched in the clear",
  );
});

test("update_identity.rs still pins the artifact names and host", () => {
  // Not a byte-for-byte pin: the file is free to be edited. What must not change
  // silently is the contract it enforces, because it is the check that stops an
  // old signed artifact being replayed as a newer version.
  const source = read("src-tauri/src/update_identity.rs");
  assert.match(source, /wafix_\{version\}_x64-setup\.exe/);
  assert.match(source, /wafix_\{version\}_x64_en-US\.msi/);
  assert.match(source, /github\.com/);
  assert.ok(
    source.includes(WAFIX_REPO),
    `update_identity.rs must pin Wafi X's repository (${WAFIX_REPO}); it points somewhere else`,
  );
  assert.ok(
    !/AurelioAvila\/pc-tweaker-app/.test(source),
    "update_identity.rs still accepts PC Tweaker artifacts; Wafi X must not install from that repository",
  );
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
  //
  // Anchored to the whole armored header rather than to the phrase alone. An
  // unanchored match also fires on scripts/build-signed.ps1, which has to name
  // that header in order to parse a key - so the test reported a committed
  // signing key where the only thing present was documentation of the format.
  // A pattern loose enough to read the documentation is loose enough to be
  // worthless on the real thing.
  const secretKeyComment = /^untrusted comment: minisign (encrypted )?secret key/m;

  // A check that can no longer fail is not a check. Confirm the pattern still
  // recognises both key shapes before trusting its silence over the tree.
  assert.ok(
    secretKeyComment.test("untrusted comment: minisign secret key\nRWQ=\n"),
    "the secret-key pattern no longer matches a plain minisign key",
  );
  assert.ok(
    secretKeyComment.test("untrusted comment: minisign encrypted secret key\nRWQ=\n"),
    "the secret-key pattern no longer matches an encrypted minisign key",
  );
  assert.ok(
    !secretKeyComment.test(read("scripts/build-signed.ps1")),
    "build-signed.ps1 documents the key header in order to parse one; it must not read as a key",
  );

  for (const file of tracked.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    let contents;
    try {
      contents = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      continue; // binary or unreadable; not a place a key would hide as text
    }
    assert.ok(
      !secretKeyComment.test(contents),
      `${file} contains a minisign secret key`,
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

test("the WinGet submission workflow stays deferred until a package exists", () => {
  const file = ".github/workflows/winget-publish.yml";
  assert.ok(exists(file), `${file} is kept, not deleted: the submission machinery is reusable`);

  const yaml = read(file);
  const active = yaml
    .split(/\r?\n/)
    // Strip comments so a re-enablement instruction that *mentions* a trigger
    // is not mistaken for one that *has* it. The header lists `release:
    // types: [released]` as a step to restore; that text must not read as
    // proof the workflow is live.
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");

  // 1. No event that a push or a release can fire. `release` used to be the
  //    trigger that submitted a manifest for every published version.
  assert.ok(
    !/^\s{2}(release|push|schedule|workflow_run):/m.test(active),
    "a release or push must not be able to start the WinGet workflow",
  );
  // 2. Manual dispatch survives so the file stays reversible, but it is inert.
  assert.match(active, /^\s{2}workflow_dispatch:/m, "workflow_dispatch is kept so the workflow can be re-enabled");

  // 3. Every job is gated off, so even a deliberate dispatch does nothing.
  //    Scoped to the `jobs:` block: at two-space indent `on:` also has keys
  //    (`workflow_dispatch:`), and counting those would compare a job against a
  //    trigger and pass or fail for no reason.
  const jobsBlock = active.slice(active.indexOf("\njobs:"));
  const gatedJobs = jobsBlock.match(/^\s{4}if: false\s*$/gm) ?? [];
  const jobNames = jobsBlock.match(/^  ([A-Za-z][\w-]*):$/gm) ?? [];
  assert.ok(jobNames.length > 0, "no jobs found - the guard below would pass on an empty block");
  assert.equal(
    gatedJobs.length,
    jobNames.length,
    `every job needs \`if: false\` (jobs: ${jobNames.length}, gated: ${gatedJobs.length})`,
  );

  // 4. No identifier may be invented. The one present is the previous
  //    product's, kept verbatim rather than replaced with a guess - a wrong
  //    identifier submits a manifest for somebody else's package.
  const identifiers = [...active.matchAll(/^\s*identifier:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(identifiers, ["AurelioAvila.PCTweaker"]);

  // The deferral has to be stated where a maintainer will read it before
  // pressing Run, not only in a changelog nobody opens. Matched on the
  // unambiguous sentence rather than the word "deferred": the word also occurs
  // in the workflow's own name and in a closing sentence about the verifier,
  // so a loose match here would still pass with the actual warning deleted.
  const header = yaml.split(/\r?\non:/)[0];
  assert.match(header, /THIS WORKFLOW IS DISABLED/, "the header must say the workflow is disabled");
  assert.match(yaml, /^name:.*DEFERRED/m, "the workflow name must say it is deferred");
  assert.match(yaml, /WINGET_TOKEN/, "the PAT gate is retained as a further layer");
});