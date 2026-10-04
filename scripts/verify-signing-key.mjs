#!/usr/bin/env node
/**
 * Proves that a minisign/rsign detached signature was produced by the private
 * key whose public half is committed in src-tauri/tauri.conf.json.
 *
 * Why this exists instead of comparing key IDs: `tauri signer generate` writes
 * an *encrypted* rsign key, whose payload is a scrypt-encrypted blob. The key ID
 * is not in that file to be read, so the previous check - which sliced bytes
 * 64..71 out of the private key and compared them against the public key's ID -
 * could not run against a real encrypted key at all. It also only compared two
 * strings, which shows a resemblance rather than a relationship.
 *
 * This checks the relationship. Given the payload that was signed and the
 * signature that came back, it verifies the signature against the committed
 * public key, then verifies the global signature over the trusted comment. If
 * both hold, the signer held the private half of this exact key. That holds for
 * any key format and any encryption, which a fixed byte offset does not.
 *
 * The private key is never read here. Only its output is.
 *
 * Node's built-in Ed25519 and BLAKE2b do the work: no minisign CLI, no
 * third-party crypto dependency, nothing to install before a release can be
 * checked.
 *
 * Usage:
 *   node scripts/verify-signing-key.mjs --sig <file.sig> --payload <file>
 *                                      [--conf src-tauri/tauri.conf.json]
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SPKI DER prefix for an Ed25519 public key: SEQUENCE(0x2a) { SEQUENCE(0x05)
// { OID 1.3.101.112 } BIT STRING(0x03, 0x21) { 32 raw bytes }. The committed
// key is a bare 32-byte value and Node has no wrapper for that, so the 12-byte
// prefix is prepended here.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// The armored layouts. The line indices are the ones src-tauri/src/update_identity.rs
// uses when it reads the trusted comment (text.lines().nth(2) after unwrapping
// the base64), so this checks the same bytes the installed client will.
const UNTRUSTED_COMMENT = 0;
const SIGNATURE_PAYLOAD = 1;
const TRUSTED_COMMENT = 2;
const GLOBAL_SIGNATURE = 3;

// alg(2) | key_id(8) | signature(64), the tag naming which message is signed.
const SIGNATURE_BLOB_BYTES = 74;
// rsign writes the global signature as a bare Ed25519 signature, with no tag and
// no key ID - unlike the main signature, which is a tagged blob. Confirmed
// against output from `tauri signer sign` on tauri-cli 2.11.4.
const GLOBAL_SIGNATURE_BYTES = 64;
const PUBLIC_KEY_BLOB_BYTES = 42;

function fail(message) {
  console.error(`verify-signing-key: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) fail(`${flag} needs a value`);
    switch (flag) {
      case "--sig":
        options.sig = value;
        break;
      case "--payload":
        options.payload = value;
        break;
      case "--conf":
        options.conf = value;
        break;
      default:
        fail(`unknown argument ${flag}`);
    }
  }
  if (!options.sig || !options.payload) {
    fail("usage: --sig <file.sig> --payload <file> [--conf <tauri.conf.json>]");
  }
  return options;
}

/**
 * rsign wraps every blob it writes - the secret key, the public key and a
 * detached signature alike - as base64 of the armored text, rather than as the
 * armored text itself. `tauri signer sign` therefore emits a .sig file holding a
 * single base64 line. update_identity.rs unwraps it before reading the trusted
 * comment, and so does this, so what is checked here is what the client checks.
 */
function armoredText(raw, label) {
  const trimmed = raw.trim();
  const isOneLine = !trimmed.includes("\n") && !trimmed.includes("\r");
  if (isOneLine && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    let decoded;
    try {
      decoded = Buffer.from(trimmed, "base64").toString("utf8");
    } catch {
      return raw;
    }
    if (/^(untrusted|trusted) comment:/.test(decoded)) return decoded;
  }
  if (!/^(untrusted|trusted) comment:/.test(trimmed) && !raw.includes("\n")) {
    fail(`${label} is neither armored text nor base64 of it`);
  }
  return raw;
}

/** Non-empty lines of an armored blob, keeping their indexes relative to each other. */
function armoredLines(raw, label) {
  const lines = armoredText(raw, label)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) fail(`${label} has ${lines.length} line(s); a minisign blob needs at least two`);
  return lines;
}

function decodePayload(line, label, expectedBytes) {
  const trimmed = line.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) fail(`${label} payload is not base64`);
  const bytes = Buffer.from(trimmed, "base64");
  if (bytes.length !== expectedBytes) {
    fail(`${label} payload is ${bytes.length} bytes; expected ${expectedBytes}`);
  }
  return bytes;
}

/** `alg(2) | key_id(8) | ...`, with the key ID stored little-endian. */
function splitHeader(bytes, label) {
  // "Ed" signs the payload itself; "ED" signs a hash of it. Tauri emits "ED".
  const algorithm = Buffer.from(bytes.subarray(0, 2)).toString("latin1");
  if (algorithm !== "Ed" && algorithm !== "ED") {
    fail(`${label} carries unknown algorithm tag "${algorithm}"; only Ed25519 ("Ed"/"ED") is supported`);
  }
  const keyId = Buffer.from(bytes.subarray(2, 10)).reverse().toString("hex").toUpperCase();
  return { algorithm, keyId };
}

