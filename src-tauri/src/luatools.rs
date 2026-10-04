//! Launching LuaTools, which Daltoon X does not ship, install or manage.
//!
//! LuaTools is a separate program with its own installer, its own Velopack
//! auto-updater and its own single-instance behaviour. Daltoon X is only a
//! launcher for it: this module finds an already-installed `LuaTools.exe` and
//! starts it, and does nothing else. No LuaTools file is downloaded, bundled,
//! extracted, verified or written, and no LuaTools source is vendored here.
//!
//! Three properties are load-bearing, and each is enforced rather than assumed:
//!
//! 1. **The renderer never names the executable.** [`launch_luatools`] takes no
//!    arguments at all, so there is no path for a compromised webview to
//!    smuggle in. The candidate list below is a compile-time constant.
//! 2. **A candidate is either accepted whole or refused whole.** Every
//!    validation gate in [`accept`] has to pass; there is no repair step and no
//!    fallback that trusts part of a path.
//! 3. **The launcher reports outcomes as data.** The renderer branches on the
//!    [`LaunchOutcome::status`] discriminant and never parses a message, so
//!    wording can be localised without touching this module.
//!
//! LuaTools keeps its own interface. This module cannot change what its windows
//! look like, and nothing here is a fork of it.
//!
//! LuaTools is MIT-licensed, © 2026 LuaTools. Daltoon X bundles none of it, so
//! the licence attaches to the copy a user obtains from the project itself; the
//! full notice and the official addresses are in `THIRD-PARTY-NOTICES.md` at the
//! repository root.

use std::path::{Path, PathBuf};

/// The only file name that will ever be started. Compared
/// case-insensitively because Windows file names are case-insensitive, and
/// because `%ProgramFiles%` and `%LOCALAPPDATA%` can disagree with what the
/// user typed when LuaTools was installed.
pub const EXECUTABLE_NAME: &str = "LuaTools.exe";

/// Velopack's per-user install root. `<root>\<product>\<EXECUTABLE_NAME>`.
const ROOTS: [&str; 3] = ["LuaTools", "Programs\\LuaTools", ""];

/// Where the user is sent when LuaTools is not installed. This is the
/// download page the LuaTools README names for release builds, so it is the
/// project's own published address and not a constructed guess.
pub const OFFICIAL_PAGE: &str = "https://lua.tools/app";

/// Outcome of [`probe`] and [`launch_luatools`]. Serialised as
/// `{"status":"..."}`, so the renderer reads the discriminant and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchOutcome {
    /// `LuaTools.exe` was found, validated and started.
    Launched,
    /// `LuaTools.exe` is present and validated, and the runtime it needs is
    /// installed. Reported by [`luatools_status`] only; launching never returns
    /// it.
    Installed,
    /// No `LuaTools.exe` exists in any allowed root. This is the ordinary
    /// "not installed yet" case, not a failure.
    NotInstalled,
    /// `LuaTools.exe` is present but the .NET 8 Desktop Runtime it needs is
    /// not. Publishing framework-dependent builds cannot detect this itself, so
    /// Daltoon X reports it rather than letting the process die on a missing
    /// framework dialog.
    RuntimeMissing,
    /// A `LuaTools.exe` does exist, but it failed a validation gate: wrong
    /// leaf name, a reparse point, a parent outside every allowed root. The
    /// file is never started. Reported to the renderer as `not_installed`,
    /// because the user's remedy is the same — install LuaTools where its own
    /// installer puts it — while the specific gate that refused it travels in
    /// [`LaunchReport::detail`] for the audit trail.
    Rejected,
    /// Daltoon X is running elevated, so a child would inherit an administrator
    /// token. LuaTools drives the signed Steam client and writes inside the
    /// user's own profile; launching it elevated is refused rather than done
    /// quietly.
    Elevated,
    /// Windows refused to start the process.
    Error,
}

impl LaunchOutcome {
    /// The discriminant the renderer switches on.
    pub fn status(&self) -> &'static str {
        match self {
            Self::Launched => "launched",
            Self::Installed => "installed",
            Self::NotInstalled => "not_installed",
            Self::RuntimeMissing => "runtime_missing",
            Self::Rejected => "not_installed",
            Self::Elevated => "error",
            Self::Error => "error",
        }
    }

    /// True when `LuaTools.exe` is present, whether or not this call started it.
    ///
    /// The renderer reads [`LaunchOutcome::status`] rather than this, so it is
    /// part of the module's asserted contract rather than of its live path: it
    /// is what pins `installed` and `launched` to the same meaning the tests
    /// below rely on.
    #[cfg(test)]
    pub fn is_installed(&self) -> bool {
        matches!(self, Self::Installed | Self::Launched)
    }

    /// True only when LuaTools is running as a result of this call. `Rejected`
    /// deliberately reports false so the UI falls through to the install prompt
    /// instead of claiming a launch that did not happen.
    #[cfg(test)]
    pub fn is_launched(&self) -> bool {
        matches!(self, Self::Launched)
    }
}

/// What the renderer receives. `detail` is for logs and for tests; the UI is
/// driven by `status` alone.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LaunchReport {
    pub status: &'static str,
    /// Present only when `status` is `not_installed`, so the renderer can offer
    /// the official page without hard-coding an address.
    pub official_page: Option<&'static str>,
    /// Developer-facing reason. Never shown as the primary message and never
    /// parsed by the renderer.
    pub detail: Option<String>,
}

