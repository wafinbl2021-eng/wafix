/**
 * TEST-ONLY Ed25519 key pair for the licence route.
 *
 * THIS IS NOT A SECRET AND MUST NEVER BE ONE.
 *
 * The seed below is committed on purpose, so the signing path can be exercised
 * end to end - real SQL, real WebCrypto, real signatures - without any real
 * credential existing anywhere. The matching public key is embedded in
 * `src-tauri/src/license.rs` as `PUBLIC_KEY_B64` and is NOT derived from this
 * seed, which is the property that makes the fixture harmless: a signature made
 * here is rejected by every shipped build, by construction, forever.
 *
 * The real private seed lives at `C:\Users\Wafi\.wafix\license.key`, outside the
 * repository, and reaches the Worker as the secret `LICENSE_SIGNING_KEY_B64`.
 * Nothing in this repository holds it, and nothing in this file may ever point at
 * it.
 *
 * `test/license.test.ts` asserts that the key in `license.rs` is not this one,
 * so swapping this fixture for the production seed - the one mistake that would
 * make the fixture no longer harmless - fails the suite.
 */

/**
 * A 32-byte Ed25519 seed. Fixed, so a failure is reproducible. The ASCII text it
 * decodes to is `wafix-entitlement-fixture-seed!!` - readable on purpose, so a
 * reader who finds this file in a commit immediately knows what they are looking
 * at rather than having to trust the name.
 */
export const FIXTURE_SEED_B64 = "d2FmaXgtZW50aXRsZW1lbnQtZml4dHVyZS1zZWVkISE=";

/** The public half, for verifying a signature this fixture produced. */
export const FIXTURE_PUBLIC_B64 = "lwq15+bkH3c2TwqVCNa3A74xd0caq7qtIkpmh9pdfSQ=";

/**
 * RFC 8410 section 9.1. Duplicated from `src/license-signing.ts` rather than
 * imported, so a change to the production prefix cannot silently make the tests
 * agree with a broken signer.
 */
export const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * RFC 8410 section 9.2, the SubjectPublicKeyInfo wrapper around a raw Ed25519
 * key: a 12-byte header followed by the 32 key bytes.
 *
 * Hand-rolled rather than `.concat`, which does not exist on `Uint8Array` - a
 * surprising amount of "the tests pass" rests on never calling it.
 */
const SPKI_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Wraps the fixture seed the same way the signer does. */
export function fixturePkcs8(): Uint8Array {
  return concatBytes(PKCS8_ED25519_PREFIX, fromBase64(FIXTURE_SEED_B64));
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function fixtureKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    fixturePkcs8(),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

/** Verifies a signature over `payloadJson` against the fixture public key. */
export async function verifyWithFixture(
  payloadJson: string,
  signatureB64: string,
): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    "spki",
    concatBytes(SPKI_ED25519_PREFIX, fromBase64(FIXTURE_PUBLIC_B64)),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    fromBase64(signatureB64),
    new TextEncoder().encode(payloadJson),
  );
}

/**
 * Signs arbitrary bytes with the fixture key, for negative tests that need a
 * payload this fixture produced but the signer never would.
 */
export async function signWithFixture(message: string): Promise<string> {
  const key = await fixtureKey();
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(message),
  );
  return toBase64(signature);
}
