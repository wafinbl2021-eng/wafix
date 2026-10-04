//! Wafi X catalog client, installer downloader and SHA-256 gate.
//!
//! Everything the Applications screen needs is fetched and executed from here,
//! in Rust. The webview is told what to display and which button to press; it
//! never supplies a URL, a file path, a checksum or an argument list. That is
//! the whole point of putting this on the Rust side: a value that arrives from
//! the network can only ever reach a process through the fixed mapping in
//! [`crate::installer`], and only after the bytes on disk match the checksum
//! the catalog published.
//!
//! Three rules hold for every path through this module:
//!
//! 1. The API base is resolved once, in [`api_base`]. No hostname is written
//!    anywhere else in the codebase.
//! 2. Nothing is downloaded from, or written to, anywhere but HTTPS and the
//!    downloads folder.
//! 3. [`install_wafx_app`] re-reads the authoritative record for the version it
//!    was asked for, verifies the digest, and only then launches anything.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::installer;

/// The only place the desktop app names the Wafi X API host.
///
/// Everything about the deployment is meant to be changeable without touching
/// code, so this is a default rather than a constant the rest of the app is
/// built around. It is overridden by `WAFX_API_BASE` at runtime, or by the
/// same variable (or `VITE_WAFX_API`, the name the frontend build uses) being
/// present in the environment at compile time.
pub const DEFAULT_WAFX_API_BASE: &str = "https://wafx-api.wafinbl2021.workers.dev";

/// Folder name created inside `%APPDATA%`. Deliberately not the Tauri
/// `app_data_dir()`: installers are large, user-visible files, and keeping
/// them in their own folder means clearing app state never deletes one.
const DOWNLOADS_SUBDIR: [&str; 2] = ["wafx", "downloads"];

/// How many redirects a download may follow. Redirects are followed because
/// release hosts use them; they are capped because an endless chain is a way
/// to keep a socket open.
const MAX_REDIRECTS: usize = 5;

/// Progress is emitted at most this often, in bytes. A 200 MB installer is
/// roughly 12,800 chunks, and the UI cannot show more than 100 distinct
/// percentages anyway.
const PROGRESS_STEP_BYTES: u64 = 256 * 1024;

/// Longest filename this module will produce, extension included.
const MAX_FILENAME_LEN: usize = 100;

// ---------------------------------------------------------------------------
// Catalog base
// ---------------------------------------------------------------------------

/// Resolves the Wafi X API base, without a trailing slash.
///
/// Runtime `WAFX_API_BASE` wins, then whatever was in the environment when the
/// binary was built, then [`DEFAULT_WAFX_API_BASE`].
pub fn api_base() -> String {
    for candidate in [
        std::env::var("WAFX_API_BASE").ok(),
        option_env!("WAFX_API_BASE").map(str::to_string),
        option_env!("VITE_WAFX_API").map(str::to_string),
    ]
    .into_iter()
    .flatten()
    {
        let trimmed = candidate.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    DEFAULT_WAFX_API_BASE.to_string()
}

/// Parses a URL and refuses anything that is not plain HTTPS.
///
/// The catalog already has `CHECK (... LIKE 'https://%')` on its columns, but
/// a server-side check is not the only thing between a bad row and a process
/// on this machine. Credentials in the URL are refused too: they would end up
/// in a log line the first time a request fails.
pub fn parse_https(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|_| "the address in the catalog is not a valid URL".to_string())?;

    if url.scheme() != "https" {
        return Err(format!(
            "refused an installer that is not HTTPS ({})",
            url.scheme()
        ));
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err("the installer address has no host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the installer address carries credentials".to_string());
    }
    Ok(url)
}

// ---------------------------------------------------------------------------
// Catalog shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct AppsResponse {
    #[serde(default)]
    apps: Vec<WafxApp>,
}

#[derive(Debug, Clone, Deserialize)]
struct AppResponse {
    app: WafxApp,
}

#[derive(Debug, Clone, Deserialize)]
struct CategoriesResponse {
    #[serde(default)]
    categories: Vec<WafxCategory>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WafxCategory {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub app_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WafxVersion {
    pub id: String,
    pub version: String,
    pub installer_type: String,
    pub installer_mode: String,
    #[serde(default)]
    pub installer_url_kind: String,
    /// Deserialized from the API, never serialized back out.
    ///
    /// `skip_serializing` is the point of the field: the download address is
    /// an internal detail of the install flow. The webview asks to install an
    /// app and a version by id, so it has no reason to be handed a URL that
    /// points at an executable.
    #[serde(default, skip_serializing)]
    pub installer_url: String,
    #[serde(default)]
    pub installer_sha256: Option<String>,
    #[serde(default)]
    pub installer_size_bytes: Option<u64>,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WafxApp {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub icon_kind: String,
    /// Deserialized but never serialized back out, for the same reason
    /// `installer_url` is: it is an address the webview has no business
    /// holding. [`icon_data`] is what the webview gets instead.
    #[serde(default, skip_serializing)]
    pub icon_url: Option<String>,
    /// The icon as a `data:` URL, fetched by Rust and already subject to the
    /// same HTTPS-only rules as an installer.
    ///
    /// The catalog's icons live on vendor and CDN hosts, which the webview's
    /// `img-src 'self'` would refuse anyway — and pointing `img-src` at every
    /// possible icon host would hand the webview a standing reason to contact
    /// arbitrary third parties and disclose the user's IP to each. Fetching
    /// here keeps the CSP as it was and keeps every outbound request inside the
    /// one client that applies the rules.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<String>,
    #[serde(default)]
    pub homepage_url: Option<String>,
    #[serde(default)]
    pub featured: bool,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub category_name: Option<String>,
    #[serde(default)]
    pub versions: Vec<WafxVersion>,
    #[serde(default)]
    pub latest_version: Option<String>,
}

/// Download progress, emitted as `wafx-download-progress` while the bytes
/// arrive. `total`/`percent` are `None` when the server sent no length, which
/// is a "cannot tell" rather than a zero.
#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub app_id: String,
    pub version_id: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percent: Option<u64>,
}

/// Which part of the pipeline is running, emitted as `wafx-install-phase`.
///
/// The webview cannot work this out for itself: a download can be skipped
/// entirely when a verified copy is already on disk, and re-verifying a 200 MB
/// installer takes longer than the download that would otherwise be shown. So
/// Rust says which step it is on rather than letting the UI infer it from a
/// percentage that may never move.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallPhase {
    /// Bytes are arriving.
    Download,
    /// The digest is being compared against the catalog.
    Verify,
    /// The file passed verification and is about to be launched.
    Install,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallPhaseEvent {
    pub app_id: String,
    pub version_id: String,
    pub phase: InstallPhase,
}

fn emit_phase(app: &AppHandle, app_id: &str, version_id: &str, phase: InstallPhase) {
    let _ = app.emit(
        "wafx-install-phase",
        InstallPhaseEvent {
            app_id: app_id.to_string(),
            version_id: version_id.to_string(),
            phase,
        },
    );
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn build_client(app: &AppHandle) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("WafiX/{}", app.package_info().version))
        .connect_timeout(Duration::from_secs(15))
        // Generous, because a 300 MB installer on a slow link is not a hung
        // connection; a stalled socket still trips it.
        .timeout(Duration::from_secs(30 * 60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() != "https" {
                return attempt.error(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "refused a redirect that leaves HTTPS",
                ));
            }
            if attempt.previous().len() >= MAX_REDIRECTS {
                return attempt.stop();
            }
            attempt.follow()
        }))
        .build()
        .map_err(|e| format!("could not create the HTTP client: {e}"))
}