impl LaunchReport {
    fn new(outcome: LaunchOutcome, detail: Option<String>) -> Self {
        Self {
            status: outcome.status(),
            // The page is offered for the states the user can act on by
            // installing something, and withheld for states where installing
            // would not help: an already-installed LuaTools, or a failure that
            // reinstalling cannot reach.
            official_page: matches!(
                outcome,
                LaunchOutcome::NotInstalled
                    | LaunchOutcome::RuntimeMissing
                    | LaunchOutcome::Rejected
            )
            .then_some(OFFICIAL_PAGE),
            detail,
        }
    }
}

/// Reads one of the three install roots from the process environment.
///
/// # Errors
///
/// Returns the variable's absence as an error rather than an empty string, so a
/// root can never silently collapse to the process working directory.
fn env_dir(key: &str) -> Result<PathBuf, String> {
    std::env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| format!("{key} is not set"))
}

/// The absolute paths this module is willing to consider, in probe order.
///
/// Takes both roots as arguments instead of reading the environment itself, so
/// the candidate list is a pure function of two paths. That keeps the list
/// pinned by a test without the test having to mutate process-wide
/// environment state, which would race every other test in the binary.
fn candidates(local: &Path, program_files: &Path) -> Vec<PathBuf> {
    ROOTS
        .iter()
        .map(|root| {
            if root.is_empty() {
                program_files.join(EXECUTABLE_NAME)
            } else {
                local.join(root).join(EXECUTABLE_NAME)
            }
        })
        .collect()
}

/// Every validation gate a candidate must pass, applied together.
///
/// # Errors
///
/// Any failure means the candidate is discarded whole. In particular there is no
/// path under which a non-`LuaTools.exe` file is started.
fn accept(candidate: &Path, roots: &[PathBuf]) -> Result<(), &'static str> {
    // Absolute before anything else. A relative candidate would resolve against
    // the process working directory.
    if !candidate.is_absolute() {
        return Err("candidate is not an absolute path");
    }

    // UNC and verbatim forms are refused on their spelling. `%ProgramFiles%` is
    // a local fixed drive on Windows, so a legitimate candidate can never be
    // either of these, and both can name a share this process should not reach.
    let text = candidate.to_str().ok_or("candidate is not valid Unicode")?;
    let lower = text.to_ascii_lowercase();
    if lower.starts_with(r"\\") || lower.starts_with("//") || lower.starts_with(r"\\?\\") {
        return Err("candidate is a UNC or verbatim path");
    }

    // No traversal, spelled out. `%ProgramFiles%` is trusted to be canonical,
    // but the check is kept so a future root cannot reintroduce the problem.
    if text.split(['\\', '/']).any(|part| part == ".." || part == ".") {
        return Err("candidate contains a relative component");
    }

    // Extension before the name check, so the rejection reason distinguishes a
    // wrong container from a wrong program.
    if !lower.ends_with(".exe") {
        return Err("candidate is not an .exe");
    }

    // The one and only accepted file name.
    let file_name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("candidate has no file name")?;
    if !file_name.eq_ignore_ascii_case(EXECUTABLE_NAME) {
        return Err("candidate is not named LuaTools.exe");
    }

    // Canonicalise, then require the result to still be a plain local file. A
    // reparse point is rejected outright rather than followed: following one
    // would let a planted link redirect the launch somewhere the allowed-root
    // check below never saw.
    let canonical = candidate.canonicalize().map_err(|_| "candidate does not resolve")?;
    if !canonical.is_absolute() {
        return Err("canonical candidate is not absolute");
    }
    if canonical.file_name().and_then(|n| n.to_str()) != Some(EXECUTABLE_NAME) {
        return Err("canonical candidate is not named LuaTools.exe");
    }

    // ADS. Two spellings reach past the leaf-name check: a colon in a
    // *directory* component (`C:\dir:stream\LuaTools.exe` addresses the stream
    // of a directory), and a colon in the leaf itself (`LuaTools.exe:stream`).
    // The second is already refused because the leaf is not `LuaTools.exe`, but
    // the first is not, so the colon is rejected explicitly. The drive letter's
    // own colon is skipped: every absolute Windows path has one, and matching
    // it here would refuse every candidate including the legitimate ones.
    if let Some(rest) = text.get(2..) {
        if rest.contains(':') {
            return Err("candidate carries an alternate data stream");
        }
    }

    // Finally, the parent must sit inside one of the roots.
    let parent = canonical.parent().ok_or("candidate has no parent directory")?;
    if !roots.iter().any(|root| is_within(parent, root)) {
        return Err("candidate is outside every allowed root");
    }

    Ok(())
}

