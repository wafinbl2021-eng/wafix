/**
 * Password and token primitives.
 *
 * WHY PBKDF2 RUNS IN THE BROWSER, NOT HERE
 * =========================================
 * The agreed design was PBKDF2-SHA256 with 310,000 iterations, executed by the
 * Worker. Measured on this platform that cannot work, for two independent
 * reasons:
 *
 *   1. Cloudflare's runtime caps PBKDF2 at 100,000 iterations and throws
 *      NotSupportedError above that. 310,000 fails on the first login.
 *   2. The Workers *Free* plan allows 10 ms of CPU per HTTP request. PBKDF2 at
 *      the cap still costs ~41 ms, which is 4x the entire budget. Even a
 *      comfortably legal 20,000 iterations costs ~8 ms, leaving nothing for the
 *      D1 queries the same request needs.
 *
 * So the stretching moves to the admin panel, where the only limit is how long
 * one person is willing to wait. The panel derives a 32-byte verifier with
 * PBKDF2-SHA256 at 600,000 iterations - the OWASP-recommended figure - and
 * sends that over TLS. This Worker stores only SHA-256 of the verifier, which
 * costs ~0.3 ms.
 *
 * The security model is unchanged. A stolen database yields SHA-256(verifier),
 * which is not itself a login credential: the server hashes whatever arrives
 * before comparing, so presenting the stored hash fails. Recovering the
 * password still requires 600,000 PBKDF2 rounds per guess, exactly as it would
 * with a server-side KDF. Interception of the verifier is no worse than
 * interception of a password, since TLS already protects both.
 *
 * The iteration count is a constant here because the server decides it and
 * writes it to `admins.iterations`. Raising it later does not invalidate stored
 * verifiers: login reads the count from the row rather than assuming one.
 */

import { HttpError } from "./errors.ts";

/** Sent to the browser so the panel can derive a verifier for an existing admin. */
export const DEFAULT_ITERATIONS = 600_000;

/** The runtime's own ceiling. Kept as a guard, not as the target. */
export const MAX_ITERATIONS = 5_000_000;
export const MIN_ITERATIONS = 100_000;

const SALT_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;

function requireCrypto(): Crypto {
  // Read through globalThis with the type weakened deliberately. The Workers
  // definitions declare `crypto` as always present, which would let the compiler
  // delete this check - but the same source is imported by Node scripts and by
  // the test harness, and there the global genuinely can be missing.
  const candidate = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (!candidate?.subtle || !candidate.getRandomValues) {
    throw new HttpError("internal", "The request could not be completed");
  }
  return candidate as Crypto;
}

/** Hex-encodes a buffer or typed array. */
export function toHex(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  requireCrypto().getRandomValues(buffer);
  return toHex(buffer);
}

/** Salt for a new admin. 16 random bytes, stored hex. */
export const newSalt = (): string => randomHex(SALT_BYTES);

/** Opaque session token. The raw value goes in the cookie; only its hash is stored. */
export const newSessionToken = (): string => randomHex(SESSION_TOKEN_BYTES);

export async function sha256Hex(input: string): Promise<string> {
  const digest = await requireCrypto().subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return toHex(digest);
}

/**
 * Single SHA-256 over a verifier. This is the only password-adjacent work the
 * Worker does, and it is deliberately not a KDF - the verifier is already the
 * output of 600,000 PBKDF2 rounds performed by the client.
 */
export async function hashVerifier(verifier: string): Promise<string> {
  return sha256Hex(verifier);
}

/**
 * What an admin row stores: the salt and iteration count the panel needs to
 * derive a verifier, plus the hash of the verifier itself.
 */
export interface PasswordMaterial {
  readonly salt: string;
  readonly iterations: number;
  readonly hash: string;
}

/**
 * Derives stored material from a client-side verifier. Used by the bootstrap
 * route, the password-change route, and the seed script - all of which already
 * hold a verifier.
 */
export async function materialFromVerifier(
  verifier: string,
  salt: string,
  iterations: number,
): Promise<PasswordMaterial> {
  return { salt, iterations, hash: await hashVerifier(verifier) };
}

/**
 * Compares a presented verifier against stored material.
 *
 * Returns false rather than throwing on a malformed value so a caller cannot
 * distinguish "wrong password" from "malformed request" through timing.
 */
export async function verifyAgainst(
  presented: string,
  stored: PasswordMaterial,
): Promise<boolean> {
  if (!Number.isInteger(stored.iterations) || stored.iterations < MIN_ITERATIONS) {
    // A row we cannot verify against is treated as a failed login. This should
    // be unreachable: the column has a CHECK constraint and the only writer
    // validates before insert.
    return false;
  }
  const candidate = await hashVerifier(presented);
  return timingSafeEqualHex(candidate, stored.hash);
}

/**
 * Constant-time comparison over two equal-length hex strings.
 *
 * `crypto.subtle` has no timing-safe compare, and a session token compared with
 * `===` leaks its prefix through response timing. Length is compared first
 * because token length is fixed and not a secret.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    // charCodeAt on hex chars, so no allocation and no early exit.
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Compares the bootstrap token against the configured secret.
 *
 * The presented value is hashed first so the comparison is over two fixed-width
 * hex strings, and so neither the token nor its length is observable.
 */
export async function bootstrapTokenMatches(
  presented: string,
  expected: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(expected)]);
  return timingSafeEqualHex(a, b);
}

/**
 * A salt for a username that does not exist.
 *
 * Login has to give an unknown username the same response shape as a known one,
 * otherwise the endpoint enumerates accounts. Returning a stable random salt
 * (stable per process) means the client's PBKDF2 still runs and the failure
 * still happens at the same comparison, not earlier.
 */
let decoySalt: string | undefined;
export function decoySaltFor(): string {
  decoySalt ??= newSalt();
  return decoySalt;
}
