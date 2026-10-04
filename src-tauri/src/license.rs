//! Verifies the server-signed Pro entitlement before a Pro tweak runs.
//!
//! ## Why this exists
//!
//! `apply_tweak` used to trust the `requires_pro` flag baked into the
//! compiled tweak list with nothing checking it against the account that is
//! actually running the app. That made "is this allowed" a question the
//! client answered entirely on its own — on the user's own machine, running
//! code the user's own machine executes. A public MIT history made this a
//! standing invitation (see the license change this replaces); closing the
//! MIT grant does nothing for the *current*, officially signed binary, where
//! this is the actual gap.
//!
//! ## How it works
//!
//! The API signs `{ userId, isPro, plan, product, issuedAt, expiresAt }` with an
//! Ed25519 key it alone holds (`wafx-api/src/license-signing.ts`) and returns the
//! exact JSON string it signed alongside the signature — never a re-serialized
//! copy. This module verifies that signature against the embedded public key,
//! parses the payload only once the signature is confirmed, and treats it as
//! valid for a short grace period from `issued_at`.
//!
//! Three further conditions must hold before any of that counts, and all three
//! are checked here rather than anywhere the user can reach:
//!
//!   - **Product.** `product` must be exactly `wafix`, and it is a *required*
//!     field. There is no "field absent, assume the best" fallback, because a
//!     missing field is indistinguishable from one an attacker stripped - and
//!     stripping it would otherwise widen, never narrow, what is accepted.
//!   - **Account.** The payload must name the account that is signed in *right
//!     now* on this install. That is the whole point of issuing entitlements
//!     from the account store rather than from a purchase receipt.
//!   - **Freshness.** `issued_at` must be inside the grace window and inside
//!     any signed `expires_at`.
//!
//! ## What this deliberately does not bind to
//!
//! There is no machine id, hardware id, install id, device fingerprint, hostname
//! or IP in this module, and none may be added. Pro follows the account, so a
//! user who signs in on a new machine is Pro there too, and the entitlement
//! travels with the account rather than being welded to one box. Anything that
//! reintroduced device binding would also reintroduce the "why does my licence
//! stop working" support burden that Wafi X 1.0.0 has no way to answer.
//!
//! The app fetches and caches an entitlement after sign-in and periodically
//! thereafter; while offline, the last valid cache keeps working until it ages
//! out. Revocation therefore is not instant — it is bounded by the grace period
//! and by how long the app was closed — which is a deliberate, stated trade,
//! not an oversight.
//!
//! ## What this does not stop
//!
//! It does not stop someone from forking the source, deleting this check,
//! and building their own private copy — no client-side check can, since the
//! code enforcing it would run on a machine they fully control. What it does
//! stop is the far more common case: the officially distributed, signed
//! binary being driven directly (devtools, a patched IPC call, a future
//! regression of the kind that shipped in 0.4.1) to run a Pro tweak without
//! ever having paid for it.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Public half of a key pair dedicated to Wafi X Pro licence signing — separate
/// from the Tauri updater's signing key, so a compromise of one never implicates
/// the other. Safe to embed: it is only useful for *verifying* signatures,
/// never for producing them.
///
/// The private half lives outside the repository, in the deployment secret
/// `LICENSE_SIGNING_KEY_B64`, and has never been in it.
const PUBLIC_KEY_B64: &str = "4jUlZ5JNP319el/bpOx9qHcS2zbhBhFFM7dSee3TPqc=";

/// A signed entitlement is valid only for the product that requested it.
/// Keeping this check in the Rust enforcement path prevents an entitlement
/// for another ecosystem app from unlocking Wafi X.
///
/// A constant rather than a build setting: a deployment that could sign a
/// different `product` would produce entitlements this app rejects, and every
/// such rejection would look exactly like an attack rather than a misconfiguration.
///
/// `pub(crate)` so the lifetime tools can name it in a test fixture, which keeps
/// that test honest: it must change if this constant does.
pub(crate) const PRODUCT_ID: &str = "wafix";

/// How long a signed license is trusted without a fresh fetch. Long enough
/// to cover a weekend or a short trip without connectivity; short enough
/// that a cancelled subscription doesn't keep working offline indefinitely.
const GRACE_PERIOD_SECS: u64 = 3 * 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECS: u64 = 5 * 60;

/// Field names must match `wafx-api/src/license-signing.ts`'s hand-built JSON
/// exactly, camelCase included — this is parsed directly from the JSON string
/// the server signed, not adapted at any boundary in between.
///
/// `product` is deliberately **not** `Option` and carries no `#[serde(default)]`:
/// a payload without one fails to deserialise, which is the answer we want. The
/// previous format made a missing product mean "assume Wafi X", so an attacker
/// who could strip one field gained nothing — but a future field with a
/// different meaning would, and the ambiguity is not worth carrying.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LicensePayload {
    pub user_id: String,
    pub is_pro: bool,
    pub plan: Option<String>,
    pub product: String,
    /// Unix seconds, set by the server at signing time. Freshness is
    /// measured from this, not from local receipt — a cached-and-replayed
    /// response can't be made to look newer than it actually is.
    pub issued_at: u64,
    /// The signed paid-period cutoff, or null for a perpetual grant. Taken from
    /// the server's grant row, so a client cannot talk its way past one.
    #[serde(default)]
    pub expires_at: Option<u64>,
}