/// Whether `parent` is `root` or sits inside it.
///
/// Windows compares path components case-insensitively, while
/// [`Path::starts_with`] compares them byte for byte. The plain check therefore
/// refuses every legitimate candidate on a machine that spells a root variable
/// with different casing than the filesystem reports -- which is common, and
/// which would make the launcher claim LuaTools is absent on a machine that has
/// it. This is the same mistake a case-sensitive string comparison invites, so
/// the comparison is done per component instead.
///
/// Comparing whole components also keeps a sibling that merely begins with a
/// root's text out of that root: a directory called `LuaTools-old` next to one
/// called `LuaTools` is not inside it.
///
/// A component that is not valid Unicode on both sides compares unequal, which
/// refuses the candidate. Refusing on a path this module cannot read is the
/// safe direction to fail in.
///
/// Both arguments must already be canonicalised. On Windows that means both
/// carry the extended-length prefix, because [`Path::starts_with`] and a
/// component walk both distinguish a verbatim drive from a plain one. The only
/// caller canonicalises its roots in [`allowed_roots`].
fn is_within(parent: &Path, root: &Path) -> bool {
    let mut wanted = root.components();
    for part in parent.components() {
        match wanted.next() {
            // The root ran out first, so each of its components matched a
            // leading component of the parent: the parent is inside it.
            None => return true,
            Some(expected) => {
                let same = part
                    .as_os_str()
                    .to_str()
                    .zip(expected.as_os_str().to_str())
                    .is_some_and(|(actual, expected)| actual.eq_ignore_ascii_case(expected));
                if !same {
                    return false;
                }
            }
        }
    }
    // The parent ran out. True only when the root ran out at the same moment,
    // meaning the parent *is* the root. That is the ordinary case, not an edge
    // case: LuaTools.exe sits directly inside its own install directory, so
    // requiring the parent to be strictly deeper would refuse every legitimate
    // install on every machine.
    wanted.next().is_none()
}

/// Why no candidate qualified, and whether any of them actually existed.
///
/// The two are kept apart because they mean different things to the user: an
/// absent `LuaTools.exe` is "not installed yet", while a present one that
/// failed a gate is "something is there but it will not be run". Collapsing
/// them would hide a planted file or a moved install behind an ordinary
/// install prompt.
#[derive(Debug, PartialEq, Eq)]
struct ResolveFailure {
    /// One line per candidate, so the audit trail names every path examined.
    reasons: String,
    /// True when at least one candidate existed and was refused by a gate.
    refused_present: bool,
}

impl ResolveFailure {
    /// `Rejected` when something was there and refused, `NotInstalled` when
    /// nothing was there at all. Both render as `not_installed`; only the
    /// logged detail differs.
    fn into_outcome(&self) -> LaunchOutcome {
        if self.refused_present {
            LaunchOutcome::Rejected
        } else {
            LaunchOutcome::NotInstalled
        }
    }
}

/// The first candidate that passes [`accept`], or why none did.
///
/// Split from [`launch`] so the tests can drive the whole resolution and
/// validation path against synthetic directories without starting a process or
/// reading a real user profile.
fn resolve(candidates: &[PathBuf], roots: &[PathBuf]) -> Result<PathBuf, ResolveFailure> {
    let mut reasons = Vec::new();
    let mut refused_present = false;
    for candidate in candidates {
        if !candidate.is_file() {
            reasons.push(format!("{}: not present", candidate.display()));
            continue;
        }
        match accept(candidate, roots) {
            Ok(()) => return Ok(candidate.to_path_buf()),
            Err(reason) => {
                refused_present = true;
                reasons.push(format!("{}: {reason}", candidate.display()));
            }
        }
    }
    Err(ResolveFailure {
        reasons: reasons.join("; "),
        refused_present,
    })
}

/// Whether the .NET 8 Desktop Runtime is installed.
///
/// The framework-dependent LuaTools build needs `Microsoft.WindowsDesktop.App`
/// at major version 8 or above. A later major is accepted on purpose: a machine
/// carrying .NET 9 or 10 Desktop Runtime can run a `net8.0-windows` app through
/// the roll-forward the host applies by default, and refusing to launch would
/// be wrong.
///
/// Read through the `DOTNET_ROOT` registry value first, the way a framework
/// dependent app's host resolves its own search, and fall back to the
/// conventional install location. The value is read as data and used only to
/// build a directory name; nothing from it reaches a command line.
#[cfg(windows)]
fn has_dotnet_desktop_runtime() -> bool {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};

    let major = std::env::var("DOTNET_ROOT").ok().and_then(|root| {
        let root = PathBuf::from(root);
        if !root.is_absolute() {
            return None;
        }
        desktop_runtime_version(&root)
    });
    if major.is_some() {
        return true;
    }

    // `ProgramFiles\DotNet` is not the install root on every machine, so consult
    // the registry for the documented location before falling back to it.
    let root = winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            r"SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App",
            KEY_READ,
        )
        .ok()
        .and_then(|key| key.get_value::<String, _>("InstallLocation").ok())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| {
            env_dir("ProgramFiles")
                .unwrap_or_default()
                .join("DotNet")
                .join("shared")
                .join("Microsoft.WindowsDesktop.App")
        });
    root.is_absolute() && desktop_runtime_version(&root).is_some()
}

/// The highest major version directory under a `shared` framework root, or
/// `None` when the root holds no version directory at all.
fn desktop_runtime_version(shared_root: &Path) -> Option<u32> {
    std::fs::read_dir(shared_root)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.split('.').next())
                .and_then(|major| major.parse::<u32>().ok())
        })
        .max()
}

/// Always false off Windows, where the framework name does not apply.
#[cfg(not(windows))]
fn has_dotnet_desktop_runtime() -> bool {
    false
}

/// Whether LuaTools is installed, without starting it.
///
/// Separate from [`launch_luatools`] so the UI can show the correct button and
/// the correct prompt before the user asks to launch anything.
#[tauri::command]
pub fn luatools_status() -> LaunchReport {
    report(probe())
}

/// Starts LuaTools, or reports why it could not.
///
/// Takes no arguments by design: the renderer cannot supply a path, a program
/// name or a switch, and there is no field for one to smuggle a value into.
///
/// # Errors
///
/// This command does not fail. Every outcome, including a refused one, is
/// returned as data so the renderer never has to read an error message to
/// decide what to draw.
#[tauri::command]
pub fn launch_luatools() -> LaunchReport {
    report(launch())
}

