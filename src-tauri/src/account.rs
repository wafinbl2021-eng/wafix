//! Wafi X accounts: register, sign in, sign out, and who am I.
//!
//! WHY THIS LIVES IN RUST AND NOT IN THE WEBVIEW
//! ==============================================
//!
//! The account API hands out its session as a cookie with `SameSite=Strict`
//! (`wafx-api/src/account-session.ts:99`). A Tauri webview runs on its own origin
//! (`http://tauri.localhost` on Windows, `tauri://localhost` elsewhere), which is a
//! *different site* from `wafx-api.wafinbl2021.workers.dev`. Chromium's rule is
//! unambiguous: a `SameSite=Strict` cookie is stored on a cross-site response and
//! then never sent again on a cross-site request. A sign-in from the webview would
//! return 200, and every later `/api/account/me` would answer 401, for the life of
//! the install.
//!
//! There are two ways out. Flip the cookie to `SameSite=None`, which removes the
//! third of the three CSRF layers and widens exposure for anyone also signed in
//! through a real browser; or move the HTTP out of the browser, where `SameSite`
//! is a cookie attribute rather than a rule the client obeys. This is the second.
//!
//! The token therefore never crosses the IPC boundary. No command here returns
//! one, takes one, or writes one anywhere the frontend can read. The cookie lives
//! in a DPAPI-encrypted file under the app's data directory and is replayed as a
//! `Cookie:` header. The webview learns *whether* there is a session and whose it
//! is, which is all an account screen needs.
//!
//! WHAT THIS MODULE WILL NOT DO
//! =============================
//!
//! No machine id, no device id, no install id, no hostname, no IP, no telemetry,
//! no heartbeat, no polling. The API has nowhere to put any of it and this module
//! has nothing to send it. `/api/account/me` returns no address-derived identifier
//! either, so there is nothing here that could bind a session to this PC even by
//! accident.
//!
//! The password model is the admin panel's, unchanged: PBKDF2-HMAC-SHA256 at
//! whatever iteration count the server reports, producing a 32-byte verifier. The
//! password never leaves this process; only the verifier does.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
// `app.path()` comes from this trait. Not from `AppHandle` itself.
use tauri::Manager;
use std::time::Duration;

/// The API. Overridable so a staging Worker needs no recompile.
pub const DEFAULT_ACCOUNT_API: &str = "https://wafx-api.wafinbl2021.workers.dev";

/// How long a sign-in may take before it is called unreachable.
const TIMEOUT: Duration = Duration::from_secs(30);

/// The cookie names the API uses, depending on whether the deployment's account
/// origin is https (`__Host-` requires `Secure`). Whichever arrives is used.
const COOKIE_NAMES: [&str; 2] = ["__Host-wafx_account", "wafx_account"];

pub fn api_base() -> String {
    std::env::var("WAFIX_ACCOUNT_API")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_ACCOUNT_API.to_string())
}

// ---------------------------------------------------------------------------
// PBKDF2-HMAC-SHA256
// ---------------------------------------------------------------------------

/// HMAC-SHA256 (RFC 2104). SHA-256's block size is 64 bytes.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;

    let mut padded = [0u8; BLOCK];
    if key.len() > BLOCK {
        padded[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        padded[..key.len()].copy_from_slice(key);
    }

    let mut inner_key = [0x36u8; BLOCK];
    let mut outer_key = [0x5cu8; BLOCK];
    for index in 0..BLOCK {
        inner_key[index] ^= padded[index];
        outer_key[index] ^= padded[index];
    }

    let mut inner = Sha256::new();
    inner.update(inner_key);
    inner.update(message);
    let inner = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_key);
    outer.update(inner);
    let digest = outer.finalize();

    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// PBKDF2 with HMAC-SHA256 (RFC 8018 §5.2), producing `dk_len` bytes.
fn pbkdf2_hmac_sha256(password: &[u8], salt: &[u8], iterations: u32, dk_len: usize) -> Vec<u8> {
    assert!(iterations > 0, "PBKDF2 needs at least one iteration");
    assert!(dk_len > 0, "PBKDF2 must produce something");

    let mut out = Vec::with_capacity(dk_len);
    let mut block: u32 = 1;

    while out.len() < dk_len {
        let mut salted = Vec::with_capacity(salt.len() + 4);
        salted.extend_from_slice(salt);
        salted.extend_from_slice(&block.to_be_bytes());

        let mut u = hmac_sha256(password, &salted);
        let mut accumulator = u;

        for _ in 1..iterations {
            u = hmac_sha256(password, &u);
            for (acc, byte) in accumulator.iter_mut().zip(u.iter()) {
                *acc ^= byte;
            }
        }

        out.extend_from_slice(&accumulator);
        block += 1;
    }

    out.truncate(dk_len);
    out
}

pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Derives the verifier the API stores a hash of.
///
/// Two details are load-bearing, and both are easy to get subtly wrong:
///
///   - The salt is the **UTF-8 bytes of the hex string the API returned**, not
///     the bytes that string encodes. `wafx-api/admin/app.js:117` hands
///     `encoder.encode(salt)` straight to WebCrypto. If this decoded instead,
///     every verifier would differ from the one the panel derives and every sign-in
///     would fail as though the password were wrong.
///   - 32 bytes, **lowercase** hex, because the API's `VERIFIER_PATTERN` is
///     `/^[0-9a-f]{64}$/`.
///
/// `iterations` comes from `/api/account/auth/params` rather than being pinned
/// here, so raising the stored figure later needs no code change on this side.
pub fn derive_verifier(password: &str, salt: &str, iterations: u32) -> String {
    hex(&pbkdf2_hmac_sha256(
        password.as_bytes(),
        salt.as_bytes(),
        iterations,
        32,
    ))
}