/// What the server sends: the exact bytes it signed, plus the signature over
/// those exact bytes. `payload_json` is verified as opaque bytes first and
/// parsed only afterward — see the module docs on why this file never
/// re-serializes a payload to check a signature against it.
/// Also camelCase to match `res.json()`'s literal output from
/// `routes/license.ts` — this struct is deserialized straight from the
/// HTTP response body, not from anything Tauri's IPC layer touches.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SignedLicenseResponse {
    pub payload_json: String,
    pub signature: String,
}

#[derive(Debug, PartialEq)]
pub enum VerifyError {
    BadPublicKey,
    BadSignatureEncoding,
    SignatureInvalid,
    UnparsablePayload,
    WrongProduct,
    /// The payload was signed by us, for us, and is internally consistent — but
    /// it names a different account than the one signed in on this install.
    /// Distinct from `WrongProduct` so a support answer can tell "you sent us
    /// someone else's licence" from "you sent us another app's licence".
    WrongAccount,
}

/// Verifies `signature` (base64) against `payload_json`'s raw UTF-8 bytes and
/// returns the parsed payload only if it checks out. This is the only path
/// by which a `LicensePayload` should ever come into existence in this
/// process — there is no constructor that skips verification.
pub fn verify(payload_json: &str, signature_b64: &str) -> Result<LicensePayload, VerifyError> {
    verify_with_public_key(payload_json, signature_b64, PUBLIC_KEY_B64)
}

fn verify_with_public_key(
    payload_json: &str,
    signature_b64: &str,
    public_key_b64: &str,
) -> Result<LicensePayload, VerifyError> {
    let key_bytes: [u8; 32] = STANDARD
        .decode(public_key_b64)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(VerifyError::BadPublicKey)?;
    let verifying_key =
        VerifyingKey::from_bytes(&key_bytes).map_err(|_| VerifyError::BadPublicKey)?;

    let sig_bytes: [u8; 64] = STANDARD
        .decode(signature_b64)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(VerifyError::BadSignatureEncoding)?;
    let signature = Signature::from_bytes(&sig_bytes);

    verifying_key
        .verify(payload_json.as_bytes(), &signature)
        .map_err(|_| VerifyError::SignatureInvalid)?;

    serde_json::from_str(payload_json).map_err(|_| VerifyError::UnparsablePayload)
}

fn verify_for_wafix(
    payload_json: &str,
    signature_b64: &str,
    expected_account: Option<&str>,
) -> Result<LicensePayload, VerifyError> {
    require_wafix_product(verify(payload_json, signature_b64)?, expected_account)
}

fn verified_fresh_response(
    response: &SignedLicenseResponse,
    public_key_b64: &str,
    expected_account: Option<&str>,
) -> Option<LicensePayload> {
    let verified =
        verify_with_public_key(&response.payload_json, &response.signature, public_key_b64).ok()?;
    let payload = require_wafix_product(verified, expected_account).ok()?;
    is_fresh(&payload).then_some(payload)
}

/// The product and account gates, in that order, once the signature has already
/// checked out. Both return `WrongProduct`/`WrongAccount` rather than a bool so
/// a caller cannot accidentally treat "unknown" as "fine".
fn require_wafix_product(
    payload: LicensePayload,
    expected_account: Option<&str>,
) -> Result<LicensePayload, VerifyError> {
    if !is_for_wafix(&payload) {
        return Err(VerifyError::WrongProduct);
    }
    if let Some(account_id) = expected_account {
        if !is_for_account(&payload, account_id) {
            return Err(VerifyError::WrongAccount);
        }
    }
    Ok(payload)
}

fn is_for_wafix(payload: &LicensePayload) -> bool {
    payload.product == PRODUCT_ID
}

