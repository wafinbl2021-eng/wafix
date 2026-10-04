/**
 * Wafi X Pro entitlement signing.
 *
 * WHAT THIS FILE IS
 * =================
 *
 * The one place that can produce a signed Pro entitlement. It is deliberately
 * small and deliberately separate from `crypto.ts`: that file handles passwords
 * and session tokens, this one handles the asymmetric key whose *public* half is
 * embedded in the desktop app. A compromise of a password hash must never
 * implicate the entitlement key, and keeping them in separate files makes that
 * boundary reviewable rather than merely intended.
 *
 * THE SIGNATURE ALGORITHM WAS CHOSEN EMPIRICALLY, NOT ASSUMED
 * ===========================================================
 *
 * "Cloudflare Workers supports Ed25519" is a claim, and getting it wrong means
 * the signer throws in production while every Node test passes - Node has had
 * Ed25519 for years and proves nothing about workerd. So it was measured against
 * a real local `workerd` process before any of this was written: WebCrypto
 * `generateKey({ name: "Ed25519" })`, sign and verify all work, signatures are 64
 * bytes, a tampered message is rejected, and a PKCS#8 built by hand around a raw
 * 32-byte seed imports and signs correctly while an unrelated public key rejects
 * the result.
 *
 * That is why this uses `crypto.subtle` rather than a vendored Ed25519
 * implementation: no new dependency, no `nodejs_compat` compatibility flag, and
 * no hand-written curve arithmetic to get wrong.
 *
 * WHY `payloadJson` IS BUILT AS A STRING
 * ======================================
 *
 * The signature is over bytes, and the client verifies those bytes. If this file
 * built an object, serialised it twice, or returned a re-serialised copy, the
 * string the client verified would not be the string that was signed and every
 * entitlement would fail with a signature error. So there is exactly one
 * serialisation, it is written out here by hand, and that same string is both
 * signed and returned.
 *
 * The field names must match `LicensePayload` in `src-tauri/src/license.rs`
 * exactly, camelCase included. `test/license.test.ts` asserts the same constant
 * appears in both files, so a rename on one side alone fails the suite instead of
 * failing at runtime for every user.
 *
 * WHAT IS NOT HERE, AND WHY
 * =========================
 *
 * No machine id, no device id, no install id, no hostname, no IP, no user agent,
 * no telemetry. An entitlement is bound to a *Wafi X account* and to nothing else,
 * so it survives a reinstall, a new machine, and a new network - which is what
 * someone who paid for a lifetime licence expects. There is nothing in this
 * Worker that could collect such an identifier even if a later change wanted to.
 */

import type { Env } from "./env.ts";

/**
 * The product a Wafi X entitlement is for.
 *
 * A constant rather than configuration, deliberately. The desktop app hard-codes
 * the same value in `src-tauri/src/license.rs`, and making this one settable
 * would only create a way for a deployment to sign entitlements the app will
 * refuse - a failure that looks exactly like an attack. One place to change on
 * each side, and a test that compares them.
 */
export const LICENSE_PRODUCT_ID = "wafix";

/**
 * RFC 8410 section 9.1: a v1 Ed25519 PKCS#8 is a fixed 16-byte header followed
 * by the 32-byte seed.
 *
 * The secret is stored as the bare seed rather than as a full PKCS#8, because 32
 * bytes is the smallest thing that can be a key, and there is no second valid
 * encoding to get wrong when the file and the environment value are the same
 * bytes. Workerd accepts the wrapped form directly - see the header's note on the
 * probe that established it.
 */
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const SEED_BYTES = 32;

/** What `/api/license` returns. The bytes come from [`signEntitlement`]. */
export interface SignedEntitlement {
  readonly payloadJson: string;
  readonly signature: string;
}

/** The entitlement fields, as signed. Field order here is the wire order. */
export interface Entitlement {
  readonly accountId: string;
  readonly isPro: boolean;
  /** `"pro"`, `"lifetime"`, or null when the account holds no live grant. */
  readonly plan: string | null;
  /** Unix seconds, or null for a grant with no end. */
  readonly expiresAt: number | null;
}

/**
 * Imported signing keys, cached per secret.
 *
 * `importKey` is not free and the Workers CPU budget is per request, so doing it
 * on every entitlement would spend the budget on setup. The cache is keyed by the
 * secret itself, which means a key is held only as long as the isolate is, and a
 * rotated secret produces a second entry rather than reusing the first.
 *
 * A failed import is deliberately *not* cached: an unset secret is a
 * misconfiguration an operator will fix and redeploy, and a permanently negative
 * cache entry would turn that into a failure that survives the fix.
 */
const imported = new Map<string, Promise<CryptoKey>>();

