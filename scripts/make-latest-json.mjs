/**
 * Builds the updater manifest (latest.json) for a GitHub release from the
 * locally built, signed NSIS bundle.
 *
 * Usage:  node scripts/make-latest-json.mjs <notes-file>
 *
 * Reads the version from src-tauri/tauri.conf.json, the signature from the
 * .exe.sig next to the setup bundle, and the release notes from the given
 * file (first paragraph). Requires valid publisher signatures, timestamps
 * and cryptographically verified updater signatures before writing output.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { verifyUpdater } from "./verify-updater.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const repoUrl = conf.plugins?.updater?.endpoints?.[0]?.match(/https:\/\/github\.com\/[^/]+\/[^/]+/)?.[0];
if (!repoUrl) {
  console.error("Could not derive the repo URL from the updater endpoint.");
  process.exit(1);
}

const nsisDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
const setups = fs.readdirSync(nsisDir).filter((f) => f.includes(`_${version}_`) && f.endsWith("_x64-setup.exe"));
if (setups.length !== 1) throw new Error("Expected exactly one current x64 setup.");
const setup = setups[0];
if (!setup) {
  console.error(`No v${version} -setup.exe found in ${nsisDir}. Run the signed build first.`);
  process.exit(1);
}
const sigPath = path.join(nsisDir, setup + ".sig");
if (!fs.existsSync(sigPath)) {
  console.error(`${setup} has no .sig — the build was NOT signed. Refusing to write latest.json.`);
  process.exit(1);
}

const notesFile = process.argv[2];
if (!notesFile) {
  console.error("Usage: node scripts/make-latest-json.mjs <notes-file>");
  process.exit(1);
}
// First paragraph of the notes file, flattened to one line.
const notes = fs
  .readFileSync(notesFile, "utf8")
  .split(/\n\s*\n/)
  .map((p) => p.replace(/^#.*$/gm, "").replace(/\s+/g, " ").trim())
  .filter(Boolean)[0];

// GitHub does not serve a release asset under the name it was uploaded
// with: every character outside [A-Za-z0-9.-_] becomes a dot, so
// "PC Tweaker Uninstaller_0.8.2_x64-setup.exe" is downloadable only as
// "PC.Tweaker.Uninstaller_0.8.2_x64-setup.exe". Percent-encoding the
// spaces instead produces a URL that 404s, which is how 0.8.0's winget
// manifest shipped pointing at an asset that was never there — and an
// updater manifest with a dead URL strands every install on the old
// version silently, since the check succeeds and the download does not.
const assetName = setup.replace(/[^A-Za-z0-9.\-_]/g, ".");
if (/[^A-Za-z0-9.\-_]/.test(assetName)) {
  console.error(`Asset name still holds characters GitHub will rewrite: ${assetName}`);
  process.exit(1);
}

const msiDir = path.join(root, "src-tauri", "target", "release", "bundle", "msi");
const msis = fs.readdirSync(msiDir).filter((file) => file.includes(`_${version}_`) && file.endsWith(".msi"));
if (msis.length !== 1) throw new Error("Expected exactly one current MSI installer.");
const releaseDir = path.join(root, "src-tauri", "target", "release");

/**
 * The application binary that actually ships, taken out of the MSI.
 *
 * Verifying `target/release/tauri-app.exe` looks right and is wrong. Tauri
 * patches that file with bundle-type information, signs it, packages it, and
 * then restores the pre-patch bytes when it is finished - so after a correct
 * signed build the leftover in `target/release` is unsigned while the copy
 * inside both installers is signed. This helper refused to write a manifest
 * for a perfectly good release, and the workaround was to copy the payload
 * back by hand before running it again. That is a manual step in the middle
 * of a signing procedure, which is exactly where manual steps get skipped.
 *
 * `msiexec /a` is an administrative install: it unpacks the MSI without
 * installing anything, needs no elevation, and yields the bytes that reach
 * the user. If it cannot run, fall back to the build output rather than
 * blocking a release - the installers themselves are still verified below,
 * and they are what is published.
 */
