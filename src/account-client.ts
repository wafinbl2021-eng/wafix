/**
 * The Daltoon X account client.
 *
 * Every call here goes through `invoke` to Rust. There is no `fetch`, no
 * `XMLHttpRequest`, and no `https://api.pctweaker.app` anywhere in this file or
 * the rest of `src/`. The transport lives in `src-tauri/src/account.rs` because
 * the session is a `SameSite=Strict` cookie and a Tauri webview is on a
 * different site from the API - a cookie the browser would store and then never
 * send back. Rust is not a browser, so it replays the cookie itself.
 *
 * WHAT THE FRONTEND DOES NOT HAVE
 * ===============================
 *
 * No session token. Not in localStorage, not in sessionStorage, not in a
 * variable, not in a returned object. The token exists in exactly one place: a
 * DPAPI-encrypted file under the app's data directory, which this process
 * cannot read. That is strictly stronger than the requirement that it not be
 * stored in web storage - the frontend does not hold it at all.
 *
 * No signed licence. `account_license` returns two fields - whether the account
 * is Pro, and which plan - and Rust has already verified the Ed25519 signature,
 * the product, the account binding and the expiry by the time this sees anything.
 * There is no command that takes a licence *from* the webview, so there is no IPC
 * path by which a crafted payload reaches the enforcement code.
 *
 * No account id. It is needed on the Rust side to bind an entitlement to an
 * account, and it stays there: `AccountView` has no such field.
 *
 * No JWT, no `Authorization: Bearer`, no machine id, no device id, no hostname,
 * no install id, no telemetry, no polling, no heartbeat. `restoreSession` is
 * called once per launch.
 */

import { invoke } from "@tauri-apps/api/core";

/** What `/api/account/me` is allowed to tell us about the signed-in account. */
export interface AccountView {
  email: string;
  /** ISO timestamp of the previous sign-in, or null on the first one. */
  last_login_at: string | null;
  /** Remaining session lifetime. Not a countdown timer; just a number. */
  expires_in_seconds: number;
}

/**
 * What the frontend is told about the Pro entitlement.
 *
 * Two fields, both already decided in Rust. `plan` is absent when the account is
 * not Pro, and is one of `"pro"` or `"lifetime"` when it is - an unrecognised
 * plan never reaches this layer, because `plan_of` fails closed on the far side.
 */
export interface LicenseView {
  is_pro: boolean;
  plan?: "pro" | "lifetime";
}

/**
 * Why an account call failed.
 *
 * A distinct kind rather than only a message, so the UI can decide what to
 * *show*. `not_signed_in` is an ordinary state and gets no error banner at all;
 * `unreachable` is the one that must not be mistaken for a sign-out.
 */
export type AccountErrorKind = "not_signed_in" | "rate_limited" | "unreachable" | "server";

export interface AccountError {
  kind: AccountErrorKind;
  message: string;
  /** Present for `rate_limited`: how long the API asked us to wait. */
  retry_after_seconds?: number;
}

/** What every Rust account command returns. */
export interface MeOutcome {
  signed_in: boolean;
  account?: AccountView;
  /** Set only when the call *failed*. "Not signed in" has no error. */
  error?: AccountError;
}

/** One shape for all three of "signed in", "signed out", and "cannot tell". */
export type SessionState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; account: AccountView }
  /**
   * The account could not be established, and the previous state - if any - is
   * preserved so a failed refresh does not sign someone out. `previous` is
   * absent only when there was nothing to keep.
   */
  | { status: "error"; error: AccountError; previous?: AccountView };

/**
 * The API's address rule, reproduced exactly.
 *
 * `readEmail` in `wafx-api/src/routes/account-auth.ts:122` is the authority. An
 * earlier version of this file required a dot in the domain, which the server
 * does not: `a@example` is a legal address there, and a client that refuses it
 * leaves the user with no way to tell which of the two was wrong. Everything
 * below mirrors that function — one `@`, a local part of 1..64 that does not
 * start or end with a dot, a domain of 1..189 that does not start or end with a
 * hyphen, no whitespace and no `..` — plus the `min: 3, max: 254` the validator
 * applies before any of it.
 */
function addressProblem(address: string): string | null {
  const at = address.indexOf("@");
  const local = at < 0 ? "" : address.slice(0, at);
  const domain = at < 0 ? "" : address.slice(at + 1);
  const malformed =
    at < 0 ||
    at !== address.lastIndexOf("@") ||
    local.length < 1 ||
    local.length > 64 ||
    domain.length < 1 ||
    domain.length > 189 ||
    /\s/.test(address) ||
    address.includes("..") ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    domain.startsWith("-") ||
    domain.endsWith("-");
  if (address.length < 3 || address.length > 254) return "emailInvalid";
  return malformed ? "emailInvalid" : null;
}

/**
 * The most validation this side can do.
 *
 * Deliberately not a strength check. The API never sees a password — only a
 * stretched verifier — so it cannot judge one, and neither can this. The server's
 * own answers are used as-is.
 */
export function validateCredentials(email: string, password: string): string | null {
  const address = email.trim();
  if (!address) return "emailRequired";
  const problem = addressProblem(address);
  if (problem) return problem;
  if (!password) return "passwordRequired";
  // Matches the length the admin panel asks for. It is a floor, not a promise.
  if (password.length < 8) return "passwordTooShort";
  return null;
}