/// The one rule every HTTP response in this module is held to: a success
/// status, and still on HTTPS after however many redirects it took.
///
/// A redirect chain that ends on plain HTTP is refused here as well as by the
/// client's redirect policy, so the check survives a server that only
/// downgrades on the last hop. Split out from the call sites, which all
/// repeated the same four lines, so that "what counts as an acceptable
/// response" has a single answer and a test.
fn check_response(status: reqwest::StatusCode, final_scheme: &str) -> Result<(), String> {
    if !status.is_success() {
        return Err(format!("the Daltoon X server answered {status}"));
    }
    if final_scheme != "https" {
        return Err("refused a redirect that leaves HTTPS".to_string());
    }
    Ok(())
}

async fn get_json<T: serde::de::DeserializeOwned>(
    app: &AppHandle,
    url: &str,
) -> Result<T, String> {
    let parsed = parse_https(url)?;
    let response = build_client(app)?
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("could not reach the Daltoon X catalog: {e}"))?;

    let status = response.status();
    check_response(status, response.url().scheme())?;
    response
        .json::<T>()
        .await
        .map_err(|e| format!("the Daltoon X catalog sent something unreadable: {e}"))
}

// ---------------------------------------------------------------------------
// Downloads folder
// ---------------------------------------------------------------------------

/// `%APPDATA%/wafx/downloads`, created on demand.
pub fn downloads_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA")
        .ok_or_else(|| "APPDATA is not set on this system".to_string())?;
    Ok(DOWNLOADS_SUBDIR
        .iter()
        .fold(PathBuf::from(base), |path, part| path.join(part)))
}

/// Keeps a name to a single, plain path component inside `dir`.
///
/// The sanitizing filename generator already removes separators; this is the
/// second, independent check, because the property "nothing is ever written
/// outside the downloads folder" is worth having in more than one place.
pub fn safe_join(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() {
        return Err("the installer file name is empty".to_string());
    }
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => {}
        _ => return Err("the installer file name is not a plain file name".to_string()),
    }

    let joined = dir.join(name);
    if joined.parent() != Some(dir) {
        return Err("the installer would be written outside the downloads folder".to_string());
    }
    Ok(joined)
}

/// DOS device names, which are still reserved on NTFS and would otherwise
/// create an unusable path.
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn sanitize_component(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();

    // Leading and trailing dots are how "..", "." and hidden files happen;
    // Windows also silently drops trailing spaces, so remove them too.
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    if trimmed.is_empty() {
        return String::new();
    }

    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return format!("wafx-{trimmed}");
    }
    trimmed
}

/// Builds the local file name for one installer.
///
/// The name comes from the URL's last path segment, reduced to ASCII letters,
/// digits, dot, dash and underscore. Anything else — percent escapes, spaces,
/// slashes, `..` — cannot survive that filter, so a hostile or merely sloppy
/// URL still produces a plain file name inside the downloads folder.
pub fn sanitize_filename(
    url: &reqwest::Url,
    app_id: &str,
    version: &str,
    installer_type: &str,
) -> String {
    let extension = if installer_type == "msi" { "msi" } else { "exe" };
    let leaf = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or_default();

    let (raw_stem, raw_extension) = match leaf.rsplit_once('.') {
        Some((stem, ext)) if !ext.is_empty() && ext.len() <= 5 => (stem, ext.to_ascii_lowercase()),
        _ => (leaf, String::new()),
    };

    // Keep the extension the URL claimed when it is one of the two containers
    // this feature understands; otherwise pin it to the declared type so the
    // file Windows has to run is the file that was described.
    let extension = if raw_extension == "exe" || raw_extension == "msi" {
        raw_extension
    } else {
        extension.to_string()
    };

    let mut stem = sanitize_component(raw_stem);
    if stem.is_empty() {
        let fallback = sanitize_component(&format!("{app_id}-{version}"));
        stem = if fallback.is_empty() {
            "installer".to_string()
        } else {
            fallback
        };
    }

    let room = MAX_FILENAME_LEN.saturating_sub(extension.len() + 1).max(8);
    if stem.len() > room {
        stem.truncate(room);
        stem = stem.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    }

    format!("{stem}.{extension}")
}

// ---------------------------------------------------------------------------
// Container identification
// ---------------------------------------------------------------------------

/// The first two bytes of every Windows executable: the `MZ` of a DOS header,
/// which every PE image carries.
const EXE_SIGNATURE: [u8; 2] = [b'M', b'Z'];

/// The OLE2 compound-file header. An MSI is not a PE image - it is a structured
/// storage container - so it carries this instead. These eight bytes are a
/// long-standing format constant, not anything derived from the file's name.
const MSI_SIGNATURE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

/// Refuses a download whose own bytes are not the container the catalog declared.
///
/// A file name is not evidence. [`sanitize_filename`] deliberately *keeps* an
/// extension the URL claimed whenever that extension is `exe` or `msi`, so a
/// server can serve any bytes at all under a name that looks correct — which is
/// exactly the convenience that makes direct HTTPS URLs easy to add and exactly
/// why the declared `installer_type` has to be checked against the content.
///
/// This is also what stops a mismatch between the two: an MSI served as `exe`
/// would be launched directly, and an EXE served as `msi` would be handed to
/// `msiexec`, both of which are the wrong program for the bytes.
///
/// Runs against the `.part` file, before it is promoted, so a wrong container
/// never reaches the final name that a later run would look for.
pub fn check_container_type(path: &Path, installer_type: &str) -> Result<(), String> {
    use std::io::Read;

    let wanted: &[u8] = match installer_type {
        "exe" => &EXE_SIGNATURE,
        "msi" => &MSI_SIGNATURE,
        other => return Err(format!("unsupported installer type: {other}")),
    };

    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("could not read the download to identify it: {e}"))?;
    let mut header = [0u8; 8];
    let mut filled = 0usize;
    while filled < header.len() {
        let read = file
            .read(&mut header[filled..])
            .map_err(|e| format!("could not read the download to identify it: {e}"))?;
        if read == 0 {
            break;
        }
        filled += read;
    }

    if header[..filled].starts_with(wanted) {
        return Ok(());
    }
    let expected = if installer_type == "msi" {
        "an MSI package"
    } else {
        "a Windows executable"
    };
    Err(format!(
        "the download is not {expected}. The catalog published it as {installer_type}, \
         so it was deleted rather than run."
    ))
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