function ed25519Verify(rawPublicKey, message, signature) {
  const key = crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, rawPublicKey]),
    format: "der",
    type: "spki",
  });
  return crypto.verify(null, message, key, signature);
}

/**
 * The committed value is base64 of the armored public key, the same shape
 * `tauri signer generate` writes to disk.
 */
function readCommittedPublicKey(confPath) {
  let conf;
  try {
    conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
  } catch (error) {
    fail(`could not read ${confPath}: ${error.message}`);
  }
  const encoded = conf?.plugins?.updater?.pubkey;
  if (!encoded) fail(`${confPath} has no plugins.updater.pubkey`);

  let armored;
  try {
    armored = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    fail("plugins.updater.pubkey is not base64 of an armored public key");
  }
  // A key file saved on Windows can carry a UTF-8 BOM. Node's base64 decoder
  // skips the resulting invalid bytes silently, so the BOM reappears as U+FEFF at
  // the head of the decoded text and would fail the header match below.
  if (armored.charCodeAt(0) === 0xfeff) armored = armored.slice(1);

  const lines = armoredLines(armored, "the committed public key");
  const header = lines[UNTRUSTED_COMMENT];
  const advertised = header.match(/^untrusted comment: minisign public key: ([0-9A-Fa-f]{16})\s*$/);
  if (!advertised) {
    fail(`the committed public key does not carry a "minisign public key" header; found: ${header.slice(0, 60)}`);
  }

  const bytes = decodePayload(lines[SIGNATURE_PAYLOAD], "the committed public key", PUBLIC_KEY_BLOB_BYTES);
  const { keyId } = splitHeader(bytes, "the committed public key");
  if (advertised[1].toUpperCase() !== keyId) {
    fail(
      `the committed public key contradicts itself: header says ${advertised[1].toUpperCase()}, ` +
        `payload carries ${keyId}`,
    );
  }
  return { keyId, raw: bytes.subarray(10) };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const confPath = path.resolve(root, options.conf ?? "src-tauri/tauri.conf.json");

  let payload;
  try {
    payload = fs.readFileSync(options.payload);
  } catch (error) {
    fail(`could not read the signed payload ${options.payload}: ${error.message}`);
  }

  let signatureText;
  try {
    signatureText = fs.readFileSync(options.sig, "utf8");
  } catch (error) {
    fail(`could not read the signature ${options.sig}: ${error.message}. The signer did not produce one.`);
  }

  const committed = readCommittedPublicKey(confPath);
  const lines = armoredLines(signatureText, "the signature");
  if (lines.length !== 4) {
    fail(`the signature has ${lines.length} line(s); a detached minisign signature has exactly four`);
  }

  const mainBlob = decodePayload(lines[SIGNATURE_PAYLOAD], "the signature", SIGNATURE_BLOB_BYTES);
  const main = splitHeader(mainBlob, "the signature");
  const signature = mainBlob.subarray(10);
  const globalSignature = decodePayload(lines[GLOBAL_SIGNATURE], "the global signature", GLOBAL_SIGNATURE_BYTES);

  const comment = lines[TRUSTED_COMMENT];
  if (!comment.startsWith("trusted comment: ")) {
    fail(`line 3 of the signature is not a "trusted comment:" line; found: ${comment.slice(0, 60)}`);
  }
  const trustedComment = comment.slice("trusted comment: ".length);

  if (committed.keyId !== main.keyId) {
    fail(
      `key IDs do not match: committed public key ${committed.keyId}, signature ${main.keyId}. ` +
        "This signature was made by a different key than the one compiled into the app.",
    );
  }

  // The payload check is the one that matters: it is what says the signature
  // covers these exact bytes under this exact key. "ED" signs a BLAKE2b-512 hash
  // of the payload rather than the payload itself, which is what the Tauri
  // signer produces.
  const signedMessage =
    main.algorithm === "ED" ? crypto.createHash("blake2b512").update(payload).digest() : payload;
  if (!ed25519Verify(committed.raw, signedMessage, signature)) {
    fail("Ed25519 verification failed: the signature does not cover the payload under the committed public key.");
  }

  // The global signature is what stops a trusted comment being edited to point at
  // a different artifact, which is the check update_identity.rs leans on. It
  // covers the 64 signature bytes followed by the comment text.
  const globalMessage = Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]);
  if (!ed25519Verify(committed.raw, globalMessage, globalSignature)) {
    fail("the global signature does not cover the trusted comment under the committed public key.");
  }

  console.log(`  committed pubkey id  : ${committed.keyId}`);
  console.log(`  signature key id     : ${main.keyId}  (match)`);
  console.log(`  algorithm            : Ed25519, ${main.algorithm === "ED" ? "prehashed (BLAKE2b-512)" : "direct"}`);
  console.log(`  payload verified     : yes (${payload.length} bytes)`);
  console.log(`  global signature     : verified over the signature and the trusted comment`);
  console.log(`  trusted comment      : ${trustedComment.replace(/\t/g, " ")}`);
  console.log(`  result               : this key is the pair of plugins.updater.pubkey`);
}

main();