/// Constant-time-ish comparison is not claimed and not needed here: the account
/// id is not a secret, and what is being defended is a *signature*, which has
/// already been checked before this runs.
fn is_for_account(payload: &LicensePayload, account_id: &str) -> bool {
    !account_id.is_empty() && payload.user_id == account_id
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A payload that has passed signature verification *and* is still inside
/// its grace period. This distinction matters: a validly signed license from
/// three weeks ago proves the server said something true three weeks ago,
/// not that it is still true now.
fn is_fresh(payload: &LicensePayload) -> bool {
    // Once the process is running, moving the wall clock backwards must not
    // extend the offline window. A persisted, device-bound clock anchor is a
    // separate license-format migration; this does not claim to prevent an
    // administrator from tampering with time across restarts.
    static ANCHOR: OnceLock<(u64, Instant)> = OnceLock::new();
    let wall_now = now_secs();
    let (anchor_time, anchor_tick) = ANCHOR.get_or_init(|| (wall_now, Instant::now()));
    let effective_now = wall_now.max(anchor_time.saturating_add(anchor_tick.elapsed().as_secs()));
    is_fresh_at(payload, effective_now)
}

fn is_fresh_at(payload: &LicensePayload, now: u64) -> bool {
    payload.issued_at > 0
        && payload.issued_at <= now.saturating_add(MAX_CLOCK_SKEW_SECS)
        && now.saturating_sub(payload.issued_at) <= GRACE_PERIOD_SECS
        && payload.expires_at.is_none_or(|expiry| now < expiry)
}

/// Persists the raw, still-signed response to the app data directory so it
/// survives a restart. Written via temp-file-then-rename, matching
/// `rollback.rs`'s pattern, so an interrupted write can never leave a
/// half-written (and therefore unparsable, therefore Pro-denying) file
/// behind.
///
/// The store keeps the app data directory rather than a single path so it can
/// resolve *who is signed in* at the moment of the check. That resolution is not
/// an optimisation: `require_pro` is called from a tweak the user is running, long
/// after the fetch, and the question it must answer is "is the account that paid
/// still the account signed in on this install".
pub struct LicenseStore {
    app_data_dir: PathBuf,
    file_path: PathBuf,
    /// Always `PUBLIC_KEY_B64` outside tests.
    ///
    /// A field rather than a bare constant purely so a unit test can drive the
    /// *accepted* path: the real private key is not in this repository and never
    /// will be, so without a seam the only behaviour testable here is "everything
    /// is refused", which is also what a completely broken verifier would do.
    /// There is exactly one production constructor, and it hard-codes the key —
    /// so widening what a shipped build trusts is not a thing a caller can do.
    public_key_b64: &'static str,
}

impl LicenseStore {
    pub fn new(app_data_dir: PathBuf) -> Self {
        LicenseStore {
            file_path: app_data_dir.join("license.json"),
            app_data_dir,
            public_key_b64: PUBLIC_KEY_B64,
        }
    }

    /// Test-only: a store that trusts `public_key_b64` instead of the shipped
    /// key, so the accepting path can be tested without the production secret.
    #[cfg(test)]
    fn trusting(app_data_dir: PathBuf, public_key_b64: &'static str) -> Self {
        LicenseStore {
            public_key_b64,
            ..LicenseStore::new(app_data_dir)
        }
    }

    pub fn save(&self, response: &SignedLicenseResponse) -> std::io::Result<()> {
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(response).unwrap();
        let tmp = self
            .file_path
            .with_extension(format!("json.{}.tmp", std::process::id()));
        std::fs::write(&tmp, json)?;
        let result = std::fs::rename(&tmp, &self.file_path);
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }

    fn load(&self) -> Option<SignedLicenseResponse> {
        let text = std::fs::read_to_string(&self.file_path).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Removes the cached license, if any. Used on logout so a still-fresh
    /// Pro cache from one account can't keep granting Pro tweaks to whoever
    /// signs in next on the same machine. Missing-file is success, not an
    /// error — there is nothing to clear either way.
    pub fn delete(&self) -> std::io::Result<()> {
        match std::fs::remove_file(&self.file_path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// The account this install is signed in as, read at check time.
    fn signed_in_account(&self) -> Option<String> {
        crate::account::load_account_id(&self.app_data_dir)
    }

    /// The one question this whole module exists to answer: is Pro currently
    /// verified and still fresh? Every failure mode — no cached license, a
    /// corrupt file, a bad signature, an expired grace period, a license for
    /// another account, or a license that was validly signed but says
    /// `is_pro: false` — collapses to the same `false`, on purpose. There is no
    /// partial-credit path here.
    ///
    /// Signed out means not-Pro, including when a perfectly fresh Pro cache is
    /// still on disk. That is deliberate: an entitlement belongs to an account,
    /// and with nobody signed in there is no account to own it.
    pub fn is_pro_and_fresh(&self) -> bool {
        self.verified_fresh_payload()
            .is_some_and(|payload| payload.is_pro)
    }

    /// Native feature gates may inspect the plan only after this accessor
    /// verifies the signature, the product, the account binding, and the existing
    /// offline window. A plan supplied by the renderer never participates in
    /// entitlement.
    pub fn verified_fresh_payload(&self) -> Option<LicensePayload> {
        let account = self.signed_in_account()?;
        verified_fresh_response(&self.load()?, self.public_key_b64, Some(&account))
    }
}

/// What the frontend is told about the entitlement, and nothing more.
///
/// No `user_id`, no `product`, no `issued_at`, no signature, no payload: the
/// frontend needs to know whether to show the Pro badge, and every other field is
/// either a secret-adjacent detail or a value it has no way to check. Anything
/// that wants the real payload is a Rust caller behind the signature check.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct LicenseView {
    pub is_pro: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<&'static str>,
}

/// Why a licence refresh did not produce one.
///
/// Deliberately coarse. A caller in the webview gets to choose between "not Pro"
/// and "check failed"; it does not get to distinguish a bad signature from a
/// network error and try something cleverer with the answer.
#[derive(Debug, Clone, Serialize)]
pub struct LicenseError {
    pub kind: &'static str,
    pub message: String,
}

fn license_error(kind: &'static str, message: impl Into<String>) -> LicenseError {
    LicenseError {
        kind,
        message: message.into(),
    }
}

/// Fetches a fresh signed entitlement, verifies it, caches it, and reports it.
///
/// A separate command from `/me` for three reasons, all of which would be lost by
/// folding it in:
///
///   - `/me` stays a cheap "who am I" that the UI can call on every mount and on
///     every focus without dragging a signature check and a signed body along.
///   - The fetch happens **here**, in Rust, using the session cookie the webview
///     cannot see. The frontend never holds a signed response it could replay, and
///     there is no IPC command that accepts an entitlement *from* the renderer -
///     which is what `save_license` used to be, and why it is gone.
///
/// Failure returns an error rather than a negative `is_pro`. A fetch that failed
/// is not evidence that Pro was withdrawn, and saying so would let one dropped
/// connection silently demote a paying customer.
#[tauri::command(async)]
pub async fn account_license(app: tauri::AppHandle) -> Result<LicenseView, LicenseError> {
    let dir = crate::store_for_dir(&app).map_err(|e| license_error("server", e))?;
    let store = LicenseStore::new(dir.clone());

    // Read before the request, and read again after it: signing out in another
    // window mid-fetch must not produce a licence bound to a stale account.
    let Some(account_id) = crate::account::load_account_id(&dir) else {
        return Err(license_error("not_signed_in", "Sign in to check your Pro status."));
    };

    let base = crate::account::api_base();
    let cookie = crate::account::load_session(&dir);
    if cookie.is_none() {
        return Err(license_error("not_signed_in", "Sign in to check your Pro status."));
    }

    match crate::account::call(
        &base,
        cookie.as_deref(),
        reqwest::Method::GET,
        "/api/license",
        None,
    )
    .await
    {
        crate::account::Reply::Refused(error) => Err(license_error(error.kind, error.message)),
        crate::account::Reply::Done { body, .. } => {
            let response: SignedLicenseResponse = serde_json::from_str(&body).map_err(|e| {
                license_error("server", format!("the licence reply did not parse: {e}"))
            })?;

            let payload =
                verify_for_wafix(&response.payload_json, &response.signature, Some(&account_id))
                    .map_err(|e| {
                        license_error("invalid", format!("the licence did not verify: {e:?}"))
                    })?;
            if !is_fresh(&payload) {
                return Err(license_error(
                    "invalid",
                    "the licence is expired or its issue time is ahead of this PC's clock",
                ));
            }

            // Re-check after the round trip, so the cache is only written while
            // the same account is still the signed-in one.
            if crate::account::load_account_id(&dir).as_deref() != Some(account_id.as_str()) {
                return Err(license_error(
                    "not_signed_in",
                    "the account changed while the licence was being fetched",
                ));
            }
            store
                .save(&response)
                .map_err(|e| license_error("server", e.to_string()))?;

            Ok(LicenseView {
                is_pro: payload.is_pro,
                plan: plan_of(&payload),
            })
        }
    }
}

/// Maps a verified plan onto the fixed set of strings the rest of the app knows.
///
/// Anything unexpected - a plan this build has never heard of - becomes `None`
/// rather than passing through. A native feature gate compares against a literal,
/// so an unknown string fails closed on its own; returning it would only risk a
/// future `match` arm somewhere treating it as new and trustworthy.
fn plan_of(payload: &LicensePayload) -> Option<&'static str> {
    match payload.plan.as_deref() {
        Some("pro") => Some("pro"),
        Some("lifetime") => Some("lifetime"),
        _ => None,
    }
}

/// Read-only status for the UI: whether a verified, still-fresh Pro license
/// is cached right now. Never the source of truth `apply_tweak` itself
/// relies on — that re-verifies independently on every call — this is only
/// for showing the user something accurate in the account panel.
#[tauri::command]
pub fn license_status(app: tauri::AppHandle) -> Result<bool, String> {
    let store = LicenseStore::new(crate::store_for_dir(&app)?);
    Ok(store.is_pro_and_fresh())
}

/// Called on logout. Without this, a still-fresh cached Pro license would
/// keep granting Pro tweaks for up to the grace period to whoever signs in
/// next on the same machine — including an anonymous session, or a second
/// account that never paid for anything.
#[tauri::command]
pub fn clear_license(app: tauri::AppHandle) -> Result<(), String> {
    LicenseStore::new(crate::store_for_dir(&app)?)
        .delete()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::path::PathBuf;

    /// A signed-in account to bind to, for the store tests.
    const SIGNED_IN: &str = "11111111-2222-3333-4444-555555555555";
    const OTHER_ACCOUNT: &str = "99999999-8888-7777-6666-555555555555";

    /// The key pair the *tests* sign with. Never the shipped one: the whole
    /// point is that a signature this module produces is rejected by the code
    /// that ships, which `the_store_refuses_a_fixture_signature` asserts.
    const TEST_SEED: [u8; 32] = [7_u8; 32];

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wafix-license-test-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn payload_for(account: &str) -> LicensePayload {
        LicensePayload {
            user_id: account.into(),
            is_pro: true,
            plan: Some("pro".into()),
            product: PRODUCT_ID.into(),
            issued_at: now_secs(),
            expires_at: None,
        }
    }

    /// Signs `payload` with the test key, returning the exact bytes signed, the
    /// signature, and the matching public key.
    fn sign(payload: &LicensePayload) -> (String, String, String) {
        let key = SigningKey::from_bytes(&TEST_SEED);
        let payload_json = serde_json::to_string(payload).unwrap();
        let signature = key.sign(payload_json.as_bytes());
        (
            payload_json,
            STANDARD.encode(signature.to_bytes()),
            STANDARD.encode(key.verifying_key().to_bytes()),
        )
    }

    fn signed_response(payload: &LicensePayload) -> (SignedLicenseResponse, String) {
        let (payload_json, signature, public_key) = sign(payload);
        (
            SignedLicenseResponse {
                payload_json,
                signature,
            },
            public_key,
        )
    }

    /// A store with an account signed in, trusting the shipped key. Used where
    /// the answer must be `false`, which is the only thing that key can produce
    /// for a fixture-signed payload.
    fn store_signed_in_as(tag: &str, account: &str) -> LicenseStore {
        let dir = temp_dir(tag);
        crate::account::save_account_id(&dir, Some(account));
        LicenseStore::new(dir)
    }

    /// A store with an account signed in that trusts the test key, so the
    /// accepting path is reachable at all. Everything else about it - the
    /// account binding, freshness, the file format - is the production code.
    fn store_trusting_fixture(tag: &str, account: &str) -> (LicenseStore, String) {
        let dir = temp_dir(tag);
        crate::account::save_account_id(&dir, Some(account));
        let public_key =
            STANDARD.encode(SigningKey::from_bytes(&TEST_SEED).verifying_key().to_bytes());
        let store = LicenseStore::trusting(dir, Box::leak(public_key.clone().into_boxed_str()));
        (store, public_key)
    }

    // -----------------------------------------------------------------
    // The embedded identity
    // -----------------------------------------------------------------

    #[test]
    fn the_product_is_wafix() {
        assert_eq!(PRODUCT_ID, "wafix");
    }

    #[test]
    fn the_embedded_key_is_wafix_s_own_and_nobody_else_s() {
        // The key this app trusts, spelled out. Changing it is a one-line diff
        // that would silently reject every real entitlement, so it is pinned here
        // and cross-checked against the same value on the API side.
        assert_eq!(PUBLIC_KEY_B64, "4jUlZ5JNP319el/bpOx9qHcS2zbhBhFFM7dSee3TPqc=");

        let decoded = STANDARD.decode(PUBLIC_KEY_B64).expect("must be base64");
        assert_eq!(decoded.len(), 32, "an Ed25519 public key is 32 raw bytes");
        VerifyingKey::from_bytes(&decoded.try_into().unwrap()).expect("must be a curve point");

        // The committed test fixture, and the PC Tweaker key this replaced. Both
        // must be gone rather than merely unused: an unused key in a binary is
        // a key somebody will enable again.
        assert_ne!(
            PUBLIC_KEY_B64,
            "lwq15+bkH3c2TwqVCNa3A74xd0caq7qtIkpmh9pdfSQ=",
            "the shipped key must never be the committed test fixture"
        );
        assert_ne!(
            PUBLIC_KEY_B64,
            "QisYr46g3mqEeiz1BDyEcPbRO1xO4z0lR3d5/ODppIU=",
            "the previous PC Tweaker licence key must not still be embedded"
        );
    }

    /// The source with comments removed.
    ///
    /// A hand-rolled stripper, which is enough here and honestly documents its
    /// own limit: it would mis-read a `//` inside a string literal. This file has
    /// none, and the alternative - a guard that fires on this module's own prose
    /// about machine binding - is a guard that gets deleted the first time that
    /// prose is written.
    fn code_without_comments() -> String {
        let source = include_str!("license.rs");
        let body = source
            .split_once("#[cfg(test)]")
            .map_or(source, |(head, _)| head);
        let mut out = String::with_capacity(body.len());
        let mut chars = body.chars().peekable();
        let mut in_string = false;
        while let Some(c) = chars.next() {
            match c {
                '/' if !in_string && chars.peek() == Some(&'/') => {
                    for next in chars.by_ref() {
                        if next == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                }
                '/' if !in_string && chars.peek() == Some(&'*') => {
                    chars.next();
                    let mut previous = '\0';
                    for next in chars.by_ref() {
                        if previous == '*' && next == '/' {
                            break;
                        }
                        previous = next;
                    }
                    out.push(' ');
                }
                '"' => {
                    in_string = !in_string;
                    out.push(c);
                }
                other => out.push(other),
            }
        }
        out
    }

    #[test]
    fn nothing_in_this_module_binds_an_entitlement_to_a_machine() {
        // Pro follows the account. A machine id, hardware id, install id or
        // fingerprint would make a licence stop working on a new machine, and
        // would put a stable hardware identifier into the entitlement format -
        // which is a much larger privacy decision than "check a signature".
        let code = code_without_comments().to_lowercase();
        for needle in [
            "hwid",
            "machineguid",
            "getcomputername",
            "machine_id",
            "machineid",
            "device_id",
            "deviceid",
            "install_id",
            "installid",
            "hostname",
            "user_agent",
            "useragent",
            "uuid::",
            "wmic",
            "registry",
        ] {
            assert!(
                !code.contains(needle),
                "`{needle}` must not appear in the enforcement path"
            );
        }
    }

    // -----------------------------------------------------------------
    // Product and account binding
    // -----------------------------------------------------------------

    #[test]
    fn a_payload_without_a_product_is_rejected_rather_than_assumed() {
        // The previous format treated a missing product as "assume Wafi X". That
        // is gone: a field that is absent is a field somebody can strip, and the
        // only safe reading of an unsigned-by-our-schema claim is to refuse.
        let raw = r#"{"userId":"1","isPro":true,"plan":"pro","issuedAt":1,"expiresAt":null}"#;
        let err = serde_json::from_str::<LicensePayload>(raw)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("missing field `product`"),
            "the failure must name the field that was absent, got: {err}"
        );

        let (payload_json, signature, public_key) = {
            let key = SigningKey::from_bytes(&TEST_SEED);
            let signature = key.sign(raw.as_bytes());
            (
                raw.to_string(),
                STANDARD.encode(signature.to_bytes()),
                STANDARD.encode(key.verifying_key().to_bytes()),
            )
        };
        // Validly signed by a key we trust, and still refused.
        assert_eq!(
            verify_with_public_key(&payload_json, &signature, &public_key),
            Err(VerifyError::UnparsablePayload)
        );
        assert_eq!(
            verified_fresh_response(
                &SignedLicenseResponse {
                    payload_json,
                    signature
                },
                &public_key,
                Some(SIGNED_IN),
            ),
            None
        );
    }

    #[test]
    fn a_pc_tweaker_entitlement_cannot_unlock_wafix() {
        for product in ["pctweaker", "PC Tweaker", "wafix ", ""] {
            let mut payload = payload_for(SIGNED_IN);
            payload.product = product.into();
            let (json, signature, public_key) = sign(&payload);
            let verified = verify_with_public_key(&json, &signature, &public_key).unwrap();
            assert_eq!(
                require_wafix_product(verified, Some(SIGNED_IN)),
                Err(VerifyError::WrongProduct),
                "`{product}` must not unlock Wafi X"
            );
        }
    }

    #[test]
    fn another_products_valid_payload_cannot_unlock_wafix() {
        let mut payload = payload_for(SIGNED_IN);
        payload.plan = Some("lifetime".into());
        payload.product = "uninstaller".into();
        let (json, signature, public_key) = sign(&payload);
        let verified = verify_with_public_key(&json, &signature, &public_key).unwrap();
        assert_eq!(
            require_wafix_product(verified, Some(SIGNED_IN)),
            Err(VerifyError::WrongProduct)
        );
    }

    #[test]
    fn a_payload_naming_another_account_is_refused() {
        let (json, signature, public_key) = sign(&payload_for(OTHER_ACCOUNT));
        let verified = verify_with_public_key(&json, &signature, &public_key).unwrap();
        assert_eq!(
            require_wafix_product(verified, Some(SIGNED_IN)),
            Err(VerifyError::WrongAccount)
        );
    }

    #[test]
    fn an_empty_expected_account_matches_nothing() {
        // `Some("")` would otherwise be a wildcard if anyone ever passed an
        // empty string, so the emptiness check is part of the comparison rather
        // than something the caller has to remember.
        let (json, signature, public_key) = sign(&payload_for(""));
        let verified = verify_with_public_key(&json, &signature, &public_key).unwrap();
        assert_eq!(
            require_wafix_product(verified, Some("")),
            Err(VerifyError::WrongAccount)
        );
    }

    #[test]
    fn product_is_checked_before_the_account() {
        // Both wrong: reporting which one failed first is a small information leak
        // about what a given entitlement contains, and the order is pinned so it
        // stays deliberate rather than accidental.
        let mut payload = payload_for(OTHER_ACCOUNT);
        payload.product = "pctweaker".into();
        let (json, signature, public_key) = sign(&payload);
        let verified = verify_with_public_key(&json, &signature, &public_key).unwrap();
        assert_eq!(
            require_wafix_product(verified, Some(SIGNED_IN)),
            Err(VerifyError::WrongProduct)
        );
    }

    #[test]
    fn the_plan_view_only_names_plans_this_build_understands() {
        for (plan, expected) in [
            (Some("pro"), Some("pro")),
            (Some("lifetime"), Some("lifetime")),
            // A plan from a future build must not be echoed to the UI, where some
            // later `match` might treat it as something it recognises.
            (Some("monthly"), None),
            (Some("enterprise"), None),
            (Some(""), None),
            (None, None),
        ] {
            let mut payload = payload_for(SIGNED_IN);
            payload.plan = plan.map(str::to_string);
            assert_eq!(plan_of(&payload), expected, "plan {plan:?}");
        }
    }

    // -----------------------------------------------------------------
    // The store's account binding
    // -----------------------------------------------------------------

    #[test]
    fn a_cached_licence_only_counts_while_its_own_account_is_signed_in() {
        let (store, _) = store_trusting_fixture("own-account", SIGNED_IN);
        let (response, _) = signed_response(&payload_for(SIGNED_IN));
        store.save(&response).unwrap();
        assert!(store.is_pro_and_fresh(), "precondition: a live Pro cache");

        // The same bytes on disk, a different account now signed in.
        crate::account::save_account_id(&store.app_data_dir, Some(OTHER_ACCOUNT));
        assert_eq!(
            store.verified_fresh_payload(),
            None,
            "a cached Pro licence must not follow a different account onto this install"
        );
        assert!(!store.is_pro_and_fresh());
    }

    #[test]
    fn a_signed_out_install_is_not_pro_however_fresh_the_cache_is() {
        let (store, _) = store_trusting_fixture("signed-out", SIGNED_IN);
        let (response, _) = signed_response(&payload_for(SIGNED_IN));
        store.save(&response).unwrap();
        assert!(store.is_pro_and_fresh(), "precondition: a live Pro cache");

        crate::account::save_account_id(&store.app_data_dir, None);
        assert!(!store.is_pro_and_fresh());
        assert_eq!(store.verified_fresh_payload(), None);
    }

    #[test]
    fn a_fixture_signed_cache_never_counts() {
        // The signature is valid Ed25519 from a key the test controls and the
        // shipped verifier rejects. This is the property that makes the committed
        // fixture key harmless: nothing it can sign is ever accepted.
        let store = store_signed_in_as("fixture", SIGNED_IN);
        let (response, _) = signed_response(&payload_for(SIGNED_IN));
        store.save(&response).unwrap();
        assert!(store.load().is_some(), "precondition: bytes are cached");
        assert!(!store.is_pro_and_fresh());
        assert_eq!(store.verified_fresh_payload(), None);
    }

    #[test]
    fn a_signed_not_pro_entitlement_is_a_verified_not_pro() {
        // Different from "nothing cached". The server said "not Pro" and signed
        // it; the app must believe that rather than falling back to the cache it
        // just replaced.
        let (store, _) = store_trusting_fixture("signed-false", SIGNED_IN);
        let mut payload = payload_for(SIGNED_IN);
        payload.is_pro = false;
        payload.plan = None;
        let (response, _) = signed_response(&payload);
        store.save(&response).unwrap();
        assert!(!store.is_pro_and_fresh());
        assert!(store.verified_fresh_payload().is_some());
    }

    // -----------------------------------------------------------------
    // Signature verification
    // -----------------------------------------------------------------

    #[test]
    fn a_wafix_payload_verifies_and_round_trips_through_the_store() {
        let store = store_signed_in_as("round-trip", SIGNED_IN);
        let payload = payload_for(SIGNED_IN);
        let (response, public_key) = signed_response(&payload);
        assert_eq!(
            verify_with_public_key(&response.payload_json, &response.signature, &public_key),
            Ok(payload.clone())
        );
        // Re-serialising is what must not happen: the app verifies the exact
        // bytes the server signed, which is why `deny_unknown_fields` and the
        // field order above are part of the contract.
        store.save(&response).unwrap();
        assert_eq!(store.load().unwrap().payload_json, response.payload_json);
        // A different signature over the *production* key still does not verify.
        assert_eq!(
            verify(&response.payload_json, &response.signature),
            Err(VerifyError::SignatureInvalid)
        );
    }

    #[test]
    fn a_single_flipped_byte_in_the_payload_is_rejected() {
        let payload = payload_for(SIGNED_IN);
        let (response, _) = signed_response(&payload);
        let tampered = response
            .payload_json
            .replace("\"isPro\":true", "\"isPro\":false");
        assert_ne!(
            tampered, response.payload_json,
            "the replace must actually have changed something"
        );
        assert_eq!(
            verify_with_public_key(&tampered, &response.signature, PUBLIC_KEY_B64),
            Err(VerifyError::SignatureInvalid)
        );
        assert_eq!(
            verify(&tampered, &response.signature),
            Err(VerifyError::SignatureInvalid)
        );
    }

    #[test]
    fn a_signature_from_a_different_key_is_rejected() {
        let (response, _) = signed_response(&payload_for(SIGNED_IN));
        // A syntactically valid but wrong signature (right length, wrong bytes).
        let mut bogus = STANDARD.decode(&response.signature).unwrap();
        bogus[0] ^= 0xFF;
        assert_eq!(
            verify(&response.payload_json, &STANDARD.encode(bogus)),
            Err(VerifyError::SignatureInvalid)
        );
        // And one of the wrong length, which must fail before any curve maths.
        assert_eq!(
            verify(&response.payload_json, "AAAA"),
            Err(VerifyError::BadSignatureEncoding)
        );
    }

    #[test]
    fn an_unparsable_public_key_is_refused_rather_than_panicking() {
        let (json, signature, _) = sign(&payload_for(SIGNED_IN));
        for bad in ["not base64!", "", "AAAA"] {
            assert_eq!(
                verify_with_public_key(&json, &signature, bad),
                Err(VerifyError::BadPublicKey),
                "`{bad}` must not be usable as a key"
            );
        }
    }

    #[test]
    fn an_unknown_field_makes_a_payload_unparsable() {
        // The wire format is a closed contract, not a bag of fields. A future
        // server adding one should fail loudly here rather than be silently
        // ignored by an old client that would then trust a payload it misread.
        let raw = r#"{"userId":"1","isPro":true,"plan":"pro","product":"wafix","issuedAt":1,"expiresAt":null,"isAdmin":true}"#;
        assert!(serde_json::from_str::<LicensePayload>(raw).is_err());
    }

    // -----------------------------------------------------------------
    // Freshness
    // -----------------------------------------------------------------

    #[test]
    fn a_fresh_signed_lifetime_payload_exposes_its_plan_only_after_verification() {
        let store = store_signed_in_as("lifetime-accessor", SIGNED_IN);
        let mut payload = payload_for(SIGNED_IN);
        payload.plan = Some("lifetime".into());
        let (response, public_key) = signed_response(&payload);
        assert_eq!(
            verified_fresh_response(&response, &public_key, Some(SIGNED_IN)),
            Some(payload)
        );
        // The same fixture cannot pass the production key used by the store.
        store.save(&response).unwrap();
        assert_eq!(store.verified_fresh_payload(), None);
        let mut tampered = response;
        tampered.payload_json.push(' ');
        assert_eq!(verified_fresh_response(&tampered, &public_key, Some(SIGNED_IN)), None);
    }

    #[test]
    fn the_verified_payload_accessor_rejects_wrong_product_expired_and_future_signatures() {
        for (product, issued_at) in [
            ("another-product", now_secs()),
            (PRODUCT_ID, now_secs().saturating_sub(GRACE_PERIOD_SECS + 3600)),
            (PRODUCT_ID, now_secs().saturating_add(MAX_CLOCK_SKEW_SECS + 3600)),
        ] {
            let mut payload = payload_for(SIGNED_IN);
            payload.product = product.into();
            payload.issued_at = issued_at;
            let (response, public_key) = signed_response(&payload);
            assert_eq!(
                verified_fresh_response(&response, &public_key, Some(SIGNED_IN)),
                None,
                "{product} issued at {issued_at} must not verify"
            );
        }
    }

    #[test]
    fn the_offline_grace_window_is_three_days_and_not_a_moment_longer() {
        // Pinned by value. Every other freshness test is written in terms of the
        // constant, so widening it moves the assertion with it and none of them
        // would notice — and a wide window is precisely how a revoked Pro grant
        // keeps working on a machine that has not been online since.
        assert_eq!(GRACE_PERIOD_SECS, 3 * 24 * 60 * 60);

        let now = 1_800_000_000;
        let mut payload = payload_for(SIGNED_IN);
        payload.issued_at = now;
        assert!(is_fresh_at(&payload, now + GRACE_PERIOD_SECS));
        assert!(
            !is_fresh_at(&payload, now + GRACE_PERIOD_SECS + 1),
            "one second past three days must already be stale"
        );
    }

    #[test]
    fn a_payload_older_than_the_grace_period_is_not_fresh() {
        let mut payload = payload_for(SIGNED_IN);
        payload.issued_at = now_secs().saturating_sub(GRACE_PERIOD_SECS + 3600);
        assert!(!is_fresh(&payload));
    }

    #[test]
    fn signed_issue_times_respect_clock_skew_and_expiry_boundaries() {
        let now = 1_800_000_000;
        let mut payload = LicensePayload {
            user_id: SIGNED_IN.into(),
            is_pro: true,
            plan: Some("pro".into()),
            product: PRODUCT_ID.into(),
            issued_at: now,
            expires_at: None,
        };
        assert!(is_fresh_at(&payload, now));
        assert!(is_fresh_at(&payload, now + GRACE_PERIOD_SECS));
        assert!(!is_fresh_at(&payload, now + GRACE_PERIOD_SECS + 1));
        payload.issued_at = now + MAX_CLOCK_SKEW_SECS;
        assert!(is_fresh_at(&payload, now));
        payload.issued_at += 1;
        assert!(!is_fresh_at(&payload, now));
        payload.issued_at = u64::MAX;
        assert!(!is_fresh_at(&payload, now));
        payload.issued_at = 0;
        assert!(!is_fresh_at(&payload, now));
    }

    #[test]
    fn paid_period_cuts_off_offline_access_and_renewal_requires_a_new_payload() {
        // 1.0.0 grants `pro` or `lifetime`, and only `pro` can carry a cutoff -
        // a lifetime grant with an expiry would quietly become a subscription.
        let now = 1_800_000_000;
        let mut payload = LicensePayload {
            user_id: SIGNED_IN.into(),
            is_pro: true,
            plan: Some("pro".into()),
            product: PRODUCT_ID.into(),
            issued_at: now,
            expires_at: Some(now + 60),
        };
        assert!(is_fresh_at(&payload, now + 59));
        // Cancellation and unsuccessful renewal do not extend the paid period.
        assert!(!is_fresh_at(&payload, now + 60));
        assert!(!is_fresh_at(&payload, now + 61));
        payload.issued_at = now + 60;
        payload.expires_at = Some(now + 86400);
        assert!(is_fresh_at(&payload, now + 61));
        payload.expires_at = Some(now + GRACE_PERIOD_SECS * 2);
        assert!(!is_fresh_at(&payload, now + 61 + GRACE_PERIOD_SECS));
    }

    #[test]
    fn a_perpetual_grant_still_needs_a_refresh() {
        // `expires_at: null` means "no end date", not "valid forever". Without a
        // refresh the revocation bound would be unbounded.
        let mut payload = payload_for(SIGNED_IN);
        payload.plan = Some("lifetime".into());
        payload.issued_at = 1_800_000_000;
        assert!(is_fresh_at(&payload, 1_800_000_000));
        assert!(!is_fresh_at(&payload, 1_800_000_000 + GRACE_PERIOD_SECS + 1));
    }

    #[test]
    fn signed_expiry_is_verified_and_caches_remain_bounded() {
        let now = now_secs();
        let mut payload = payload_for(SIGNED_IN);
        payload.expires_at = Some(now - 1);
        let (response, public_key) = signed_response(&payload);
        assert_eq!(
            verified_fresh_response(&response, &public_key, Some(SIGNED_IN)),
            None
        );
        let tampered = response
            .payload_json
            .replace(&(now - 1).to_string(), &(now + 86400).to_string());
        assert_ne!(tampered, response.payload_json);
        assert_eq!(
            verify_with_public_key(&tampered, &response.signature, &public_key),
            Err(VerifyError::SignatureInvalid)
        );
        payload.expires_at = None;
        assert!(is_fresh_at(&payload, now));
        assert!(!is_fresh_at(&payload, now + GRACE_PERIOD_SECS + 1));
    }

    // -----------------------------------------------------------------
    // Store plumbing
    // -----------------------------------------------------------------

    #[test]
    fn no_cached_file_means_not_pro_rather_than_a_crash() {
        let store = store_signed_in_as("missing", SIGNED_IN);
        assert!(!store.is_pro_and_fresh());
    }

    #[test]
    fn a_corrupt_cache_file_means_not_pro_rather_than_a_crash() {
        let dir = temp_dir("corrupt");
        crate::account::save_account_id(&dir, Some(SIGNED_IN));
        let store = LicenseStore::new(dir.clone());
        std::fs::write(dir.join("license.json"), "not json at all").unwrap();
        assert!(!store.is_pro_and_fresh());
    }

    /// After `delete`, a previously fresh cache must no longer read as Pro —
    /// this is what stops a still-valid cache from one account granting Pro
    /// to whoever logs in next on the same machine.
    #[test]
    fn deleting_the_cache_makes_is_pro_and_fresh_false_again() {
        let store = store_signed_in_as("delete", SIGNED_IN);
        let (response, public_key) = signed_response(&payload_for(SIGNED_IN));
        store.save(&response).unwrap();
        assert!(store.load().is_some(), "precondition: something is cached");
        assert_eq!(
            verified_fresh_response(&response, &public_key, Some(SIGNED_IN)),
            Some(payload_for(SIGNED_IN))
        );

        store.delete().unwrap();
        assert!(store.load().is_none());
        assert!(!store.is_pro_and_fresh());
        // delete() on an already-empty store must not error.
        store.delete().unwrap();
    }

    #[test]
    fn the_cache_file_is_written_atomically_and_keeps_no_leftover_temp_file() {
        let dir = temp_dir("atomic");
        let store = LicenseStore::new(dir.clone());
        let (response, _) = signed_response(&payload_for(SIGNED_IN));
        store.save(&response).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "an interrupted write would leave these: {leftovers:?}"
        );
    }
}