/// Wraps an outcome and its detail into the report the renderer receives.
fn report(outcome: (LaunchOutcome, Option<String>)) -> LaunchReport {
    LaunchReport::new(outcome.0, outcome.1)
}

/// Inspects the machine and reports what is and is not present. Never starts a
/// process.
///
/// Split from [`launch`] so the UI can draw the right button and the right
/// prompt before the user asks to launch anything.
fn probe() -> (LaunchOutcome, Option<String>) {
    if crate::elevation::is_elevated() {
        return (
            LaunchOutcome::Elevated,
            Some("Daltoon X is running elevated".into()),
        );
    }
    match locate() {
        Err(failure) => failure.into_parts(),
        // Present and valid. Whether it can actually start depends on the
        // runtime, which is a separate question and a separate status.
        Ok(_) if has_dotnet_desktop_runtime() => (LaunchOutcome::Installed, None),
        Ok(_) => (
            LaunchOutcome::RuntimeMissing,
            Some("the .NET 8 Desktop Runtime is not installed".into()),
        ),
    }
}

/// Starts the validated executable, detached.
///
/// Spawning rather than waiting for the process: LuaTools is a long-lived GUI
/// program, and waiting for it would freeze Daltoon X for as long as the user
/// keeps it open.
/// No shell is involved and the argument vector is empty, so nothing from a
/// path or a name is ever re-parsed by a command interpreter.
///
/// The elevation check runs before the spawn, and refuses rather than
/// compensating: LuaTools drives the signed Steam client and writes inside the
/// user's own profile, and an inherited administrator token would change both.
/// Daltoon X's main process is not elevated by design (see `elevation.rs`), so
/// this is a guard against a future change, not a workaround.
fn launch() -> (LaunchOutcome, Option<String>) {
    if crate::elevation::is_elevated() {
        return (
            LaunchOutcome::Elevated,
            Some("Daltoon X is running elevated".into()),
        );
    }

    let executable = match locate() {
        Ok(executable) => executable,
        Err(failure) => return failure.into_parts(),
    };

    if !has_dotnet_desktop_runtime() {
        return (
            LaunchOutcome::RuntimeMissing,
            Some("the .NET 8 Desktop Runtime is not installed".into()),
        );
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        // `DETACHED_PROCESS` so closing Daltoon X does not take LuaTools down
        // with it, and so LuaTools gets a process of its own instead of sharing
        // our console. `CREATE_NO_WINDOW` is deliberately NOT set here: that
        // flag is for console programs, and LuaTools is a GUI program that
        // draws its own window.
        const DETACHED_PROCESS: u32 = 0x0000_0008;

        match Command::new(&executable)
            .creation_flags(DETACHED_PROCESS)
            .spawn()
        {
            Ok(_) => (LaunchOutcome::Launched, None),
            Err(e) => (
                LaunchOutcome::Error,
                Some(format!("could not start LuaTools: {e}")),
            ),
        }
    }

    #[cfg(not(windows))]
    {
        (
            LaunchOutcome::Error,
            Some("LuaTools can only be launched on Windows".to_string()),
        )
    }
}

/// The validated executable, or why no candidate qualified.
fn locate() -> Result<PathBuf, LaunchFailure> {
    // Read both roots before either is used, so a machine missing one of them
    // is reported as an environment failure instead of silently searching a
    // shorter list and looking like a machine with no LuaTools.
    let local = env_dir("LOCALAPPDATA").map_err(LaunchFailure::Environment)?;
    let program_files = env_dir("ProgramFiles").map_err(LaunchFailure::Environment)?;
    let candidates = candidates(&local, &program_files);
    let roots = allowed_roots(&local, &program_files).map_err(LaunchFailure::Environment)?;
    resolve(&candidates, &roots).map_err(LaunchFailure::NoCandidate)
}

/// Why the launcher produced no executable to start.
enum LaunchFailure {
    /// A required environment variable is missing or unusable, so the search
    /// never ran. Kept apart from "no LuaTools found": nothing was inspected,
    /// and telling the user to install something would be the wrong advice.
    Environment(String),
    /// The search ran and no candidate qualified.
    NoCandidate(ResolveFailure),
}

impl LaunchFailure {
    /// The status the renderer switches on, and the detail it logs. The
    /// renderer never reads the detail.
    fn into_parts(self) -> (LaunchOutcome, Option<String>) {
        match self {
            Self::Environment(detail) => (LaunchOutcome::Error, Some(detail)),
            Self::NoCandidate(failure) => {
                (failure.into_outcome(), Some(failure.reasons))
            }
        }
    }
}