/** Registration additionally requires the two passwords to agree. */
export function validateRegistration(
  email: string,
  password: string,
  confirm: string,
): string | null {
  const base = validateCredentials(email, password);
  if (base) return base;
  if (password !== confirm) return "passwordMismatch";
  return null;
}

/** Narrows an untyped `invoke` result. */
function asMe(value: unknown): MeOutcome {
  if (typeof value !== "object" || value === null) {
    throw new Error("the account service returned nothing usable");
  }
  const candidate = value as Partial<MeOutcome>;
  if (typeof candidate.signed_in !== "boolean") {
    throw new Error("the account service returned an unexpected shape");
  }
  return {
    signed_in: candidate.signed_in,
    account: candidate.account,
    error: candidate.error,
  };
}

/**
 * Narrows an untyped licence result.
 *
 * `is_pro` must be an actual boolean and `plan` must be one of the two plans
 * this build understands. Anything else is treated as "not Pro" rather than
 * passed on: this is the last point where a strange value from the other side
 * could become UI state, and a badge is not worth a wrong `true`.
 */
function asLicense(value: unknown): LicenseView {
  if (typeof value !== "object" || value === null) {
    return { is_pro: false };
  }
  const candidate = value as Partial<LicenseView>;
  if (candidate.is_pro !== true) return { is_pro: false };
  return candidate.plan === "pro" || candidate.plan === "lifetime"
    ? { is_pro: true, plan: candidate.plan }
    : { is_pro: true };
}

function asError(value: unknown): AccountError {
  if (typeof value !== "object" || value === null) {
    return { kind: "server", message: "The sign-in service replied oddly." };
  }
  const candidate = value as Partial<AccountError>;
  return {
    kind: candidate.kind ?? "server",
    message: candidate.message ?? "The sign-in service had a problem. Try again.",
    retry_after_seconds: candidate.retry_after_seconds,
  };
}

/**
 * Turns a rejected `invoke` into a structured failure.
 *
 * A command that returns `MeOutcome` should not reject - but a panic, a closed
 * IPC channel or a serialisation failure would, and each of those is "the
 * service could not be reached" as far as the UI is concerned.
 */
function asTransportFailure(reason: unknown): AccountError {
  return {
    kind: "unreachable",
    message:
      reason instanceof Error && reason.message
        ? reason.message
        : "Could not reach the sign-in service. Check your connection.",
  };
}

/**
 * Who am I, if anyone?
 *
 * Called once on launch. Returns a full `SessionState` rather than throwing:
 * every caller wants the same three answers, and modelling "signed out" as an
 * error would make the expected state of a fresh launch look like a fault.
 */
export async function restoreSession(): Promise<SessionState> {
  try {
    const outcome = asMe(await invoke("account_me"));
    if (outcome.signed_in && outcome.account) {
      return { status: "signed-in", account: outcome.account };
    }
    if (outcome.error) return { status: "error", error: asError(outcome.error) };
    return { status: "signed-out" };
  } catch (reason) {
    return { status: "error", error: asTransportFailure(reason) };
  }
}

/**
 * Asks Rust for a fresh signed entitlement.
 *
 * The request, the signature check and the cache write all happen in Rust. This
 * is a request for the *conclusion*, not for the evidence.
 *
 * Throws when the check could not be completed, rather than returning
 * `{ is_pro: false }`. Those are different facts: the first is "not Pro", the
 * second is "we could not find out", and collapsing them would let one dropped
 * connection silently demote a paying customer. Callers keep whatever they
 * already knew when this rejects.
 */
export async function fetchLicense(): Promise<LicenseView> {
  try {
    return asLicense(await invoke("account_license"));
  } catch (reason) {
    if (typeof reason === "object" && reason !== null && "kind" in reason) {
      const error = asError(reason);
      const wrapped = new Error(error.message) as Error & { kind?: string };
      wrapped.kind = typeof error.kind === "string" ? error.kind : "server";
      throw wrapped;
    }
    throw asTransportFailure(reason);
  }
}

/**
 * Creates an account.
 *
 * The API answers every outcome the same way and issues no session, so there is
 * nothing to return but a possible error. It deliberately never says whether the
 * address was already registered, and neither may this layer - that is the whole
 * point of the design, and a client that "helpfully" reported a difference would
 * put the enumeration channel back.
 */
export async function register(email: string, password: string): Promise<void> {
  try {
    await invoke("account_register", { email: email.trim(), password });
  } catch (reason) {
    // A structured `AccountError` comes back as an object; anything else is a
    // transport problem. Both are surfaced, neither is guessed at.
    throw typeof reason === "object" && reason !== null && "kind" in reason
      ? asError(reason)
      : asTransportFailure(reason);
  }
}

/** Signs in and reports who that turned out to be. */
export async function login(email: string, password: string): Promise<SessionState> {
  try {
    const outcome = asMe(await invoke("account_login", { email: email.trim(), password }));
    if (outcome.signed_in && outcome.account) {
      return { status: "signed-in", account: outcome.account };
    }
    if (outcome.error) return { status: "error", error: asError(outcome.error) };
    return { status: "signed-out" };
  } catch (reason) {
    return { status: "error", error: asTransportFailure(reason) };
  }
}

/**
 * Signs this device out.
 *
 * Never throws. The local cookie is removed by Rust whether or not the server
 * answered, so the user is signed out either way - and a sign-out button that
 * can fail, or that needs an error message, is worse than one that cannot.
 */
export async function logout(): Promise<void> {
  try {
    await invoke("account_logout");
  } catch {
    // Nothing to do. Rust has already removed the cookie it would have replayed.
  }
}