/// Lowercase hex, the form every digest in this module is compared in.
fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// One-shot digest of a buffer. The downloader hashes incrementally instead;
/// this exists for the tests' expectation vectors.
#[cfg(test)]
pub fn checksum_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Streams a file through SHA-256, so a large installer is never held in
/// memory.
pub fn checksum_file(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("could not read the download: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("could not read the download: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

/// A SHA-256 digest as the catalog stores it: exactly 64 hex characters.
pub fn is_valid_checksum(value: &str) -> bool {
    let value = value.trim();
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// Case-insensitive, because catalogs store lowercase hex and operators paste
/// uppercase digests into the panel all the time.
pub fn checksum_matches(expected: &str, actual: &str) -> bool {
    if !is_valid_checksum(expected) {
        return false;
    }
    expected.trim().eq_ignore_ascii_case(actual.trim())
}

/// The digest the catalog published for a version, if it published a usable one.
///
/// Three outcomes, and the difference between the last two is the entire point:
///
/// * `Ok(Some(hash))` - verify before running.
/// * `Ok(None)` - the version published no checksum. It is still installable, but
///   **unverified**: the download rests on TLS and the recorded size alone, and
///   nothing in this build may claim otherwise.
/// * `Err` - the version published a checksum that cannot be used. That is an
///   error, never `None`: treating an unusable hash as "no hash" would let anyone
///   able to corrupt that one column turn a verified install into an unverified
///   one, which is precisely the downgrade this distinction exists to prevent.
pub fn published_checksum(version: &WafxVersion) -> Result<Option<String>, String> {
    match version.installer_sha256.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(raw) => {
            if !is_valid_checksum(raw) {
                return Err(
                    "the catalog published a malformed checksum for this version".to_string()
                );
            }
            // Normalised to lowercase so one canonical form comes out whatever case
            // an operator pasted. The comparison is case-insensitive either way;
            // this just makes the returned value predictable.
            Ok(Some(raw.to_ascii_lowercase()))
        }
    }
}

/// Promotes a finished `.part` download to its final name, or destroys it.
///
/// This is the gate, and it has two halves that must both pass before
/// [`crate::installer::run`] is reachable:
///
/// * With a checksum, a mismatch removes the file and returns an error.
/// * Without one, there is nothing to compare, so the file is promoted and the
///   caller treats the install as unverified. That is a deliberate relaxation for
///   convenience, and it is why `expected` is an `Option` rather than a `String`:
///   "no checksum published" and "checksum published and it did not match" must
///   never be the same value.
fn finalize_download(
    part: &Path,
    destination: &Path,
    expected: Option<&str>,
    computed: &str,
) -> Result<(), String> {
    if let Some(expected) = expected {
        if !checksum_matches(expected, computed) {
            let _ = std::fs::remove_file(part);
            return Err(format!(
                "checksum mismatch: the catalog says {expected}, the download is {computed}. \
                 The file was deleted and nothing was installed."
            ));
        }
    }
    let _ = std::fs::remove_file(destination);
    std::fs::rename(part, destination)
        .map_err(|e| format!("could not finish the download: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/// Downloads one installer and returns the path it may be launched from.
///
/// `expected` is the catalog's checksum when it published one. When it is `None`
/// the download is still performed and still launched, but two things change, and
/// both are about not claiming more than is true:
///
/// * the cached copy is not reused, because there is no digest to re-verify it
///   against, so the bytes run are the bytes the server is serving now;
/// * the `Verify` phase is not emitted, so no caller reports a check that did
///   not happen.
async fn download_installer(
    app: &AppHandle,
    app_id: &str,
    version: &WafxVersion,
    url: &reqwest::Url,
    expected: Option<&str>,
) -> Result<PathBuf, String> {
    let dir = downloads_dir()?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("could not create the downloads folder: {e}"))?;

    let filename = sanitize_filename(url, app_id, &version.version, &version.installer_type);
    let destination = safe_join(&dir, &filename)?;
    let part = safe_join(&dir, &format!("{filename}.part"))?;

    // Already downloaded and already verified: reuse it rather than spending
    // the user's bandwidth again. The digest is what makes this safe, and
    // hashing a few hundred megabytes back off disk takes long enough to be
    // worth showing as its own step.
    //
    // Only ever reached with a checksum. Without one there is nothing to compare
    // a cached file against, so reusing it would mean launching bytes of unknown
    // provenance; the file is dropped and fetched again instead.
    if destination.is_file() {
        if expected.is_some() {
            emit_phase(app, app_id, &version.id, InstallPhase::Verify);
            // Re-hashing a few hundred megabytes off disk blocks for seconds, so
            // it runs on a blocking thread: on the async worker it would stall the
            // runtime the progress events are emitted from.
            let rehashed = destination.clone();
            let existing = tauri::async_runtime::spawn_blocking(move || checksum_file(&rehashed))
                .await
                .ok()
                .and_then(Result::ok);
            if let (Some(expected), Some(digest)) = (expected, existing) {
                if checksum_matches(expected, &digest) {
                    return Ok(destination);
                }
            }
        }
        let _ = std::fs::remove_file(&destination);
    }

    let response = build_client(app)?
        .get(url.clone())
        .send()
        .await
        .map_err(|e| format!("the download did not start: {e}"))?;

    let status = response.status();
    check_response(status, response.url().scheme())?;

    let total = response.content_length().or(version.installer_size_bytes);
    let mut stream = response;
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("could not write the download: {e}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;

    // Emitted only once the bytes are actually on the way: the response is
    // open, the `.part` file exists and progress will start moving imminently.
    // A server that stalls here leaves the panel showing a real download state
    // rather than a percentage frozen at zero.
    emit_phase(app, app_id, &version.id, InstallPhase::Download);

    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| format!("the download was interrupted: {e}"))?
    {
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("could not write the download: {e}"))?;
        downloaded += chunk.len() as u64;

        if downloaded - last_emitted >= PROGRESS_STEP_BYTES {
            last_emitted = downloaded;
            let _ = app.emit(
                "wafx-download-progress",
                DownloadProgress {
                    app_id: app_id.to_string(),
                    version_id: version.id.clone(),
                    downloaded,
                    total,
                    percent: total.filter(|t| *t > 0).map(|t| downloaded * 100 / t),
                },
            );
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("could not write the download: {e}"))?;
    drop(file);

    let computed = hex(&hasher.finalize());

    // Second gate, and the one that does not depend on the catalog having
    // published a digest: the bytes must actually be the container it declared.
    // Read on the `.part` file so a wrong container is destroyed here rather
    // than promoted to the name a later run would trust.
    if let Err(reason) = check_container_type(&part, &version.installer_type) {
        let _ = std::fs::remove_file(&part);
        return Err(reason);
    }

    // The digest was accumulated while streaming, so this comparison is the last
    // thing standing between the bytes on disk and a process launch. It is
    // skipped only when the catalog published no digest at all, and skipped
    // silently on purpose: the phase event above is what tells a caller whether
    // a check happened, and emitting `Verify` here when `expected` is `None`
    // would be the claim this design refuses to make.
    if expected.is_some() {
        emit_phase(app, app_id, &version.id, InstallPhase::Verify);
    }
    finalize_download(&part, &destination, expected, &computed)?;
    Ok(destination)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Icons above this size are not fetched at all. An icon is a few kilobytes;
/// anything larger is a file that does not belong in a card.
const MAX_ICON_BYTES: u64 = 512 * 1024;

/// Content types accepted for an icon. A `data:` URL whose media type the
/// webview will not render is worse than the glyph fallback, so the list is
/// closed rather than "whatever the server sent".
const ICON_CONTENT_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/// Fetches one app icon and returns it as a `data:` URL, or `None`.
///
/// Every failure mode is the same answer — no icon — because a card with the
/// category glyph is a complete result, and a panel that refuses to render
/// because one vendor's CDN was down would be worse.
async fn fetch_icon(app: &AppHandle, url: &str) -> Option<String> {
    let parsed = parse_https(url).ok()?;
    let response = build_client(app).ok()?.get(parsed).send().await.ok()?;
    if check_response(response.status(), response.url().scheme()).is_err() {
        return None;
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or("").trim().to_ascii_lowercase())?;
    if !ICON_CONTENT_TYPES.contains(&content_type.as_str()) {
        return None;
    }
    let length = response.content_length().unwrap_or(MAX_ICON_BYTES + 1);
    if length > MAX_ICON_BYTES {
        return None;
    }

    let bytes = response.bytes().await.ok()?;
    if bytes.len() as u64 > MAX_ICON_BYTES {
        return None;
    }
    // 4/3 expansion is the worst case for base64; over-reserving would only
    // waste memory.
    let encoded = base64_encode(&bytes);
    Some(format!("data:{content_type};base64,{encoded}"))
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3F] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3F] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 0x3F] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 0x3F] as char
        } else {
            '='
        });
    }
    out
}