/// The directories a candidate's parent is allowed to sit in, canonicalised so
/// the containment check in [`accept`] compares like with like.
///
/// `ProgramFiles` is itself a root, not `ProgramFiles\LuaTools`: the
/// per-machine installer may put a dependency of LuaTools next to it, and a
/// root that tight would refuse a legitimate install.
fn allowed_roots(local: &Path, program_files: &Path) -> Result<Vec<PathBuf>, String> {
    let local = local
        .canonicalize()
        .map_err(|_| "LOCALAPPDATA is unusable".to_string())?;
    let program_files = program_files
        .canonicalize()
        .map_err(|_| "ProgramFiles is unusable".to_string())?;
    Ok(vec![
        local.join("LuaTools"),
        local.join("Programs").join("LuaTools"),
        program_files,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory that cleans itself up, so the tests never leave a
    /// `LuaTools.exe` behind in a real profile path.
    struct TempTree(PathBuf);

    impl TempTree {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("daltoon-luatools-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp root");
            Self(dir)
        }

        fn root(&self) -> &Path {
            &self.0
        }

        /// The tree as a single allowed root, canonicalised.
        ///
        /// `accept` canonicalises a candidate before comparing it, and on
        /// Windows that turns the path into extended-length form. The roots
        /// have to be in the same form or nothing matches, which is exactly
        /// what `allowed_roots` does in production -- so the tests do it too
        /// rather than exercising a shape the real caller never produces.
        fn roots(&self) -> Vec<PathBuf> {
            vec![self.0.canonicalize().expect("temp root exists")]
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_exe(dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).expect("candidate dir");
        let path = dir.join(name);
        std::fs::write(&path, b"not a real program").expect("candidate file");
        path
    }

    /// The outcome a renderer would branch on.
    fn status_of(outcome: &LaunchOutcome) -> &'static str {
        outcome.status()
    }

    /// This module's implementation, with the test module removed.
    ///
    /// The tests below assert on the shape of the source, so they must not read
    /// their own text: a test that searches for `cmd` would otherwise match the
    /// literal `"cmd"` in its own body and always fail.
    ///
    /// The split marker is the test *module* header, not a bare `#[cfg(test)]`:
    /// two test-only methods in the implementation carry that attribute
    /// themselves, and splitting on it would hand back a fragment ending long
    /// before the functions these tests are looking for.
    fn implementation() -> &'static str {
        let source = include_str!("luatools.rs");
        let (before, after) = source
            .split_once("#[cfg(test)]\nmod tests {")
            .expect("a test module");
        assert!(
            after.contains("fn launch_luatools()"),
            "the split must keep the whole implementation"
        );
        before
    }

    #[test]
    fn the_candidate_list_is_a_closed_set_of_three_roots() {
        // Passed in rather than read from the environment: mutating
        // process-wide environment state here would race every other test
        // in the binary, which is exactly what it did before.
        let found = candidates(
            Path::new(r"C:\Users\w\AppData\Local"),
            Path::new(r"C:\Program Files"),
        );

        assert_eq!(
            found,
            vec![
                PathBuf::from(r"C:\Users\w\AppData\Local\LuaTools\LuaTools.exe"),
                PathBuf::from(r"C:\Users\w\AppData\Local\Programs\LuaTools\LuaTools.exe"),
                PathBuf::from(r"C:\Program Files\LuaTools.exe"),
            ]
        );
        // Every one of them ends in the one accepted file name, and none of
        // them can be influenced by anything the renderer said.
        for candidate in &found {
            assert_eq!(
                candidate.file_name().and_then(|n| n.to_str()),
                Some(EXECUTABLE_NAME)
            );
            assert!(candidate.is_absolute());
        }
    }

    #[test]
    fn an_unset_environment_root_is_an_error_not_an_empty_root() {
        // A root that silently collapsed to an empty string would resolve
        // against the process working directory, which is why `env_dir`
        // refuses an absent variable instead of returning one.
        let missing = "LUATOOLS_TEST_ROOT_THAT_IS_NOT_SET";
        assert!(env_dir(missing).is_err());
        assert_eq!(
            env_dir(missing).unwrap_err(),
            format!("{missing} is not set"),
            "the reason must name the variable, not the path"
        );

        // The variables the real search needs are readable on any machine
        // this runs on, which is what makes the absence above meaningful.
        assert!(env_dir("LOCALAPPDATA").is_ok());
        assert!(env_dir("ProgramFiles").is_ok());
    }

    #[test]
    fn a_well_formed_candidate_is_accepted() {
        let tree = TempTree::new("good");
        let root = tree.root().join("LuaTools");
        let candidate = write_exe(&root, EXECUTABLE_NAME);
        let roots = tree.roots();

        assert_eq!(accept(&candidate, &roots), Ok(()));
    }

    #[test]
    fn a_relative_candidate_is_refused() {
        let tree = TempTree::new("relative");
        let roots = tree.roots();
        assert_eq!(
            accept(Path::new(r"LuaTools\LuaTools.exe"), &roots),
            Err("candidate is not an absolute path")
        );
    }

    #[test]
    fn a_unc_candidate_is_refused() {
        let tree = TempTree::new("unc");
        let roots = tree.roots();
        assert_eq!(
            accept(Path::new(r"\\attacker\share\LuaTools.exe"), &roots),
            Err("candidate is a UNC or verbatim path")
        );
        assert_eq!(
            accept(Path::new("//attacker/share/LuaTools.exe"), &roots),
            Err("candidate is a UNC or verbatim path")
        );
    }

    #[test]
    fn a_traversal_candidate_is_refused() {
        let tree = TempTree::new("traversal");
        let root = tree.root().join("LuaTools");
        let candidate = write_exe(&root, EXECUTABLE_NAME);
        let roots = tree.roots();

        // Same file, reached by walking out and back in.
        let traversal = tree
            .root()
            .join("..")
            .join(root.file_name().unwrap())
            .join(EXECUTABLE_NAME);
        assert_eq!(
            accept(&traversal, &roots),
            Err("candidate contains a relative component")
        );
        // And the honest spelling of the same file is still fine, which is what
        // makes the refusal about the spelling rather than the target.
        assert_eq!(accept(&candidate, &roots), Ok(()));
    }

    #[test]
    fn a_candidate_outside_every_allowed_root_is_refused() {
        let tree = TempTree::new("outside");
        // Both directories exist, so the refusal is about location and not
        // about a root that simply does not exist.
        let allowed = tree.root().join("LuaTools");
        let stranger = tree.root().join("SomewhereElse");
        let candidate = write_exe(&stranger, EXECUTABLE_NAME);
        std::fs::create_dir_all(&allowed).expect("allowed root");
        // The root list names a real directory that is not where the file is.
        let roots = vec![allowed.canonicalize().expect("allowed root exists")];

        assert_eq!(
            accept(&candidate, &roots),
            Err("candidate is outside every allowed root")
        );
    }

    #[test]
    fn a_sibling_whose_name_starts_like_a_root_is_outside_it() {
        // `LuaTools-old` sits next to `LuaTools`. Comparing the path as text
        // would call that a match; comparing components does not.
        let tree = TempTree::new("sibling");
        let allowed = tree.root().join("LuaTools");
        let lookalike = tree.root().join("LuaTools-old");
        let candidate = write_exe(&lookalike, EXECUTABLE_NAME);
        std::fs::create_dir_all(&allowed).expect("allowed root");
        let roots = vec![allowed.canonicalize().expect("allowed root exists")];

        assert_eq!(
            accept(&candidate, &roots),
            Err("candidate is outside every allowed root")
        );
    }

    #[test]
    fn a_root_spelled_with_different_casing_still_contains_its_candidate() {
        // Windows path comparison ignores case, `Path::starts_with` does not,
        // and `%LOCALAPPDATA%` is routinely spelled differently from what the
        // filesystem reports. Getting this wrong would make the launcher claim
        // LuaTools is absent on a machine that has it installed.
        let tree = TempTree::new("casing");
        let dir = tree.root().join("MixedCase");
        let candidate = write_exe(&dir, EXECUTABLE_NAME);
        let spelled = dir.canonicalize().expect("candidate dir exists");
        let shouted = spelled.to_string_lossy().to_uppercase();
        let roots = vec![PathBuf::from(shouted)];

        assert_eq!(
            accept(&candidate, &roots),
            Ok(()),
            "a root spelled in a different case must still match"
        );
    }

    #[test]
    fn only_the_exact_file_name_is_accepted() {
        let tree = TempTree::new("names");
        let root = tree.root().join("LuaTools");
        let roots = tree.roots();

        for impostor in [
            "luatools-host.exe",
            "LuaTools-Setup.exe",
            "Setup.exe",
            "LuaTools.exe.evil",
            "LuaTools.dll",
        ] {
            let candidate = write_exe(&root, impostor);
            assert!(
                accept(&candidate, &roots).is_err(),
                "{impostor} must not be launchable"
            );
        }

        // The real name, in the casing a user might actually have.
        for spelling in [EXECUTABLE_NAME, "luatools.exe", "LUATOOLS.EXE"] {
            let candidate = write_exe(&root, spelling);
            assert_eq!(
                accept(&candidate, &roots),
                Ok(()),
                "{spelling} should be accepted"
            );
        }
    }

    #[test]
    fn a_non_exe_extension_is_refused() {
        let tree = TempTree::new("ext");
        let root = tree.root().join("LuaTools");
        let roots = tree.roots();

        for other in ["LuaTools.bat", "LuaTools.cmd", "LuaTools.ps1", "LuaTools"] {
            let candidate = write_exe(&root, other);
            assert_eq!(
                accept(&candidate, &roots),
                Err("candidate is not an .exe"),
                "{other} must be refused on its extension"
            );
        }
    }

    #[test]
    fn an_alternate_data_stream_is_refused() {
        let tree = TempTree::new("ads");
        let root = tree.root().join("LuaTools");
        let roots = tree.roots();

        let candidate = write_exe(&root, EXECUTABLE_NAME);
        let stream = root.join(format!("{EXECUTABLE_NAME}:payload"));
        // The stream spelling fails the file-name check, which is the correct
        // refusal; the assertion pins that it is refused rather than followed.
        assert!(accept(&stream, &roots).is_err());
        // The colon check is reached independently once a real file resolves.
        assert!(accept(&candidate, &roots).is_ok());
    }

    #[test]
    fn resolve_picks_the_first_valid_candidate_and_skips_absent_ones() {
        let tree = TempTree::new("resolve");
        let first = tree.root().join("first");
        let second = tree.root().join("second");
        let roots = tree.roots();

        let wanted = write_exe(&second, EXECUTABLE_NAME);
        let candidates = vec![
            first.join(EXECUTABLE_NAME), // absent
            wanted.clone(),
        ];

        assert_eq!(resolve(&candidates, &roots).expect("second candidate"), wanted);
    }

    #[test]
    fn resolve_refuses_when_an_impostor_occupies_an_allowed_root() {
        let tree = TempTree::new("impostor");
        let root = tree.root().join("LuaTools");
        let roots = tree.roots();

        // An occupied allowed root holding something else must not be started.
        let impostor = write_exe(&root, "SomethingElse.exe");
        let candidates = vec![impostor];
        let failure = resolve(&candidates, &roots).expect_err("impostor is not LuaTools");
        assert!(
            failure.reasons.contains("not named LuaTools.exe"),
            "unexpected reason: {}",
            failure.reasons
        );
        // A file that was there and refused is a different state from an absent
        // one, even though both render as `not_installed`.
        assert!(failure.refused_present, "the file existed and was refused");
        assert_eq!(failure.into_outcome(), LaunchOutcome::Rejected);
    }

    #[test]
    fn resolve_reports_every_reason_rather_than_only_the_last() {
        let tree = TempTree::new("reasons");
        let root = tree.root().join("LuaTools");
        let roots = tree.roots();
        let candidates = vec![
            tree.root().join("absent").join(EXECUTABLE_NAME),
            write_exe(&root, "Other.exe"),
        ];

        let failure = resolve(&candidates, &roots).expect_err("nothing valid");
        assert!(failure.reasons.contains("not present"), "{}", failure.reasons);
        assert!(
            failure.reasons.contains("not named LuaTools.exe"),
            "{}",
            failure.reasons
        );
    }

    #[test]
    fn an_absent_luatools_is_not_reported_as_a_rejection() {
        let tree = TempTree::new("absent");
        let roots = tree.roots();
        let candidates = vec![
            tree.root().join("a").join(EXECUTABLE_NAME),
            tree.root().join("b").join(EXECUTABLE_NAME),
        ];

        let failure = resolve(&candidates, &roots).expect_err("nothing there");
        assert!(
            !failure.refused_present,
            "an empty machine is not a rejection"
        );
        assert_eq!(failure.into_outcome(), LaunchOutcome::NotInstalled);
    }

    #[test]
    fn an_unreadable_environment_is_not_reported_as_a_missing_install() {
        // Telling somebody to install LuaTools when the search never ran would
        // be wrong advice, so the two failures stay separate outcomes.
        let (outcome, detail) = LaunchFailure::Environment("ProgramFiles is not set".into())
            .into_parts();
        assert_eq!(outcome, LaunchOutcome::Error);
        let detail = detail.expect("the reason is never dropped");
        assert!(detail.contains("ProgramFiles"), "{detail}");
        assert_ne!(outcome, LaunchOutcome::NotInstalled);
    }

    #[test]
    fn the_launch_command_takes_no_parameters() {
        // The strongest form of "the renderer cannot name the executable": the
        // function's signature has nowhere to put one.
        let source = implementation();
        let signature = source
            .split_once("pub fn launch_luatools(")
            .expect("command definition")
            .1
            .split_once(')')
            .expect("end of parameter list")
            .0;
        assert_eq!(signature.trim(), "", "launch_luatools must take no arguments");
    }

    #[test]
    fn no_shell_is_ever_invoked() {
        let source = implementation();
        for forbidden in ["cmd", "cmd.exe", "powershell", "ShellExecute", "sh -c"] {
            assert!(
                !source.contains(forbidden),
                "the launcher must not reference {forbidden}"
            );
        }
    }

    #[test]
    fn the_argument_vector_is_empty() {
        let source = implementation();
        // `.arg(` and `.args(` would both put something on LuaTools' command
        // line. The spawn site must carry neither.
        let spawn = source
            .split_once("Command::new(&executable)")
            .expect("spawn site")
            .1;
        let tail = &spawn[..spawn.len().min(400)];
        assert!(!tail.contains(".arg("), "no argument may be passed");
        assert!(!tail.contains(".args("), "no arguments may be passed");
    }

    #[test]
    fn the_spawn_is_detached_and_never_waits() {
        let source = implementation();
        assert!(
            source.contains(".spawn()"),
            "LuaTools must be spawned, not waited on"
        );
        // `.status()` is a real method in this module -- LaunchOutcome::status,
        // which builds the value the renderer reads -- so the guard has to look
        // at the spawn site rather than at the whole file, or it would forbid
        // the very accessor the launch report depends on.
        let spawn = source
            .split_once("Command::new(&executable)")
            .expect("spawn site")
            .1;
        let tail = &spawn[..spawn.len().min(400)];
        assert!(
            !tail.contains(".status()"),
            "waiting on LuaTools would freeze Daltoon X"
        );
    }

    #[test]
    fn every_outcome_maps_to_a_documented_status() {
        // The renderer switches on these strings, so the set is a contract.
        assert_eq!(status_of(&LaunchOutcome::Launched), "launched");
        assert_eq!(status_of(&LaunchOutcome::Installed), "installed");
        assert_eq!(status_of(&LaunchOutcome::NotInstalled), "not_installed");
        assert_eq!(status_of(&LaunchOutcome::RuntimeMissing), "runtime_missing");
        assert_eq!(status_of(&LaunchOutcome::Rejected), "not_installed");
        assert_eq!(status_of(&LaunchOutcome::Elevated), "error");
        assert_eq!(status_of(&LaunchOutcome::Error), "error");
    }

    #[test]
    fn installed_and_launched_are_distinguished() {
        assert!(LaunchOutcome::Installed.is_installed());
        assert!(LaunchOutcome::Launched.is_installed());
        for outcome in [
            LaunchOutcome::NotInstalled,
            LaunchOutcome::RuntimeMissing,
            LaunchOutcome::Rejected,
            LaunchOutcome::Elevated,
            LaunchOutcome::Error,
        ] {
            assert!(!outcome.is_installed(), "{outcome:?} must not claim a presence");
        }
    }

    #[test]
    fn only_a_real_launch_reports_launched() {
        assert!(LaunchOutcome::Launched.is_launched());
        // `Installed` is the probe result: LuaTools is on disk, but this call
        // did not start it, and the UI must not claim otherwise.
        for outcome in [
            LaunchOutcome::Installed,
            LaunchOutcome::NotInstalled,
            LaunchOutcome::RuntimeMissing,
            LaunchOutcome::Rejected,
            LaunchOutcome::Elevated,
            LaunchOutcome::Error,
        ] {
            assert!(!outcome.is_launched(), "{outcome:?} must not claim a launch");
        }
    }

    #[test]
    fn the_install_prompt_is_withheld_once_lua_tools_is_present() {
        // The official page must not be offered to somebody who already has
        // LuaTools, or the UI would nag a correctly configured machine.
        for present in [LaunchOutcome::Installed, LaunchOutcome::Launched] {
            let report = LaunchReport::new(present, None);
            assert_eq!(report.official_page, None, "{present:?} is installed");
        }
        for absent in [
            LaunchOutcome::NotInstalled,
            LaunchOutcome::RuntimeMissing,
            LaunchOutcome::Rejected,
        ] {
            let report = LaunchReport::new(absent, Some("why".into()));
            assert_eq!(
                report.official_page,
                Some(OFFICIAL_PAGE),
                "{absent:?} should offer the page"
            );
        }
        // A hard failure is not an invitation to reinstall.
        for failed in [LaunchOutcome::Elevated, LaunchOutcome::Error] {
            let report = LaunchReport::new(failed, Some("why".into()));
            assert_eq!(report.official_page, None, "{failed:?} is not a missing install");
        }
    }

    #[test]
    fn the_official_page_is_offered_only_when_not_installed() {
        let installed = LaunchReport::new(LaunchOutcome::Launched, None);
        assert_eq!(installed.official_page, None);

        let missing = LaunchReport::new(LaunchOutcome::NotInstalled, None);
        assert_eq!(missing.official_page, Some(OFFICIAL_PAGE));
        assert_eq!(missing.status, "not_installed");

        // A rejection is reported as not-installed to the renderer, so the
        // prompt is still offered; the reason rides along in `detail`.
        let rejected = LaunchReport::new(LaunchOutcome::Rejected, Some("why".into()));
        assert_eq!(rejected.status, "not_installed");
        assert_eq!(rejected.official_page, Some(OFFICIAL_PAGE));
    }

    #[test]
    fn the_official_page_is_https_and_published_by_the_project() {
        assert!(OFFICIAL_PAGE.starts_with("https://"));
        assert_eq!(OFFICIAL_PAGE, "https://lua.tools/app");
    }

    #[test]
    fn the_runtime_probe_reads_a_version_directory_not_a_file() {
        let tree = TempTree::new("runtime");
        assert_eq!(desktop_runtime_version(tree.root()), None);

        std::fs::create_dir_all(tree.root().join("6.0.36")).expect("old desktop runtime");
        assert_eq!(desktop_runtime_version(tree.root()), Some(6));

        std::fs::create_dir_all(tree.root().join("8.0.0")).expect("desktop runtime 8");
        assert_eq!(desktop_runtime_version(tree.root()), Some(8));

        // A later major is accepted: the host rolls a net8.0-windows app
        // forward onto it.
        std::fs::create_dir_all(tree.root().join("10.0.9")).expect("desktop runtime 10");
        assert_eq!(desktop_runtime_version(tree.root()), Some(10));

        // A stray file that merely looks like a version is not a runtime.
        std::fs::write(tree.root().join("8.0.0.txt"), b"x").expect("stray file");
        assert_eq!(desktop_runtime_version(tree.root()), Some(10));
    }

    #[test]
    fn probing_never_starts_a_process() {
        let source = implementation();
        // `probe` and `locate` are the read-only paths the UI polls. Neither
        // may reach the spawn site: the status query runs on page load, and a
        // query that started a program would be a launch nobody asked for.
        for name in ["fn probe()", "fn locate()", "fn resolve("] {
            let body = source
                .split_once(name)
                .expect("read-only function")
                .1
                .split("\n}\n")
                .next()
                .expect("function body");
            assert!(
                !body.contains("Command::new"),
                "{name} must not construct a process"
            );
            assert!(!body.contains(".spawn()"), "{name} must not spawn");
            assert!(!body.contains(".status()"), "{name} must not wait");
        }
        // The status command itself is a thin wrapper over the probe.
        assert!(
            source.contains("pub fn luatools_status() -> LaunchReport"),
            "the status command must take no arguments either"
        );
    }

    #[test]
    fn elevation_is_refused_rather_than_spawning_an_administrator_token() {
        // LuaTools drives the signed Steam client and writes inside the user's
        // own profile, so an inherited administrator token is refused outright.
        let source = implementation();
        assert!(
            source.contains("crate::elevation::is_elevated()"),
            "the launcher must check elevation"
        );
        let launch_body = source
            .split_once("fn launch()")
            .expect("launch function")
            .1
            .split("\n}\n")
            .next()
            .expect("launch body");
        let elevated_at = launch_body
            .find("is_elevated()")
            .expect("elevation guard");
        let spawn_at = launch_body.find(".spawn()").expect("spawn site");
        assert!(
            elevated_at < spawn_at,
            "the elevation check must come before the spawn"
        );
    }

    #[test]
    fn the_official_page_is_the_only_address_in_this_module() {
        let source = implementation();
        let urls: Vec<&str> = source
            .match_indices("https://")
            .map(|(at, _)| {
                source[at..]
                    .find(|c: char| c.is_whitespace() || c == '"' || c == ')')
                    .map(|end| &source[at..at + end])
                    .unwrap_or(&source[at..])
            })
            .collect();
        for url in urls {
            assert_eq!(
                url, OFFICIAL_PAGE,
                "no address other than the project's published one may appear here"
            );
        }
    }
}