function requireCrypto(): Crypto {
  // Read through globalThis with the type weakened deliberately, for the same
  // reason `crypto.ts` does it: the Workers definitions declare `crypto` as
  // always present, which would let the compiler delete this check - but this
  // module is also loaded by the Node test harness, where the global can be
  // missing and where a silent undefined would be a much worse failure than a
  // loud one.
  const present = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (present?.subtle === undefined) {
    throw new Error("WebCrypto is unavailable; Wafi X entitlements cannot be signed");
  }
  return present as Crypto;
}

function decodeBase64(value: string, what: string): Uint8Array {
  const compact = value.trim();
  if (compact === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error(`${what} is not base64`);
  }
  const binary = atob(compact);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Chunked so a very long input cannot blow the argument limit of `apply`.
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Wraps a raw 32-byte seed in a PKCS#8 container.
 *
 * The seed is copied rather than referenced, so the wrapper cannot be mutated
 * afterwards by anything holding a view of the decoded secret.
 */
function pkcs8FromSeed(seed: Uint8Array): Uint8Array {
  const out = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  out.set(PKCS8_ED25519_PREFIX, 0);
  out.set(seed, PKCS8_ED25519_PREFIX.length);
  return out;
}

function signingKey(secretB64: string): Promise<CryptoKey> {
  const existing = imported.get(secretB64);
  if (existing !== undefined) return existing;

  const pending = (async () => {
    const seed = decodeBase64(secretB64, "LICENSE_SIGNING_KEY_B64");
    if (seed.length !== SEED_BYTES) {
      // Said plainly rather than caught later as an opaque import error: the
      // mistake is a truncated paste or a PKCS#8 pasted where a seed was asked
      // for, and naming it saves an operator an afternoon.
      throw new Error(
        `LICENSE_SIGNING_KEY_B64 must be a base64 32-byte Ed25519 seed, got ${seed.length} bytes`,
      );
    }
    return requireCrypto().subtle.importKey(
      "pkcs8",
      pkcs8FromSeed(seed),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
  })();

  imported.set(secretB64, pending);
  pending.catch(() => imported.delete(secretB64));
  return pending;
}

/**
 * Escapes a string for JSON.
 *
 * Hand-rolled because every field that reaches here is either a UUID from our own
 * database, a value already constrained by a CHECK, or a number - none of which
 * can contain a quote. The escapes are still there so that a widening of any of
 * those inputs cannot turn into an injection into the bytes we are about to sign.
 */
function jsonString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"') out += '\\"';
    else if (character === "\\") out += "\\\\";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += character;
  }
  return `${out}"`;
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Signs an entitlement for one account.
 *
 * The returned `payloadJson` is the exact byte string the signature covers, and
 * the caller must return it verbatim. Re-serialising it would produce different
 * bytes - different key order, possibly different escaping - and the client's
 * signature check would fail for every user rather than for one.
 *
 * `expiresAt` is the grant's own cutoff, and null for a grant that has none. The
 * client also applies its own offline grace window, so an entitlement stops
 * working even if it is never refreshed; the two limits are independent on
 * purpose, and neither is derived from the other.
 */
export async function signEntitlement(
  env: Env,
  entitlement: Entitlement,
): Promise<SignedEntitlement> {
  // A blank or absurd account id must never reach the signing step. An
  // entitlement for an account nobody can name is not an entitlement, and
  // signing one would produce a payload the client would have to accept.
  const accountId = entitlement.accountId.trim();
  if (accountId === "" || accountId.length > 128) {
    throw new Error("an entitlement must name exactly one account");
  }
  if (entitlement.isPro && entitlement.plan === null) {
    // The desktop app gates four features on `plan === "lifetime"` and treats a
    // Pro entitlement with no plan as malformed, so signing one would hand out
    // something the client will not act on.
    throw new Error("a Pro entitlement must carry a plan");
  }

  const secret = env.LICENSE_SIGNING_KEY_B64;
  if (secret === undefined || secret.trim() === "") {
    // Not a silent success and not a silent Pro denial: an operator who has not
    // set the secret needs to see that they have not, in the Worker log, rather
    // than discover it as an app that quietly never unlocks anything.
    throw new Error(
      "LICENSE_SIGNING_KEY_B64 is not set; Wafi X Pro entitlements cannot be signed",
    );
  }

  const issuedAt = unixSeconds();
  const payloadJson = [
    "{",
    `"userId":${jsonString(accountId)},`,
    `"isPro":${entitlement.isPro ? "true" : "false"},`,
    `"plan":${entitlement.plan === null ? "null" : jsonString(entitlement.plan)},`,
    `"product":${jsonString(LICENSE_PRODUCT_ID)},`,
    `"issuedAt":${issuedAt},`,
    `"expiresAt":${entitlement.expiresAt ?? "null"}`,
    "}",
  ].join("");

  const key = await signingKey(secret.trim());
  const signature = await requireCrypto().subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(payloadJson),
  );

  return { payloadJson, signature: toBase64(signature) };
}

/** Test seam: drops cached key material. */
export function forgetSigningKeys(): void {
  imported.clear();
}