function shippedApplication(msiPath) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "pct-payload-"));
  try {
    execFileSync("msiexec", ["/a", msiPath, "/qn", `TARGETDIR=${staging}`], { stdio: "ignore" });
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.toLowerCase() === "tauri-app.exe") found.push(full);
      }
    };
    walk(staging);
    if (found.length !== 1) throw new Error(`expected one payload executable, found ${found.length}`);
    // Copied out before the staging directory goes away, and left in place:
    // the verification below reads it, and a human comparing hashes after the
    // fact needs it to still be there.
    const destination = path.join(releaseDir, "tauri-app.shipped.exe");
    fs.copyFileSync(found[0], destination);
    return destination;
  } catch (error) {
    console.warn(`Could not unpack the MSI payload (${error.message}); verifying the build output instead.`);
    return path.join(releaseDir, "tauri-app.exe");
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const shipped = shippedApplication(path.join(msiDir, msis[0]));
const binaries = [
  shipped,
  ...fs.readdirSync(releaseDir).filter((file) => file.endsWith(".dll")).map((file) => path.join(releaseDir, file)),
  path.join(nsisDir, setup),
  path.join(msiDir, msis[0]),
];
/**
 * The PowerShell host that runs `verify-authenticode.ps1`.
 *
 * This used to hardcode `pwsh`, which is PowerShell 7. Windows ships
 * PowerShell 5.1 under a different name and nothing else, so on a machine
 * without 7 installed the call died with a bare ENOENT - and it died *after*
 * the entire signed build had finished, at the very last step before the
 * manifest is written. That reads like a broken release script rather than a
 * missing optional tool, which is why it is worth resolving the host here
 * instead of hardcoding one.
 *
 * `verify-authenticode.ps1` uses nothing newer than 5.1, so the older host
 * runs it correctly and requiring the newer one buys nothing. The newest host
 * that actually *runs* wins, probed by executing it rather than by matching a
 * name, so a stale or broken shim on PATH cannot beat a working host further
 * down the list.
 *
 * `-ExecutionPolicy Bypass` is passed per-process, which is the only level
 * that leaves the machine alone. It is needed because `-File` is subject to
 * the execution policy while `-Command` is not: on a stock Windows the policy
 * for all three scopes is `Undefined` (i.e. `Restricted`), so the script was
 * refused with "running scripts is disabled on this system" even though the
 * host had been found correctly. Every other script here is invoked the same
 * way, so this matches the convention already documented in the repository.
 * The script it unblocks is read-only verification that never writes outside
 * a temp directory.
 */
function powershellHost() {
  const candidates = [
    "pwsh",
    "powershell.exe",
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    ),
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
        stdio: "ignore",
      });
      return candidate;
    } catch {
      // Not installed, or on PATH but not runnable. Try the next one.
    }
  }
  throw new Error(
    "No usable PowerShell host found. Install PowerShell 7 (`pwsh`), or make sure " +
      "Windows PowerShell 5.1 (`powershell.exe`) is reachable from PATH."
  );
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const hashes = new Map(binaries.map((file) => [file, sha256(file)]));
const powershell = powershellHost();
for (const binary of binaries) {
  execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(root, "scripts", "verify-authenticode.ps1"), "-Path", binary], { stdio: "inherit" });
}
const updaterSignature = verifyUpdater(path.join(nsisDir, setup), conf.plugins.updater.pubkey);
verifyUpdater(path.join(msiDir, msis[0]), conf.plugins.updater.pubkey);
const frontendEntry = fs.readFileSync(path.join(root, "dist", "index.html"), "utf8")
  .match(/src="\/assets\/([^" ]+\.js)"/)?.[1];
if (!frontendEntry || !fs.readFileSync(shipped).includes(Buffer.from(frontendEntry))) {
  throw new Error("Installer payload is missing the production frontend; rebuild with `tauri build`, not `cargo build`.");
}
for (const [file, hash] of hashes) {
  if (sha256(file) !== hash) throw new Error(`File changed during verification: ${file}`);
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "windows-x86_64": {
      signature: updaterSignature,
      url: `${repoUrl}/releases/download/v${version}/${assetName}`,
    },
  },
};

const out = path.join(nsisDir, "latest.json");
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`latest.json written for v${version}\n  bundle: ${setup}\n  out:    ${out}`);