// ---------------------------------------------------------------------------
// The cookie
// ---------------------------------------------------------------------------

/// Whether a `Set-Cookie` header carries a session rather than a revocation.
///
/// `Max-Age=0` is how the API revokes, so a stored clearing header means "no
/// session" and must never be replayed. Storing the clearing header and sending
/// it back would send an empty cookie, which happens to fail - correct by
/// accident, and only because the value was blank.
pub fn is_live_cookie(set_cookie: &str) -> bool {
    let mut live = false;
    for attribute in set_cookie.split(';') {
        let attribute = attribute.trim();
        if let Some(value) = attribute
            .strip_prefix("Max-Age=")
            .or_else(|| attribute.strip_prefix("max-age="))
        {
            if value.trim().parse::<i64>().unwrap_or(1) <= 0 {
                return false;
            }
        }
        let Some((name, value)) = attribute.split_once('=') else {
            // A bare attribute such as `Secure` or `HttpOnly`. Nothing to read.
            continue;
        };
        let name = name.trim();
        if COOKIE_NAMES.contains(&name) && !value.trim().is_empty() {
            live = true;
        }
    }
    live
}

/// The `name=value` pair to put in a `Cookie:` request header, or `None`.
///
/// Only the first attribute is used: the rest are directives the client is not
/// meant to echo back. Sending a stored `Path=/` or `SameSite=Strict` as if it
/// were part of the value would make the server see a different token from the one
/// the app stored, and the symptom would be an inexplicable 401.
pub fn request_cookie(set_cookie: &str) -> Option<String> {
    if !is_live_cookie(set_cookie) {
        return None;
    }
    let first = set_cookie.split(';').next()?.trim();
    let (name, value) = first.split_once('=')?;
    let name = name.trim();
    let value = value.trim();
    if COOKIE_NAMES.contains(&name) && !value.is_empty() {
        Some(first.to_string())
    } else {
        None
    }
}

/// Picks the session cookie out of a response's `Set-Cookie` headers.
///
/// There are two names for one cookie depending on the deployment's account
/// origin; the API never sends both at once.
pub fn extract_session_cookie(headers: &[String]) -> Option<String> {
    headers
        .iter()
        .find(|value| {
            COOKIE_NAMES
                .iter()
                .any(|name| value.starts_with(&format!("{name}=")))
        })
        .cloned()
}

// ---------------------------------------------------------------------------
// Encrypted storage
// ---------------------------------------------------------------------------

const SESSION_FILE: &str = "account-session.bin";

fn session_path(dir: &Path) -> std::path::PathBuf {
    dir.join(SESSION_FILE)
}

#[cfg(windows)]
mod protect {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    /// Holds DPAPI's output pointer so it is released exactly once.
    ///
    /// `LocalFree` on the wrong pointer, or not at all, is a heap corruption or a
    /// leak on every single launch - so the raw pointer never escapes this file.
    struct Local(*mut u8);

    impl Drop for Local {
        fn drop(&mut self) {
            unsafe { LocalFree(self.0 as *mut _) };
        }
    }

    fn take(output: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let owned = Local(output.pbData);
        unsafe { std::slice::from_raw_parts(owned.0, output.cbData as usize) }.to_vec()
    }

    pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(plain);
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // No description string and no UI: this runs on a background thread with
        // no window to prompt from, and a prompt would hang the launch.
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("could not protect the session cookie".to_string());
        }
        Ok(take(&output))
    }

    pub fn decrypt(cipher: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(cipher);
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("could not unprotect the session cookie".to_string());
        }
        Ok(take(&output))
    }
}

/// Session persistence is Windows-only in 1.0.0. Anywhere else, the session
/// simply lasts as long as the process - a working sign-in, just not a sticky one.
#[cfg(not(windows))]
mod protect {
    pub fn encrypt(_plain: &[u8]) -> Result<Vec<u8>, String> {
        Err("session persistence is Windows-only in 1.0.0".to_string())
    }
    pub fn decrypt(_cipher: &[u8]) -> Result<Vec<u8>, String> {
        Err("session persistence is Windows-only in 1.0.0".to_string())
    }
}