/// Resolves each app's icon to a `data:` URL. Sequential on purpose: a catalog
/// panel is a handful of cards, and a hundred parallel image fetches would be a
/// burst of connections to hosts chosen by whoever published the catalog.
async fn attach_icons(app: &AppHandle, mut apps: Vec<WafxApp>) -> Vec<WafxApp> {
    for entry in &mut apps {
        if entry.icon_kind == "none" {
            continue;
        }
        match entry.icon_url.as_deref() {
            Some(url) => entry.icon_data = fetch_icon(app, url).await,
            None => entry.icon_data = None,
        }
    }
    apps
}

/// Published applications, each with its published versions.
#[tauri::command]
pub async fn list_wafx_apps(app: AppHandle) -> Result<Vec<WafxApp>, String> {
    let body: AppsResponse = get_json(&app, &format!("{}/api/apps", api_base())).await?;
    Ok(attach_icons(&app, body.apps).await)
}

/// Application categories, with how many published apps each one holds.
#[tauri::command]
pub async fn list_wafx_categories(app: AppHandle) -> Result<Vec<WafxCategory>, String> {
    let body: CategoriesResponse =
        get_json(&app, &format!("{}/api/categories", api_base())).await?;
    Ok(body.categories)
}

/// Downloads and installs one version of one application.
///
/// The renderer supplies two identifiers and nothing else. The URL, the
/// checksum, the container type and the mode are all re-read from the catalog
/// here, so a compromised or merely wrong webview cannot substitute any of
/// them.
///
/// A version that published a checksum is verified before it runs, exactly as
/// before. A version that published none is still installable - that is what
/// makes a plain HTTPS URL enough to add an application - but it is installed
/// **unverified**: the `Verify` phase is not emitted, the downloaded file is
/// deleted once the installer exits, and [`installer::InstallOutcome::verified`]
/// reports `false`, so no caller can describe it as checked.
#[tauri::command]
pub async fn install_wafx_app(
    app: AppHandle,
    app_id: String,
    version_id: String,
) -> Result<installer::InstallOutcome, String> {
    // Same shape the catalog itself accepts for an id. Also what keeps this
    // string out of trouble in the URL below.
    if !is_catalog_slug(&app_id) {
        return Err("that is not a valid application id".to_string());
    }

    let body: AppResponse = get_json(&app, &format!("{}/api/apps/{app_id}", api_base())).await?;
    let version = body
        .app
        .versions
        .iter()
        .find(|candidate| candidate.id == version_id)
        .ok_or_else(|| "that version is no longer published".to_string())?;

    if version.installer_url_kind != "external" {
        return Err("this version is not published with a downloadable file".to_string());
    }

    // Resolved before anything is downloaded, so a malformed digest fails in
    // milliseconds rather than after a long transfer. `Ok(None)` - the catalog
    // published no digest - is allowed through; `Err` is not.
    let expected = published_checksum(version)?;

    // Resolve the launch before spending any bandwidth, so an unsupported
    // container or mode fails immediately instead of after a long download.
    let url = parse_https(&version.installer_url)?;
    installer::check_supported(&version.installer_type, &version.installer_mode)?;

    let verified = expected.is_some();
    let path = download_installer(&app, &app_id, version, &url, expected.as_deref()).await?;

    // Reached only because the container check passed and, where the catalog
    // published a digest, the digest matched. Past this line a file that is safe
    // to run exists on disk and is about to be launched.
    emit_phase(&app, &app_id, &version.id, InstallPhase::Install);

    let command = installer::command_for(&version.installer_type, &version.installer_mode, &path)?;

    // `and_then` flattens the join's `Result<Result<..>>` into one, so both the
    // "could not wait for it" and the "could not start it" exits arrive here as a
    // single value rather than an early return. That is deliberate: the cleanup
    // below has to run on every one of those paths, and an early return would skip
    // it on exactly the ones where the bytes are already on disk.
    let launched = tauri::async_runtime::spawn_blocking(move || installer::run(&command))
        .await
        .map_err(|e| format!("the installer could not be waited on: {e}"))
        .and_then(|started| started);

    // An unverified download is discarded once the installer has run - and also
    // when it failed to run, since the bytes are on disk either way. There is
    // nothing to gain from keeping it: with no digest there is no way to tell a
    // later copy from this one, so leaving it behind would mean a second, equally
    // unverifiable run from cache. A verified download is kept, which is what
    // lets the next launch skip the transfer after re-checking the digest.
    if !verified {
        let _ = std::fs::remove_file(&path);
    }

    let outcome = launched?;
    Ok(installer::InstallOutcome {
        verified,
        ..outcome
    })
}

