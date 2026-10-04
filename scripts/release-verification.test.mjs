import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyUpdater, removeVerificationDirectory } from "./verify-updater.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json")));

test("updater cleanup rejects the temporary root and unrelated directories", () => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  assert.throws(() => removeVerificationDirectory(temporaryRoot, temporaryRoot), /Unsafe/);
  assert.throws(() => removeVerificationDirectory(root, temporaryRoot), /Unsafe/);
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "pctweaker-verify-"));
  assert.throws(() => removeVerificationDirectory(directory, root), /Unsafe/);
  assert.ok(fs.existsSync(directory));
  removeVerificationDirectory(directory, temporaryRoot);
  assert.equal(fs.existsSync(directory), false);
});

test("missing and empty updater signatures fail closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pctweaker-verify-"));
  try {
    const file = path.join(dir, "setup.exe");
    fs.writeFileSync(file, "unsigned fixture");
    assert.throws(() => verifyUpdater(file, conf.plugins.updater.pubkey), /ENOENT/);
    fs.writeFileSync(file + ".sig", "");
    assert.throws(() => verifyUpdater(file, conf.plugins.updater.pubkey), /malformed/);
  } finally {
    removeVerificationDirectory(dir, fs.realpathSync(os.tmpdir()));
  }
});

// Daltoon X 1.0.0 is released without Authenticode, so a bundle with no
// publisher signature is no longer a reason to refuse a manifest — see
// ALLOW_UNSIGNED_AUTHENTICODE in make-latest-json.mjs and the "Authenticode:
// unsigned for 1.0.0" section of RELEASING.md.
//
// What this test actually protects has not changed, and is not negotiable: a
// bundle whose *updater* signature does not verify must never yield a manifest.
// The fixture below ships a `.sig` that is present but invalid, so the run now
// fails at the updater check instead of at the Authenticode check — the same
// refusal, reached through the gate that still applies. The assertions that a
// non-zero exit, no latest.json and no stable alias are written are the real
// property; only the reason string changed.
test(
  "a bundle with an invalid updater signature produces no manifest or stable alias",
  { skip: process.platform !== "win32" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pctweaker-verify-"));
    try {
      fs.cpSync(path.join(root, "scripts"), path.join(dir, "scripts"), { recursive: true });
      const release = path.join(dir, "src-tauri/target/release");
      const nsis = path.join(release, "bundle/nsis");
      const msi = path.join(release, "bundle/msi");
      fs.mkdirSync(nsis, { recursive: true });
      fs.mkdirSync(msi, { recursive: true });
      fs.writeFileSync(path.join(dir, "src-tauri/tauri.conf.json"), JSON.stringify(conf));
      fs.writeFileSync(path.join(dir, "notes.md"), "Verification fixture.");
      fs.writeFileSync(path.join(release, "tauri-app.exe"), "unsigned");
      fs.writeFileSync(path.join(nsis, `Test_${conf.version}_x64-setup.exe`), "unsigned");
      fs.writeFileSync(
        path.join(nsis, `Test_${conf.version}_x64-setup.exe.sig`),
        "present but invalid",
      );
      fs.writeFileSync(path.join(msi, `Test_${conf.version}_x64_en-US.msi`), "unsigned");
      const result = spawnSync(
        process.execPath,
        [path.join(dir, "scripts/make-latest-json.mjs"), path.join(dir, "notes.md")],
        { encoding: "utf8" },
      );
      const output = result.stdout + result.stderr;
      assert.notEqual(result.status, 0);
      // The updater signature is the gate that refuses this run, and naming it
      // here means relaxing it breaks this test rather than passing silently.
      assert.match(output, /Missing or malformed Tauri updater signature/);
      // The run must also be explicit that Authenticode was skipped rather
      // than satisfied, so a reader of the log is never told it was verified.
      assert.match(output, /AUTHENTICODE: NOT_SIGNED/);
      assert.doesNotMatch(output, /Authenticode verification (passed|ok)/i);
      assert.equal(fs.existsSync(path.join(nsis, "latest.json")), false);
      assert.equal(fs.existsSync(path.join(nsis, "WafiX-Setup.exe")), false);
    } finally {
      removeVerificationDirectory(dir, fs.realpathSync(os.tmpdir()));
    }
  },
);

test(
  "real updater signature verifies and changed bytes are rejected",
  { skip: !process.env.PCTWEAKER_TEST_ASSET },
  () => {
    const file = process.env.PCTWEAKER_TEST_ASSET;
    assert.ok(verifyUpdater(file, conf.plugins.updater.pubkey));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pctweaker-verify-"));
    try {
      const changed = path.join(dir, "changed.exe");
      fs.copyFileSync(file, changed);
      fs.copyFileSync(file + ".sig", changed + ".sig");
      fs.appendFileSync(changed, "modified");
      assert.throws(() => verifyUpdater(changed, conf.plugins.updater.pubkey));
    } finally {
      removeVerificationDirectory(dir, fs.realpathSync(os.tmpdir()));
    }
  },
);