/// Persists a live cookie, or removes the file when there is not one.
///
/// A failure to write is deliberately **not** returned to the caller as a failed
/// sign-in: the cookie is still in hand for this run, so the user is signed in
/// until they close the app. Losing persistence is an annoyance; refusing to sign
/// someone in because their data directory is read-only would be a bug.
pub fn save_session(dir: &Path, set_cookie: Option<&str>) {
    let path = session_path(dir);
    match set_cookie.filter(|value| is_live_cookie(value)) {
        Some(value) => {
            if std::fs::create_dir_all(dir).is_err() {
                return;
            }
            if let Ok(encrypted) = protect::encrypt(value.as_bytes()) {
                let _ = std::fs::write(path, encrypted);
            }
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Reads the persisted cookie, treating any problem as "signed out".
///
/// Absent, unreadable, undecryptable and malformed all resolve to `None`. A
/// corrupt file must not stop the app launching, and it is not something the user
/// can act on: the honest response to a session that cannot be proven is to ask
/// them to sign in again.
pub fn load_session(dir: &Path) -> Option<String> {
    let cipher = std::fs::read(session_path(dir)).ok()?;
    let plain = protect::decrypt(&cipher).ok()?;
    let text = String::from_utf8(plain).ok()?;
    is_live_cookie(&text).then_some(text)
}

// ---------------------------------------------------------------------------
// The signed-in account id
// ---------------------------------------------------------------------------

const ACCOUNT_ID_FILE: &str = "account-id";

fn account_id_path(dir: &Path) -> std::path::PathBuf {
    dir.join(ACCOUNT_ID_FILE)
}

/// Records which account this install is signed in as, or forgets it.
///
/// Deliberately **plain text and not encrypted**, unlike the session cookie. The
/// cookie is a bearer credential, so it is protected; this is not - it is an
/// identifier with no power of its own, and the only thing that acts on it is a
/// signature check performed by `license::LicenseStore`. Encrypting it would buy
/// nothing an attacker with the same user's file access could not get by calling
/// `/me`, while making it untestable: DPAPI can only run on a real Windows user
/// profile, so an encrypted id could not be covered by a unit test at all.
///
/// It is never sent over IPC and never reaches web storage. See `AccountView`
/// for why the frontend has no use for it.
pub fn save_account_id(dir: &Path, account_id: Option<&str>) {
    let path = account_id_path(dir);
    match account_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => {
            if std::fs::create_dir_all(dir).is_err() {
                return;
            }
            let _ = std::fs::write(path, id);
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// The account id written by the last successful `/me`, if any.
///
/// Any problem is "signed out", matching [`load_session`]: an id we cannot read
/// is an id we cannot bind an entitlement to, and the honest response to that
/// is to ask the user to sign in again rather than to guess.
pub fn load_account_id(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(account_id_path(dir)).ok()?;
    let trimmed = text.trim();
    (!trimmed.is_empty() && trimmed.len() <= 128).then(|| trimmed.to_string())
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
struct AuthParams {
    salt: String,
    iterations: u32,
}

#[derive(Debug, serde::Deserialize)]
struct ErrorDetail {
    /// Required alongside `message` before either is shown - see [`api_message`].
    #[serde(default)]
    code: String,
    message: String,
}

#[derive(Debug, serde::Deserialize)]
struct ErrorBody {
    error: ErrorDetail,
}

/// What the frontend may see about the signed-in account.
///
/// Narrow on purpose: an address, when they last signed in, and how much of the
/// session is left. No account id - nothing in the UI needs one, and an id that
/// crosses the IPC boundary is one more value to leak. No Pro field: Phase 5 adds
/// a signed licence, because a client that can be told "you are Pro" by a plain
/// HTTP boolean is a client whose Pro can be spoofed.
#[derive(Debug, Clone, Serialize)]
pub struct AccountView {
    pub email: String,
    pub last_login_at: Option<String>,
    pub expires_in_seconds: u64,
}

/// Which kind of thing went wrong, so the UI can tell "not signed in" from "the
/// network is down" without parsing an English sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// 401, or 403. The API answers both for a wrong password, an unknown
    /// address and a disabled account, and this must not tell them apart.
    NotSignedIn,
    /// 429, with the wait the server asked for.
    RateLimited(u64),
    /// Any other status: 5xx, a redirect, or a reply that did not parse.
    ///
    /// There is deliberately no `Unreachable` variant here. That case never has a
    /// status at all - it is detected while sending, before there is anything to
    /// classify - so it is built directly as an `AccountError` rather than routed
    /// through this type. A variant that can only ever be synthesised by hand is
    /// one more thing to get wrong.
    Server,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountError {
    pub kind: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
}

impl AccountError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            retry_after_seconds: None,
        }
    }

    fn rate_limited(wait: u64, message: Option<String>) -> Self {
        Self {
            kind: "rate_limited",
            message: message.unwrap_or_else(|| "Too many attempts. Try again shortly.".to_string()),
            retry_after_seconds: Some(wait),
        }
    }

    pub fn unreachable() -> Self {
        Self::new(
            "unreachable",
            "Could not reach the sign-in service. Check your connection.",
        )
    }

    pub fn odd_reply() -> Self {
        Self::new("server", "The sign-in service replied in a way Daltoon X did not expect.")
    }
}

/// Maps a status to a failure kind.
///
/// 403 is folded into 401 rather than given its own kind. The API deliberately
/// refuses to distinguish a wrong password from a disabled account, and a distinct
/// `kind` here would hand the frontend back the enumeration oracle that
/// `wafx-api/src/routes/account-auth.ts:327` exists to remove.
pub fn classify(status: u16) -> Failure {
    match status {
        401 | 403 => Failure::NotSignedIn,
        429 => Failure::RateLimited(0),
        _ => Failure::Server,
    }
}

/// Pulls the API's own error message out of a body, when it carries one.
///
/// Shown to the user as-is. That is the same trade the admin panel makes, and the
/// better one: a generic "something went wrong" in front of "Too many attempts.
/// Try again later." tells the user less than the server already knew.
pub fn api_message(body: &str) -> Option<String> {
    let parsed: ErrorBody = serde_json::from_str(body).ok()?;
    // A code is required alongside the message. An error body without one is not
    // this API's shape, and rendering its `message` anyway would put an
    // attacker-controlled string in front of the user.
    if parsed.error.code.trim().is_empty() || parsed.error.message.trim().is_empty() {
        return None;
    }
    Some(parsed.error.message)
}

/// Reads `Retry-After` as seconds, ignoring the HTTP-date form.
///
/// Only delta-seconds is honoured. The date form would need a trusted clock to be
/// meaningful, and a confidently wrong "come back in 40 minutes" is worse than no
/// hint at all.
pub fn retry_after_seconds(value: Option<&str>) -> Option<u64> {
    value?.trim().parse::<u64>().ok()
}

/// Turns a `/api/account/me` body into the view the frontend receives, keeping
/// the account id to one side.
///
/// Private, and returning a tuple rather than filling an out-parameter, so that
/// "the frontend must not see an account id" is enforced by the types on
/// `remember_account` and `MeOutcome` rather than by remembering to strip a field
/// at each call site. The id goes to `save_account_id` and nowhere else.
fn parse_me_with_id(body: &str) -> Result<(AccountView, String), String> {
    #[derive(serde::Deserialize)]
    struct Body {
        account: Account,
        session: Session,
    }
    #[derive(serde::Deserialize)]
    struct Account {
        id: String,
        email: String,
        #[serde(default)]
        last_login_at: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Session {
        expires_in_seconds: u64,
    }

    let parsed: Body = serde_json::from_str(body).map_err(|e| format!("unexpected /me reply: {e}"))?;
    if parsed.account.email.trim().is_empty() {
        return Err("the sign-in service returned an account with no address".to_string());
    }
    let account_id = parsed.account.id.trim().to_string();
    if account_id.is_empty() {
        return Err("the sign-in service returned an account with no id".to_string());
    }
    Ok((
        AccountView {
            email: parsed.account.email,
            last_login_at: parsed.account.last_login_at,
            expires_in_seconds: parsed.session.expires_in_seconds,
        },
        account_id,
    ))
}

/// Which account a `/me` reply belongs to, for tests.
#[cfg(test)]
pub(crate) fn account_id_of(body: &str) -> Option<String> {
    parse_me_with_id(body).ok().map(|(_, id)| id)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/// What one account call produced.
pub(crate) enum Reply {
    /// A 2xx, with its body and every `Set-Cookie` it carried (possibly none).
    Done {
        body: String,
        cookies: Vec<String>,
    },
    Refused(AccountError),
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("WafiX/{}", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        // A sign-in is one small request. Thirty seconds is not "generous", it is
        // "long enough that a slow line is not reported as an outage".
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("could not create the HTTP client: {e}"))
}

/// The `Origin` an account request declares.
///
/// The API's own base, because leaving `ACCOUNT_ORIGIN` unset makes the allowlist
/// `[PUBLIC_ORIGIN]`, which is this host. A trailing slash is dropped because
/// `origin()` in `wafx-api/src/env.ts` rejects a path and would answer 403.
fn origin_of(base: &str) -> String {
    base.trim_end_matches('/').to_string()
}

/// One account request.
///
/// `Origin` is set on purpose. `requireAccountOrigin` refuses a mutating account
/// request whose Origin is absent or off the allowlist, and skips the check for
/// GET. `X-WAFI-Admin` is never sent - for an account route that header is a
/// falsehood rather than a defence, and `middleware/csrf.ts` says why.
pub(crate) async fn call(
    base: &str,
    cookie: Option<&str>,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Reply {
    let http = match client() {
        Ok(http) => http,
        Err(message) => return Reply::Refused(AccountError::new("server", message)),
    };

    let mut builder = http
        .request(method, format!("{base}{path}"))
        .header("origin", origin_of(base));

    if let Some(cookie) = cookie.and_then(request_cookie) {
        builder = builder.header("cookie", cookie);
    }
    if let Some(body) = body {
        builder = builder
            .header("content-type", "application/json")
            .body(serde_json::to_string(&body).unwrap_or_default());
    }

    let response = match builder.send().await {
        Ok(response) => response,
        Err(_) => return Reply::Refused(AccountError::unreachable()),
    };

    let status = response.status().as_u16();
    let retry_after = retry_after_seconds(
        response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok()),
    );
    let cookies: Vec<String> = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect();
    let text = response.text().await.unwrap_or_default();

    if !(200..300).contains(&status) {
        let message = api_message(&text);
        return match classify(status) {
            Failure::RateLimited(_) => {
                Reply::Refused(AccountError::rate_limited(retry_after.unwrap_or(60), message))
            }
            Failure::NotSignedIn => {
                // One message for every 401 *and* 403. The API cannot tell a wrong
                // password from a disabled account, so this must not either.
                Reply::Refused(AccountError::new(
                    "not_signed_in",
                    message.unwrap_or_else(|| "Sign in to continue".to_string()),
                ))
            }
            _ => Reply::Refused(AccountError::new(
                "server",
                message.unwrap_or_else(|| "The sign-in service had a problem. Try again.".to_string()),
            )),
        };
    }

    Reply::Done {
        body: text,
        cookies,
    }
}

/// Reads `{"salt":...,"iterations":...}` - all this helper needs from a body.
async fn auth_params(base: &str, email: &str) -> Result<AuthParams, AccountError> {
    let path = format!("/api/account/auth/params?email={}", urlencode(email.trim()));
    match call(base, None, reqwest::Method::GET, &path, None).await {
        Reply::Refused(error) => Err(error),
        // An unknown address gets a decoy salt rather than an error, so a parse
        // failure here means the service is misbehaving rather than that the
        // address is unknown - and it must not be reported as the latter.
        Reply::Done { body, .. } => serde_json::from_str(&body).map_err(|_| AccountError::odd_reply()),
    }
}

/// Percent-encodes a query value.
///
/// Hand-rolled because a crate for a handful of characters of overlap is not worth
/// a new dependency. Only RFC 3986's unreserved set is left bare, so `@` becomes
/// `%40` - which is uglier in a log and safer, since the two characters that would
/// actually change the meaning of an address (`&` and `+`) are always escaped.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The result of "who am I".
///
/// One shape rather than a `Result`, because every caller wants the same three
/// answers: signed in, not signed in, or cannot tell. Modelling it as an error
/// would make "signed out" an exceptional case, and a fresh launch is signed out.
#[derive(Debug, Serialize)]
pub struct MeOutcome {
    pub signed_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountView>,
    /// Present only for a *failure*. "Not signed in" is a state, not a fault, and
    /// is reported by `signed_in: false` with no error - otherwise every launch
    /// would open on a message about not being signed in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AccountError>,
}

impl MeOutcome {
    fn signed_out() -> Self {
        Self {
            signed_in: false,
            account: None,
            error: None,
        }
    }

    fn failed(error: AccountError) -> Self {
        Self {
            signed_in: false,
            account: None,
            error: Some(error),
        }
    }
}

fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AccountError> {
    app.path()
        .app_data_dir()
        .map_err(|e| AccountError::new("server", format!("{e}")))
}

/// Forgets every trace of the signed-in account on this install.
///
/// Called wherever the session cookie is dropped, so the two can never disagree:
/// a cookie-less install that still remembered an id could bind a cached
/// entitlement to an account nobody is signed in as any more.
fn forget_account(dir: &Path) {
    save_session(dir, None);
    save_account_id(dir, None);
}

/// Records the id behind a `/me` that just succeeded.
fn remember_account(dir: &Path, body: &str) -> Result<AccountView, String> {
    let (view, id) = parse_me_with_id(body)?;
    save_account_id(dir, Some(&id));
    Ok(view)
}

/// Restores the session on launch.
///
/// One call, once. No polling and no heartbeat: an account screen does not need
/// to know the moment a session lapses, and a repeating request would be both a
/// battery cost and a quiet heartbeat the user never agreed to.
#[tauri::command(async)]
pub async fn account_me(app: tauri::AppHandle) -> MeOutcome {
    let dir = match data_dir(&app) {
        Ok(dir) => dir,
        Err(error) => return MeOutcome::failed(error),
    };
    let base = api_base();
    let cookie = load_session(&dir);

    match call(&base, cookie.as_deref(), reqwest::Method::GET, "/api/account/me", None).await {
        Reply::Done { body, cookies } => {
            // A 200 may also refresh the cookie's Max-Age, which is what makes the
            // session slide. Keeping it is the difference between staying signed in
            // and being asked to sign in again next week.
            if let Some(refreshed) = extract_session_cookie(&cookies) {
                save_session(&dir, Some(&refreshed));
            }
            match remember_account(&dir, &body) {
                Ok(account) => MeOutcome {
                    signed_in: true,
                    account: Some(account),
                    error: None,
                },
                Err(_) => MeOutcome::signed_out(),
            }
        }
        Reply::Refused(error) if error.kind == "not_signed_in" => {
            // The server forgot this session. Forget it too, so a stale file is
            // not retried on every launch.
            forget_account(&dir);
            MeOutcome::signed_out()
        }
        // A network failure is *not* a sign-out. Recording the user as logged out
        // because a laptop lid closed mid-request would throw away a perfectly good
        // session; the UI keeps what it knew and says the check failed.
        Reply::Refused(error) => MeOutcome::failed(error),
    }
}

/// Signs in, then reports who that actually is.
///
/// `/api/account/login` is asked first and `/api/account/me` asked second, even
/// though login already returns the account. The two can disagree - an account
/// disabled between the requests is the obvious case - and only `/me` runs behind
/// the session guard, so it is the one that knows.
#[tauri::command(async)]
pub async fn account_login(app: tauri::AppHandle, email: String, password: String) -> MeOutcome {
    let dir = match data_dir(&app) {
        Ok(dir) => dir,
        Err(error) => return MeOutcome::failed(error),
    };
    let base = api_base();

    let params = match auth_params(&base, &email).await {
        Ok(params) => params,
        Err(error) => return MeOutcome::failed(error),
    };
    let verifier = derive_verifier(&password, &params.salt, params.iterations);
    let body = serde_json::json!({ "email": email.trim(), "verifier": verifier });

    let cookies = match call(
        &base,
        None,
        reqwest::Method::POST,
        "/api/account/login",
        Some(body),
    )
    .await
    {
        Reply::Refused(error) => return MeOutcome::failed(error),
        Reply::Done { cookies, .. } => cookies,
    };

    let Some(cookie) = extract_session_cookie(&cookies).filter(|value| is_live_cookie(value)) else {
        // A 200 with no session cookie is not a sign-in. Treating it as one would
        // put the UI in a state the API never authorised.
        return MeOutcome::failed(AccountError::odd_reply());
    };
    save_session(&dir, Some(&cookie));

    match call(
        &base,
        Some(&cookie),
        reqwest::Method::GET,
        "/api/account/me",
        None,
    )
    .await
    {
        Reply::Done { body, .. } => match remember_account(&dir, &body) {
            Ok(account) => MeOutcome {
                signed_in: true,
                account: Some(account),
                error: None,
            },
            Err(_) => {
                forget_account(&dir);
                MeOutcome::failed(AccountError::odd_reply())
            }
        },
        Reply::Refused(error) => {
            forget_account(&dir);
            MeOutcome::failed(error)
        }
    }
}

/// Creates an account, or does nothing.
///
/// The API answers every outcome identically so it cannot be used to discover which
/// addresses exist, and it issues no session - signing in is a separate request.
/// That is why this returns no account: there is no account to report, and
/// reporting anything else would be the enumeration channel, from our side.
#[tauri::command(async)]
pub async fn account_register(
    email: String,
    password: String,
) -> Result<(), AccountError> {
    let base = api_base();
    let params = auth_params(&base, &email).await?;

    // The salt sent back is the one `/auth/params` just handed out - the stored
    // salt for an address that exists, or the decoy for one that does not. Either
    // way the API stores the salt alongside the hash it computes, so a later
    // sign-in derives the same verifier. That is what makes a repeat registration
    // a no-op rather than an account takeover.
    let verifier = derive_verifier(&password, &params.salt, params.iterations);
    let body = serde_json::json!({
        "email": email.trim(),
        "verifier": verifier,
        "salt": params.salt,
        "iterations": params.iterations,
    });

    match call(
        &base,
        None,
        reqwest::Method::POST,
        "/api/account/register",
        Some(body),
    )
    .await
    {
        Reply::Done { .. } => Ok(()),
        Reply::Refused(error) => Err(error),
    }
}

/// Signs this device out.
///
/// The local cookie is removed whether or not the server answered. If the network
/// is down the session row survives server-side, but the cookie this app would
/// replay is gone - and "this device is signed out" is what the button means. It
/// also revokes only this session, matching the API: signing out on a shared
/// machine should sign out that machine.
#[tauri::command(async)]
pub async fn account_logout(app: tauri::AppHandle) {
    let Ok(dir) = data_dir(&app) else { return };
    let base = api_base();
    let cookie = load_session(&dir);
    let _ = call(
        &base,
        cookie.as_deref(),
        reqwest::Method::POST,
        "/api/account/logout",
        Some(serde_json::json!({})),
    )
    .await;
    forget_account(&dir);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const SIGNED_IN_ID: &str = "11111111-2222-3333-4444-555555555555";

    fn temp_dir_for(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wafix-account-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// RFC 4231 cases 1, 2 and 6 for HMAC-SHA256.
    ///
    /// Case 6 is the one that matters most here: a 131-byte key must be hashed down
    /// before use, which is the branch a naive implementation gets wrong.
    #[test]
    fn hmac_sha256_known_answers() {
        assert_eq!(
            hex(&hmac_sha256(&[0x0b; 20], b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(
            hex(&hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    /// RFC 7914 §11's PBKDF2-HMAC-SHA256 vectors.
    ///
    /// The first asks for 64 bytes, which is two PBKDF2 blocks, so it fails if the
    /// block counter is not wired up - the single most common way to get this wrong
    /// and the one a 32-byte-only test would never notice.
    #[test]
    fn pbkdf2_hmac_sha256_known_answers() {
        assert_eq!(
            hex(&pbkdf2_hmac_sha256(b"passwd", b"salt", 1, 64)),
            concat!(
                "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc",
                "49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783",
            )
        );
        assert_eq!(
            hex(&pbkdf2_hmac_sha256(b"Password", b"NaCl", 80_000, 64)),
            concat!(
                "4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56",
                "a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d",
            )
        );
    }

    /// The shape `VERIFIER_PATTERN` in the API demands.
    #[test]
    fn verifier_is_64_lowercase_hex() {
        let verifier = derive_verifier("correct horse battery staple", "00112233", 1_000);
        assert_eq!(verifier.len(), 64);
        assert!(verifier
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    /// The salt is used as text, not decoded.
    ///
    /// If this ever changes, every existing account becomes un-signable-in and the
    /// failure presents as a wrong password rather than as a client bug - so the
    /// difference is asserted rather than described.
    #[test]
    fn salt_is_used_as_text_not_decoded() {
        assert_eq!(
            derive_verifier("pw", "aabb", 1_000),
            hex(&pbkdf2_hmac_sha256(b"pw", b"aabb", 1_000, 32))
        );
        assert_ne!(
            derive_verifier("pw", "aabb", 1_000),
            hex(&pbkdf2_hmac_sha256(b"pw", &[0xaa, 0xbb], 1_000, 32))
        );
    }

    /// A revocation must never be replayed as a session.
    #[test]
    fn revocation_is_not_a_live_cookie() {
        assert!(!is_live_cookie("wafx_account=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"));
        assert!(!is_live_cookie("__Host-wafx_account=; Path=/; Max-Age=0"));
        assert!(!is_live_cookie("something_else=abc; Path=/"));
        assert!(!is_live_cookie("wafx_account=abc; Path=/; Max-Age=-1"));
    }

    #[test]
    fn live_cookies_are_recognised_in_both_namings() {
        let plain = "wafx_account=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400";
        let host = "__Host-wafx_account=abc; Path=/; Secure; Max-Age=86400";
        assert!(is_live_cookie(plain));
        assert!(is_live_cookie(host));
        assert_eq!(request_cookie(plain).as_deref(), Some("wafx_account=abc"));
        assert_eq!(request_cookie(host).as_deref(), Some("__Host-wafx_account=abc"));
    }

    /// Only the name and value may be echoed back. Replaying `Path=/` or
    /// `SameSite=Strict` as part of the value would make the server compute a hash
    /// over a different token than the one stored, and the symptom would be an
    /// unexplained 401 rather than an obvious bug.
    #[test]
    fn request_cookie_keeps_only_name_and_value() {
        let sent = request_cookie("__Host-wafx_account=tok; Path=/; Secure; Same-Age=1; Max-Age=99")
            .unwrap();
        assert_eq!(sent, "__Host-wafx_account=tok");
        assert!(!sent.contains("Path"));
        assert!(!sent.contains("Max-Age"));
    }

    #[test]
    fn extract_picks_the_session_cookie_out_of_several() {
        let headers = vec![
            "other=1; Path=/".to_string(),
            "__Host-wafx_account=tok; Path=/; Secure; Max-Age=86400".to_string(),
        ];
        assert_eq!(extract_session_cookie(&headers).unwrap(), headers[1]);
        assert!(extract_session_cookie(&["x=1".to_string()]).is_none());
        assert!(extract_session_cookie(&[]).is_none());
    }

    /// 401 and 403 must stay indistinguishable, or the enumeration oracle the API
    /// removes comes straight back through this layer.
    #[test]
    fn status_classification_keeps_the_answers_together() {
        assert_eq!(classify(401), Failure::NotSignedIn);
        assert_eq!(classify(403), Failure::NotSignedIn);
        assert_eq!(classify(429), Failure::RateLimited(0));
        assert_eq!(classify(500), Failure::Server);
        assert_eq!(classify(200), Failure::Server);
    }

    /// The account id the API returns is dropped rather than forwarded.
    #[test]
    fn me_body_never_leaks_the_account_id() {
        let body = concat!(
            r#"{"account":{"id":"secret-id","email":"a@example.com","#,
            r#""created_at":"2026-01-01T00:00:00Z","last_login_at":"2026-02-02T00:00:00Z"},"#,
            r#""session":{"expires_in_seconds":3600}}"#,
        );
        let dir = temp_dir_for("me-view");
        let view = remember_account(&dir, body).unwrap();
        assert_eq!(view.email, "a@example.com");
        assert_eq!(view.expires_in_seconds, 3600);
        assert_eq!(view.last_login_at.as_deref(), Some("2026-02-02T00:00:00Z"));

        // The boundary that matters is the whole IPC reply, not the view alone.
        let reply = MeOutcome {
            signed_in: true,
            account: Some(view),
            error: None,
        };
        let wire = serde_json::to_string(&reply).unwrap();
        assert!(!wire.contains("secret-id"), "the IPC payload leaked the id");
        assert!(!wire.contains("\"id\""), "the IPC payload grew an id field");
        // It did reach the sidecar, which is the only place it is allowed.
        assert_eq!(load_account_id(&dir).as_deref(), Some("secret-id"));
    }

    #[test]
    fn a_me_reply_with_no_id_is_refused_and_stores_nothing() {
        // An entitlement binds to an account id. A `/me` that omits it would leave
        // the app unable to tell which account a licence belongs to, and the
        // tempting fallback - "carry on with the old id" - is exactly how one
        // account's Pro would leak to the next.
        let dir = temp_dir_for("me-no-id");
        crate::account::save_account_id(&dir, Some(SIGNED_IN_ID));
        let body = r#"{"account":{"email":"a@example.com"},"session":{"expires_in_seconds":60}}"#;
        assert!(remember_account(&dir, body).is_err());
        assert_eq!(
            load_account_id(&dir).as_deref(),
            Some(SIGNED_IN_ID),
            "a failed parse must leave the previous id alone rather than clear it"
        );
        assert_eq!(account_id_of(body), None);
    }

    #[test]
    fn an_empty_id_is_refused_rather_than_written_as_a_wildcard() {
        let body = r#"{"account":{"id":"   ","email":"a@example.com"},"session":{"expires_in_seconds":60}}"#;
        assert_eq!(account_id_of(body), None);
    }

    #[test]
    fn the_account_id_sidecar_round_trips_and_forgets() {
        let dir = temp_dir_for("account-id");
        assert_eq!(load_account_id(&dir), None, "precondition: nothing stored");

        save_account_id(&dir, Some(SIGNED_IN_ID));
        assert_eq!(load_account_id(&dir).as_deref(), Some(SIGNED_IN_ID));

        // Whitespace is trimmed, so a file written with a stray newline - which
        // is what a text editor would do - still binds to the right account.
        save_account_id(&dir, Some(&format!("{SIGNED_IN_ID}\n")));
        assert_eq!(load_account_id(&dir).as_deref(), Some(SIGNED_IN_ID));

        save_account_id(&dir, None);
        assert_eq!(load_account_id(&dir), None);
        // Deleting an absent file is not an error.
        save_account_id(&dir, None);
        assert_eq!(load_account_id(&dir), None);
    }

    #[test]
    fn signing_out_forgets_the_session_and_the_account_id_together() {
        // Two files, one meaning. If only one of them is cleared, an install can
        // hold an account id for an account nobody is signed in as - and an id on
        // its own is exactly what a cached entitlement gets bound to.
        let dir = temp_dir_for("forget");
        save_account_id(&dir, Some(SIGNED_IN_ID));
        assert_eq!(load_account_id(&dir).as_deref(), Some(SIGNED_IN_ID));

        forget_account(&dir);
        assert_eq!(load_account_id(&dir), None, "the id must go with the session");
        assert_eq!(load_session(&dir), None, "and so must the cookie");
        // Idempotent, because logout can be pressed twice and a failure here would
        // turn a second press into an error the user sees.
        forget_account(&dir);
        assert_eq!(load_account_id(&dir), None);
    }

    #[test]
    fn a_blank_or_absurd_account_id_is_treated_as_signed_out() {
        let dir = temp_dir_for("account-id-junk");
        for junk in ["", "   ", "\n\t"] {
            save_account_id(&dir, Some(junk));
            assert_eq!(load_account_id(&dir), None, "`{junk}` must not be an id");
        }
        std::fs::write(dir.join(ACCOUNT_ID_FILE), "x".repeat(4096)).unwrap();
        assert_eq!(load_account_id(&dir), None, "an implausibly long id is junk");
    }

    #[test]
    fn the_account_id_sidecar_holds_no_session_token() {
        // The sidecar is plain text because it is not a secret. If a cookie ever
        // ended up in it, that reasoning would stop holding - so assert the file
        // holds one identifier and nothing else.
        let dir = temp_dir_for("account-id-contents");
        save_account_id(&dir, Some(SIGNED_IN_ID));
        let contents = std::fs::read_to_string(dir.join(ACCOUNT_ID_FILE)).unwrap();
        assert_eq!(contents, SIGNED_IN_ID);
        assert!(!contents.contains("="), "a name=value pair would be a cookie");
        assert!(!contents.contains("__Host-"));
    }

    #[test]
    fn a_null_last_login_is_not_an_error() {
        let view = parse_me_with_id(
            r#"{"account":{"id":"acct-1","email":"a@example.com","last_login_at":null},"session":{"expires_in_seconds":1}}"#,
        )
        .unwrap()
        .0;
        assert!(view.last_login_at.is_none());
    }

    #[test]
    fn a_reply_with_no_address_is_refused() {
        let with_id = |email: &str| {
            format!(
                r#"{{"account":{{"id":"acct-1","email":"{email}"}},"session":{{"expires_in_seconds":1}}}}"#
            )
        };
        assert!(parse_me_with_id(&with_id("")).is_err());
        assert!(parse_me_with_id(&with_id("  ")).is_err());
        assert!(parse_me_with_id("not json").is_err());
        assert!(parse_me_with_id(r#"{"session":{"expires_in_seconds":1}}"#).is_err());
        // The id is mandatory now, so an otherwise perfect reply without one is
        // still a refusal - see `a_me_reply_with_no_id_is_refused_and_stores_nothing`.
        assert!(parse_me_with_id(
            r#"{"account":{"email":"a@example.com"},"session":{"expires_in_seconds":1}}"#
        )
        .is_err());
    }

    /// An error body is used only when it carries both a code and a message. A
    /// message without a code is not this API's shape, and rendering it anyway
    /// would put an arbitrary string in front of the user.
    #[test]
    fn api_message_needs_a_code_and_a_message() {
        assert_eq!(
            api_message(r#"{"error":{"code":"unauthorized","message":"Invalid email or password"}}"#)
                .as_deref(),
            Some("Invalid email or password")
        );
        assert_eq!(api_message(r#"{"error":{"message":"x"}}"#), None);
        assert_eq!(api_message(r#"{"error":{"code":"x","message":"  "}}"#), None);
        assert_eq!(api_message("nonsense"), None);
        assert_eq!(api_message(""), None);
    }

    #[test]
    fn retry_after_reads_only_the_numeric_form() {
        assert_eq!(retry_after_seconds(Some("120")), Some(120));
        assert_eq!(
            retry_after_seconds(Some("Wed, 21 Oct 2026 07:28:00 GMT")),
            None
        );
        assert_eq!(retry_after_seconds(Some("-5")), None);
        assert_eq!(retry_after_seconds(None), None);
    }

    #[test]
    fn urlencode_escapes_what_would_change_the_meaning() {
        assert_eq!(urlencode("a+b@example.com"), "a%2Bb%40example.com");
        // `@` is escaped rather than left bare. Both forms decode to the same
        // address, and escaping is the conservative one.
        assert_eq!(urlencode("plain@example.com"), "plain%40example.com");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencode("two words"), "two+words");
    }

    /// The declared Origin must be a bare origin. `origin()` in
    /// `wafx-api/src/env.ts:153` rejects a path and the whole request answers 403,
    /// so a trailing slash here would break every call in a way that looks like a
    /// network fault.
    #[test]
    fn origin_is_a_bare_origin() {
        assert_eq!(
            origin_of("https://wafx-api.wafinbl2021.workers.dev"),
            "https://wafx-api.wafinbl2021.workers.dev"
        );
        assert_eq!(origin_of("https://api.example/"), "https://api.example");
        assert_eq!(origin_of("https://api.example///"), "https://api.example");
        assert!(!origin_of("https://api.example/").ends_with('/'));
    }

    

    /// The API's default iteration count must stay affordable. 600,000 rounds of
    /// hand-rolled HMAC-SHA256 is the figure the admin panel uses; if this client
    /// were materially slower, every sign-in would look like a hang.
    #[test]
    fn the_default_iteration_count_completes() {
        let start = std::time::Instant::now();
        let verifier = derive_verifier("correct horse battery staple", "abcd", 600_000);
        assert_eq!(verifier.len(), 64);
        // Generous on purpose: this guards against an accidental 100x regression,
        // not against being fast. It must not take minutes.
        assert!(
            start.elapsed() < std::time::Duration::from_secs(20),
            "600,000 iterations took {:?}, which would make sign-in feel broken",
            start.elapsed()
        );
    }
}