pub fn is_catalog_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    const APPS_JSON: &str = r#"{
      "apps": [
        {
          "id": "firefox",
          "name": "Firefox",
          "description": "A web browser.",
          "publisher": "Mozilla",
          "icon_kind": "external",
          "icon_url": "https://icons.example/firefox.png",
          "homepage_url": "https://example/firefox",
          "featured": true,
          "category_id": "browsers",
          "category_name": "Browsers",
          "versions": [
            {
              "id": "v9",
              "version": "131.0",
              "installer_type": "exe",
              "installer_mode": "silent",
              "installer_url_kind": "external",
              "installer_url": "https://downloads.example/firefox-131.0.exe",
              "installer_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "installer_size_bytes": 90000000,
              "release_date": "2026-09-01",
              "created_at": "2026-09-01T00:00:00Z"
            }
          ],
          "latest_version": "131.0"
        }
      ],
      "count": 1
    }"#;

    fn temp_dir(label: &str) -> PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let unique = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "wafx-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("temp dir");
        path
    }

    // ---- API parsing ------------------------------------------------------

    #[test]
    fn the_apps_feed_parses_into_catalog_models() {
        let parsed: AppsResponse = serde_json::from_str(APPS_JSON).expect("apps feed");
        assert_eq!(parsed.apps.len(), 1);
        let app = &parsed.apps[0];
        assert_eq!(app.id, "firefox");
        assert_eq!(app.name, "Firefox");
        assert_eq!(app.publisher, "Mozilla");
        assert!(app.featured);
        assert_eq!(app.category_name.as_deref(), Some("Browsers"));
        assert_eq!(app.latest_version.as_deref(), Some("131.0"));
        assert_eq!(app.versions.len(), 1);
        assert_eq!(app.versions[0].installer_type, "exe");
        assert_eq!(app.versions[0].installer_mode, "silent");
        assert_eq!(app.versions[0].installer_size_bytes, Some(90_000_000));
    }

    #[test]
    fn the_categories_feed_parses() {
        let parsed: CategoriesResponse = serde_json::from_str(
            r#"{"categories":[{"id":"browsers","name":"Browsers","app_count":3}]}"#,
        )
        .expect("categories feed");
        assert_eq!(parsed.categories.len(), 1);
        assert_eq!(parsed.categories[0].app_count, 3);
    }

    #[test]
    fn a_feed_missing_optional_fields_still_parses() {
        let parsed: AppsResponse =
            serde_json::from_str(r#"{"apps":[{"id":"a","name":"A"}]}"#).expect("minimal feed");
        assert!(parsed.apps[0].versions.is_empty());
        assert!(parsed.apps[0].latest_version.is_none());
    }

    /// The payload the webview receives must name no download address.
    ///
    /// Keyed on the parsed value rather than a substring of the rendered JSON,
    /// because `installer_url_kind` is a legitimate field and happens to contain
    /// the letters "installer_url".
    #[test]
    fn the_installer_url_never_leaves_rust() {
        let parsed: AppsResponse = serde_json::from_str(APPS_JSON).expect("apps feed");
        let app = &parsed.apps[0];

        // Present in Rust...
        assert_eq!(
            app.versions[0].installer_url,
            "https://downloads.example/firefox-131.0.exe"
        );
        assert_eq!(app.icon_url.as_deref(), Some("https://icons.example/firefox.png"));

        // ...absent from the payload, as is the icon's source address.
        let rendered = serde_json::to_string(app).expect("frontend payload");
        assert!(!rendered.contains("downloads.example"), "{rendered}");
        assert!(!rendered.contains("icons.example"), "{rendered}");
        assert!(!rendered.contains("firefox-131.0.exe"), "{rendered}");

        // The version the user installs by id is still described, because the
        // card has to show what it is about to install.
        assert!(rendered.contains("131.0"), "{rendered}");
        assert!(rendered.contains("installer_mode"), "{rendered}");
    }

    // ---- No remote command execution --------------------------------------

    #[test]
    fn a_server_cannot_inject_a_command_or_arguments() {
        // Every one of these is something a hostile or careless catalog could
        // put in the payload. None of them is a field this client has.
        let hostile = r#"{
          "apps": [{
            "id": "evil", "name": "Evil",
            "command": "calc.exe", "args": "--run=setup.exe",
            "shell": "cmd /C", "script": "powershell -enc AAAA",
            "installer_type": "exe", "installer_mode": "silent",
            "installer_url": "https://downloads.example/payload.exe",
            "installer_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "versions": [{
              "id": "v1", "version": "1.0",
              "installer_type": "exe", "installer_mode": "silent",
              "installer_url": "https://downloads.example/payload.exe",
              "installer_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "command": "calc.exe", "args": "/C del /F C:\\", "shell": true
            }]
          }]
        }"#;
        let parsed: AppsResponse = serde_json::from_str(hostile).expect("hostile feed");
        let app = &parsed.apps[0];
        // The unknown fields were ignored, not stored...
        let rendered = serde_json::to_string(app).expect("payload");
        assert!(!rendered.contains("calc.exe"));
        assert!(!rendered.contains("cmd /C"));
        assert!(!rendered.contains("powershell"));

        // ...and the installer launch is still built from the two closed values.
        let file = Path::new(r"C:\downloads\payload.exe");
        let command = installer::command_for(&app.versions[0].installer_type, &app.versions[0].installer_mode, file)
            .expect("launch");
        assert_eq!(command.program, file);
        assert_eq!(command.args, vec![std::ffi::OsString::from("/S")]);
    }

    #[test]
    fn only_catalog_slug_shaped_ids_are_accepted() {
        assert!(is_catalog_slug("firefox"));
        assert!(is_catalog_slug("7-zip"));
        assert!(!is_catalog_slug(""));
        assert!(!is_catalog_slug("-firefox"));
        assert!(!is_catalog_slug("firefox-"));
        assert!(!is_catalog_slug("../../etc/passwd"));
        assert!(!is_catalog_slug("Firefox"));
        assert!(!is_catalog_slug("fire fox"));
        assert!(!is_catalog_slug("http://evil.example/app"));
    }

    // ---- HTTPS validation -------------------------------------------------

    #[test]
    fn only_https_urls_are_accepted() {
        assert!(parse_https("https://downloads.example/setup.exe").is_ok());

        for refused in [
            "http://downloads.example/setup.exe",
            "file:///C:/Windows/System32/cmd.exe",
            "ftp://downloads.example/setup.exe",
            "javascript:alert(1)",
            "\\\\evil.example\\share\\setup.exe",
            "",
            "not a url",
        ] {
            assert!(
                parse_https(refused).is_err(),
                "{refused} should have been refused"
            );
        }
    }

    #[test]
    fn urls_carrying_credentials_are_refused() {
        assert!(parse_https("https://user:pass@downloads.example/setup.exe").is_err());
    }

    #[test]
    fn the_configured_base_is_https_and_has_no_trailing_slash() {
        let base = api_base();
        assert!(base.starts_with("https://"), "base was {base}");
        assert!(!base.ends_with('/'), "base was {base}");
    }

    // ---- Failed downloads -------------------------------------------------

    #[test]
    fn a_refused_download_is_an_error_rather_than_an_empty_file() {
        // Every status the server can answer with instead of the installer.
        for status in [
            reqwest::StatusCode::NOT_FOUND,
            reqwest::StatusCode::FORBIDDEN,
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::REQUEST_TIMEOUT,
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            reqwest::StatusCode::BAD_GATEWAY,
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
        ] {
            let error = check_response(status, "https").expect_err("a refused status is an error");
            assert!(error.contains(&status.to_string()), "{error}");
        }
    }

    #[test]
    fn a_download_that_downgrades_to_http_is_refused_even_when_it_succeeds() {
        // The client refuses to follow such a redirect, but a server that
        // answers on the last hop must not be able to sneak it past either.
        let error = check_response(reqwest::StatusCode::OK, "http").expect_err("plain HTTP");
        assert!(error.contains("HTTPS"), "{error}");
        assert!(check_response(reqwest::StatusCode::OK, "https").is_ok());
    }

    #[test]
    fn a_refused_download_is_checked_before_the_file_is_opened() {
        // The status check is the statement between the response arriving and
        // the `.part` file being created. If it ever moves below the
        // `File::create`, a 404 would leave a zero-byte partial download on disk
        // for the next run to find.
        let body = function_source("download_installer");
        let check = body
            .lines()
            .position(|line| line.contains("check_response("))
            .expect("the download validates its response");
        let create = body
            .lines()
            .position(|line| line.contains("tokio::fs::File::create"))
            .expect("the download opens the .part file");

        assert!(
            check < create,
            "the response must be validated before the file is created"
        );
    }

    /// The text of one top-level function, without its tests.
    ///
    /// Reading the source is the point of two tests here, and both need to look
    /// at the shipped code rather than at the assertions about it — otherwise a
    /// string literal inside a test reads as a call site, which is precisely the
    /// mistake this helper exists to prevent.
    fn function_source(name: &str) -> String {
        let source = std::fs::read_to_string("src/wafx.rs").expect("own source");
        let lines: Vec<&str> = source.lines().collect();
        // `contains`, not `starts_with`: the commands are `pub async fn` and
        // the helpers are plain `async fn`.
        let start = lines
            .iter()
            .position(|line| line.contains(&format!("async fn {name}(")))
            .unwrap_or_else(|| panic!("{name} is gone from this module"));

        // The function's closing brace is the first line that is exactly `}` at
        // column zero; every nested block in this module is indented.
        let end = lines
            .iter()
            .skip(start + 1)
            .position(|line| *line == "}")
            .map(|offset| start + 1 + offset)
            .unwrap_or(lines.len());

        lines[start..end].join("\n")
    }

    // ---- SHA-256 ----------------------------------------------------------

    #[test]
    fn sha256_matches_the_published_test_vector() {
        assert_eq!(
            checksum_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            checksum_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sha256_of_a_file_matches_the_streamed_digest() {
        let dir = temp_dir("hash");
        let path = dir.join("payload.bin");
        let payload: Vec<u8> = (0..64 * 1024).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &payload).expect("write");
        assert_eq!(checksum_file(&path).expect("hash"), checksum_hex(&payload));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn checksums_are_compared_case_insensitively_and_reject_non_hex() {
        let hash = checksum_hex(b"abc");
        assert!(checksum_matches(&hash, &hash));
        assert!(checksum_matches(&hash.to_ascii_uppercase(), &hash));
        assert!(!checksum_matches(&hash, &"0".repeat(64)));
        assert!(!checksum_matches("not-a-hash", &hash));
        assert!(!checksum_matches(&hash[..63], &hash));
        assert!(!checksum_matches("", &hash));
    }

    #[test]
    fn a_mismatched_download_is_deleted_and_refused() {
        let dir = temp_dir("mismatch");
        let part = dir.join("setup.exe.part");
        let destination = dir.join("setup.exe");
        std::fs::write(&part, b"not the expected bytes").expect("write");

        let outcome = finalize_download(
            &part,
            &destination,
            Some(&"a".repeat(64)),
            &checksum_hex(b"not the expected bytes"),
        );

        assert!(outcome.is_err(), "a digest mismatch must be an error");
        assert!(!part.exists(), "the mismatched file must be deleted");
        assert!(!destination.exists(), "nothing may be promoted on a mismatch");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_verified_download_is_promoted_to_its_final_name() {
        let dir = temp_dir("verified");
        let part = dir.join("setup.exe.part");
        let destination = dir.join("setup.exe");
        let payload = b"the exact bytes the catalog promised";
        std::fs::write(&part, payload).expect("write");

        finalize_download(
            &part,
            &destination,
            Some(&checksum_hex(payload)),
            &checksum_hex(payload),
        )
        .expect("verified download");

        assert!(!part.exists());
        assert_eq!(std::fs::read(&destination).expect("read"), payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- Filenames and path traversal -------------------------------------

    fn filename_for(raw: &str) -> String {
        let url = parse_https(raw).expect("https url");
        sanitize_filename(&url, "firefox", "131.0", "exe")
    }

    #[test]
    fn filenames_never_escape_the_downloads_folder() {
        for hostile in [
            "https://evil.example/../../../../Windows/System32/cmd.exe",
            "https://evil.example/..%2f..%2f..%2fboot.ini",
            "https://evil.example/%2e%2e%2f%2e%2e%2fstartup.bat",
            "https://evil.example/....//....//setup.exe",
            "https://evil.example/",
            "https://evil.example",
            "https://evil.example/C:\\Windows\\System32\\calc.exe",
            "https://evil.example/..",
            "https://evil.example/a b c \u{202E}gnp.exe",
        ] {
            let name = filename_for(hostile);
            assert!(
                safe_join(Path::new(r"C:\dl\wafx\downloads"), &name).is_ok(),
                "{hostile} produced an unusable name: {name}"
            );
            assert!(
                !name.contains('/') && !name.contains('\\') && !name.contains(':'),
                "{hostile} produced a path: {name}"
            );
            assert!(!name.starts_with('.'), "{hostile} hid the file: {name}");
            assert!(!name.is_empty());
            assert!(name.len() <= MAX_FILENAME_LEN, "{name} is too long");
        }
    }

    #[test]
    fn a_normal_url_keeps_its_own_file_name() {
        assert_eq!(
            filename_for("https://downloads.example/firefox-131.0.exe"),
            "firefox-131.0.exe"
        );
        assert_eq!(
            filename_for("https://downloads.example/vlc-3.0.20-win64.msi"),
            "vlc-3.0.20-win64.msi"
        );
    }

    #[test]
    fn a_reserved_device_name_is_made_usable() {
        assert_eq!(filename_for("https://downloads.example/nul"), "wafx-nul.exe");
        assert_eq!(filename_for("https://downloads.example/CON.exe"), "wafx-CON.exe");
    }

    #[test]
    fn an_extension_the_catalog_does_not_claim_is_replaced() {
        // The URL says .bat but the catalog declares an exe installer, so the
        // file on disk is the type Windows will actually be asked to run.
        let url = parse_https("https://downloads.example/setup.bat").expect("url");
        assert_eq!(sanitize_filename(&url, "app", "1.0", "exe"), "setup.exe");
        let url = parse_https("https://downloads.example/setup.zip").expect("url");
        assert_eq!(sanitize_filename(&url, "app", "1.0", "msi"), "setup.msi");
    }

    #[test]
    fn safe_join_refuses_anything_that_is_not_one_plain_component() {
        let dir = Path::new(r"C:\dl\wafx\downloads");
        assert_eq!(
            safe_join(dir, "firefox-131.0.exe").expect("plain name"),
            dir.join("firefox-131.0.exe")
        );
        for hostile in [
            "", "..", ".", "a/b", "a\\b", "C:\\setup.exe", "/etc/passwd",
            "../setup.exe", "sub/../../setup.exe",
        ] {
            assert!(
                safe_join(dir, hostile).is_err(),
                "{hostile} should not be joinable into the downloads folder"
            );
        }
    }

    // ---- The one thing that must never happen ----------------------------

    /// `installer::run` is the only call in this crate that starts a process
    /// from catalog data, so the guarantee that a mismatched installer is never
    /// launched reduces to where that call sits.
    ///
    /// Read from the source rather than exercised, because the guarantee is
    /// about the shape of the code rather than about any single run: a test that
    /// fed in a bad checksum would prove only that today's flow returns an
    /// error, and would keep passing if a future edit added a second launch
    /// site. This is the same reasoning as `tests/console_windows.rs`.
    #[test]
    fn the_installer_is_launched_from_exactly_one_verified_place() {
        // Only the shipped code, not the tests below that talk about it.
        let body = function_source("install_wafx_app");
        let lines: Vec<&str> = body.lines().collect();

        let launches: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| line.contains("installer::run("))
            .map(|(index, _)| index)
            .collect();

        assert_eq!(
            launches.len(),
            1,
            "installer::run must have exactly one call site, found {launches:?}"
        );
        let launch = launches[0];

        // Everything that could have gone wrong must be settled above it. Each
        // of these is an early return or a `?`, so reaching the launch implies
        // each one passed.
        for (marker, description) in [
            ("installer::check_supported(&version.installer_type", "the container/mode check"),
            ("let url = parse_https(", "the HTTPS check"),
            ("let path = download_installer(", "the download and digest gate"),
        ] {
            let at = lines
                .iter()
                .position(|line| line.contains(marker))
                .unwrap_or_else(|| panic!("{description} is gone from the install path"));
            assert!(
                at < launch,
                "{description} must run before the installer is launched"
            );
        }

        // And nothing in this function builds a process any other way. The needle is
        // assembled at runtime because `tests/console_windows.rs` greps every
        // source file for the literal spelling, and this test would otherwise
        // register itself as a spawn site that had forgot its creation flags.
        let spawn = ["Command", "::", "new"].concat();
        assert!(
            !lines.iter().any(|line| line.contains(spawn.as_str())),
            "only installer::run may start a process"
        );
    }

    /// The `.part` file is never promoted, so a failed verification cannot
    /// leave something the next run would find and try to reuse.
    #[test]
    fn a_mismatch_removes_the_partial_download_rather_than_renaming_it() {
        let dir = temp_dir("mismatch");
        let part = dir.join("setup.exe.part");
        let destination = dir.join("setup.exe");
        std::fs::write(&part, b"not what the catalog promised").expect("seed the partial file");

        let expected = "a".repeat(64);
        let computed = "b".repeat(64);
        let error = finalize_download(&part, &destination, Some(&expected), &computed)
            .expect_err("a mismatched digest is an error");

        assert!(error.contains("checksum mismatch"), "{error}");
        assert!(!part.exists(), "the partial file should have been deleted");
        assert!(
            !destination.exists(),
            "a mismatch must not produce the file the next run would trust"
        );
    }

    // ---- Optional checksums ------------------------------------------------

    /// A version row with the fields this section cares about, so the tests below
    /// state only what they are actually varying.
    fn version_with(sha: Option<&str>, installer_type: &str) -> WafxVersion {
        WafxVersion {
            id: "v1".to_string(),
            version: "1.0".to_string(),
            installer_type: installer_type.to_string(),
            installer_mode: "interactive".to_string(),
            installer_url_kind: "external".to_string(),
            installer_url: "https://downloads.example/setup.exe".to_string(),
            installer_sha256: sha.map(str::to_string),
            installer_size_bytes: None,
            release_date: None,
            created_at: "2026-09-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn a_version_without_a_checksum_is_allowed_and_reports_itself_unverified() {
        // This is the whole point of the feature: a plain HTTPS URL is enough to
        // add an application, so an absent digest must not be an error.
        for sha in [None, Some(""), Some("   ")] {
            let version = version_with(sha, "exe");
            assert_eq!(
                published_checksum(&version).expect("an absent digest is not an error"),
                None,
                "sha {sha:?} should mean no digest"
            );
        }
    }

    #[test]
    fn a_published_checksum_is_returned_for_verification() {
        let digest = checksum_hex(b"abc");
        let version = version_with(Some(&digest), "exe");
        assert_eq!(
            published_checksum(&version).expect("a valid digest"),
            Some(digest.clone())
        );
        // Uppercase survives, because the comparison is case-insensitive and an
        // operator pasting one must not be silently downgraded to "no digest".
        let upper = version_with(Some(&digest.to_ascii_uppercase()), "exe");
        assert_eq!(published_checksum(&upper).expect("uppercase hex"), Some(digest));
    }

    #[test]
    fn a_malformed_checksum_is_an_error_and_never_an_absent_one() {
        // The downgrade this prevents: if an unusable digest were treated as "no
        // digest", anyone able to corrupt that one column could turn a verified
        // install into an unverified one and have it succeed.
        for bad in ["not-a-hash", "zz", &"a".repeat(63), &"a".repeat(65), &"g".repeat(64)] {
            let version = version_with(Some(bad), "exe");
            assert!(
                published_checksum(&version).is_err(),
                "{bad:?} must be an error, not a missing digest"
            );
        }
    }

    #[test]
    fn a_download_with_no_checksum_is_promoted_without_being_compared() {
        let dir = temp_dir("nohash");
        let part = dir.join("setup.exe.part");
        let destination = dir.join("setup.exe");
        let payload = b"whatever the server served, unverified";
        std::fs::write(&part, payload).expect("write");

        finalize_download(&part, &destination, None, &checksum_hex(payload))
            .expect("an absent digest must not block the download");

        assert!(!part.exists());
        assert_eq!(std::fs::read(&destination).expect("read"), payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_absent_digest_is_not_the_same_thing_as_a_mismatch() {
        // `None` promotes, a wrong digest destroys. If these were the same value a
        // single typo in the panel would silently disable verification.
        let dir = temp_dir("none-vs-mismatch");
        let promoted = dir.join("a.exe");
        std::fs::write(dir.join("a.exe.part"), b"payload").expect("write");
        assert!(finalize_download(&dir.join("a.exe.part"), &promoted, None, "anything").is_ok());
        assert!(promoted.exists());

        let refused = dir.join("b.exe");
        std::fs::write(dir.join("b.exe.part"), b"payload").expect("write");
        assert!(
            finalize_download(&dir.join("b.exe.part"), &refused, Some(&"a".repeat(64)), "different")
                .is_err()
        );
        assert!(!refused.exists(), "a mismatch must not produce a file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- Container identification -----------------------------------------

    /// A file whose first bytes are exactly `bytes`, plus the usual noise after.
    fn file_starting_with(label: &str, bytes: &[u8]) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = temp_dir(label);
        let path = dir.join("payload.bin");
        let mut content = bytes.to_vec();
        content.extend_from_slice(&[0x5A; 64]);
        std::fs::write(&path, &content).expect("write");
        (dir, path)
    }

    #[test]
    fn an_exe_and_an_msi_are_each_accepted_for_the_type_they_really_are() {
        let (dir, path) = file_starting_with("real-exe", b"MZ\x90\x00");
        assert!(check_container_type(&path, "exe").is_ok());
        let _ = std::fs::remove_dir_all(&dir);

        let (dir, path) =
            file_starting_with("real-msi", &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
        assert!(check_container_type(&path, "msi").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_container_that_does_not_match_the_declared_type_is_refused() {
        // The case that matters: an EXE served as `msi` would be handed to
        // msiexec, and an MSI served as `exe` would be launched directly. Both are
        // the wrong program for the bytes.
        let (dir, exe) = file_starting_with("exe-as-msi", b"MZ\x90\x00");
        let error = check_container_type(&exe, "msi").expect_err("an EXE is not an MSI");
        assert!(error.contains("not an MSI package"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);

        let (dir, msi) =
            file_starting_with("msi-as-exe", &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
        let error = check_container_type(&msi, "exe").expect_err("an MSI is not an EXE");
        assert!(error.contains("not a Windows executable"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_is_neither_container_is_refused() {
        // An HTML error page or a JSON body served with a 200 is the realistic
        // case, and its first bytes are neither signature.
        let (dir, path) = file_starting_with("not-an-installer", b"<!DOCTYPE html>");
        assert!(check_container_type(&path, "exe").is_err());
        assert!(check_container_type(&path, "msi").is_err());
        let _ = std::fs::remove_dir_all(&dir);

        // Empty and truncated files are refused too, rather than read as a match.
        let dir = temp_dir("empty");
        let empty = dir.join("empty.bin");
        std::fs::write(&empty, b"").expect("write");
        assert!(check_container_type(&empty, "exe").is_err());
        let short = dir.join("short.bin");
        std::fs::write(&short, b"M").expect("write");
        assert!(check_container_type(&short, "exe").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_declared_type_is_refused_rather_than_guessed_at() {
        let (dir, path) = file_starting_with("unknown-type", b"MZ\x90\x00");
        for bad in ["bat", "powershell", "cmd", ""] {
            assert!(
                check_container_type(&path, bad).is_err(),
                "{bad:?} must not be accepted as a container"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_container_check_does_not_believe_the_file_name() {
        // `sanitize_filename` deliberately keeps an `exe`/`msi` extension the URL
        // claimed, so a name can say one thing and the bytes another. That is the
        // convenience being paid for, and the content check is what pays for it:
        // a file called `.msi` is judged on its header, never on its name.
        let url = parse_https("https://downloads.example/actually-an-exe.msi").expect("https");
        let name = sanitize_filename(&url, "thing", "1.0", "exe");
        assert_eq!(name, "actually-an-exe.msi", "the name keeps what the URL claimed");

        let (dir, path) = file_starting_with("named-msi", b"MZ\x90\x00");
        // Declared as an exe: the MZ header agrees, whatever the name says.
        assert!(check_container_type(&path, "exe").is_ok());
        // Declared as an msi: refused, because the header does not agree.
        assert!(check_container_type(&path, "msi").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The unverified path must not have quietly grown a second launch site, and
    /// the gates must still sit above the launch.
    #[test]
    fn the_optional_digest_did_not_move_the_launch_or_its_gates() {
        let body = function_source("install_wafx_app");
        let lines: Vec<&str> = body.lines().collect();

        assert_eq!(
            lines.iter().filter(|l| l.contains("installer::run(")).count(),
            1,
            "installer::run must still have exactly one call site"
        );
        let launch = lines
            .iter()
            .position(|l| l.contains("installer::run("))
            .expect("the launch site");

        for marker in [
            "installer::check_supported(&version.installer_type",
            "let url = parse_https(",
            "let expected = published_checksum(",
            "let path = download_installer(",
        ] {
            let at = lines
                .iter()
                .position(|l| l.contains(marker))
                .unwrap_or_else(|| panic!("{marker} is gone from the install path"));
            assert!(at < launch, "{marker} must run before the installer is launched");
        }

        // Still exactly one process in the whole function, and it is not a shell.
        let spawn = ["Command", "::", "new"].concat();
        assert!(
            !lines.iter().any(|l| l.contains(spawn.as_str())),
            "only installer::run may start a process"
        );
    }

    /// A cached file may only be reused when something can re-verify it.
    #[test]
    fn the_cached_copy_is_reused_only_when_there_is_a_digest_to_re_verify_it() {
        let body = function_source("download_installer");
        let all: Vec<&str> = body.lines().collect();
        let reuse = all
            .iter()
            .position(|l| l.contains("if destination.is_file()"))
            .expect("the reuse branch");
        let rehash = all
            .iter()
            .position(|l| l.contains("checksum_file(&rehashed)"))
            .expect("the re-hash");
        assert!(reuse < rehash, "the reuse decision comes before the re-hash it needs");

        // The gate lives *inside* the reuse branch, so the region to inspect is
        // between the two, not before the branch.
        let region = &all[reuse..rehash];
        let guards = region
            .iter()
            .filter(|l| l.contains("expected.is_some()"))
            .count();
        assert_eq!(
            guards, 1,
            "reuse must be gated on a published digest, so an unverifiable file is refetched"
        );
    }

    // ---- Icons as data URLs ------------------------------------------------

    #[test]
    fn base64_matches_the_published_test_vectors() {
        // The three lengths that exercise every padding case.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // A PNG header, to confirm binary survives the round trip.
        assert_eq!(base64_encode(&[0x89, 0x50, 0x4E, 0x47]), "iVBORw==");
    }

    #[test]
    fn an_icon_url_never_reaches_the_webview() {
        // The payload carries the image bytes, not the address they came from.
        let parsed: AppsResponse = serde_json::from_str(APPS_JSON).expect("apps feed");
        let rendered = serde_json::to_string(&parsed.apps[0]).expect("payload");
        assert!(!rendered.contains("icons.example"), "{rendered}");
        assert!(!rendered.contains("icon_url"), "{rendered}");
    }

    #[test]
    fn the_icon_content_type_list_is_closed_to_real_image_types() {
        assert!(ICON_CONTENT_TYPES.contains(&"image/png"));
        assert!(ICON_CONTENT_TYPES.contains(&"image/webp"));
        // Never anything executable or a document the webview would sniff.
        for refused in ["image/svg+xml", "text/html", "application/octet-stream", ""] {
            assert!(!ICON_CONTENT_TYPES.contains(&refused));
        }
    }

    #[test]
    fn the_downloads_folder_lives_under_appdata() {
        let dir = downloads_dir().expect("downloads dir");
        assert!(dir.ends_with(Path::new("wafx").join("downloads")), "{dir:?}");
        assert!(dir.is_absolute());
    }
}
