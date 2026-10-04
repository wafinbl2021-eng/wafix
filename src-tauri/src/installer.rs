//! Turning Wafi X catalog metadata into a local installer launch.
//!
//! The API never sends a command line. It sends an `installer_type` (`exe` or
//! `msi`) and an `installer_mode` (`silent`, `passive` or `interactive`), both
//! drawn from closed sets, and this module maps that pair to an argument
//! vector that is fixed here. No network string is ever passed as a shell
//! command, an arbitrary argument, or a program name: the only thing that
//! reaches the command line verbatim is the path to the file that was just
//! downloaded and hash-verified, and even that is quoted as an `OsString`.
//!
//! Adding a mode means adding it to [`INSTALLER_MODES`] and to the match below.
//! The `_ => {}` arms at the end of those matches are unreachable because
//! [`check_supported`] has already refused everything outside the closed set;
//! they exist so the match compiles without a panic path, and they add no
//! arguments. Anything that bypasses that check would not compile.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The three installer modes the catalog may name. Anything else is refused
/// rather than treated as "interactive" or "run with no arguments".
pub const INSTALLER_MODES: [&str; 3] = ["silent", "passive", "interactive"];

/// The two installer container types the catalog may name.
pub const INSTALLER_TYPES: [&str; 2] = ["exe", "msi"];

/// The program an MSI is launched through. Named once so the mapping and the
/// test that audits it cannot drift apart. Resolved through `PATH` when the
/// process is spawned, never as a path built from catalog text.
const MSI_LAUNCHER: &str = "msiexec.exe";

/// The program and arguments for one verified installer.
///
/// `program` is either the downloaded file (`exe`) or `msiexec.exe`; `args`
/// are the fixed switches for the requested mode plus, for MSI, the file path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallerCommand {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

pub fn is_known_type(installer_type: &str) -> bool {
    INSTALLER_TYPES.contains(&installer_type)
}

pub fn is_known_mode(mode: &str) -> bool {
    INSTALLER_MODES.contains(&mode)
}

/// Refuses a container/mode pair this build cannot launch. Called before a
/// download starts so the caller fails in milliseconds rather than after a long
/// transfer, and again inside [`command_for`] so the mapping cannot be used
/// without it.
pub fn check_supported(installer_type: &str, mode: &str) -> Result<(), String> {
    if !is_known_type(installer_type) {
        return Err(format!("unsupported installer type: {installer_type}"));
    }
    if !is_known_mode(mode) {
        return Err(format!("unsupported installer mode: {mode}"));
    }
    Ok(())
}

/// Maps `(installer_type, installer_mode)` plus an already-verified file to the
/// exact command to run.
///
/// For `exe` the file is the program and the mode contributes at most one
/// quiet switch. For `msi` the program is `msiexec.exe` and the file is the
/// `/i` argument. Unknown types or modes return an error so a malformed (or
/// hostile) catalog row can never fall through to a launch.
pub fn command_for(
    installer_type: &str,
    mode: &str,
    file: &Path,
) -> Result<InstallerCommand, String> {
    // Checked up front rather than inside the match arms, so the "unknown mode"
    // question has exactly one answer in one place. Both of these are closed
    // sets; nothing downstream re-derives them.
    check_supported(installer_type, mode)?;

    let mut args: Vec<OsString> = Vec::new();
    let program = match installer_type {
        "msi" => {
            args.push(OsString::from("/i"));
            args.push(file.as_os_str().to_os_string());
            match mode {
                "silent" => {
                    args.push(OsString::from("/qn"));
                    args.push(OsString::from("/norestart"));
                }
                "passive" => {
                    args.push(OsString::from("/qb"));
                    args.push(OsString::from("/norestart"));
                }
                // Both members of the closed set, so this arm is reachable.
                _ => {}
            }
            PathBuf::from(MSI_LAUNCHER)
        }
        // Likewise: `exe` is the only other type `check_supported` allows.
        _ => {
            match mode {
                // NSIS and Inno both read `/S` as "do not ask the user
                // anything". Neither framework has a separate passive tier, so
                // passive shares that one switch rather than inventing an
                // argument the installer would ignore. `interactive` adds
                // nothing and lets the installer draw its own UI.
                "silent" | "passive" => args.push(OsString::from("/S")),
                _ => {}
            }
            file.to_path_buf()
        }
    };

    Ok(InstallerCommand { program, args })
}

/// What the installer process did.
#[derive(Debug, Clone, serde::Serialize)]
pub struct InstallOutcome {
    /// `None` when the process was terminated by a signal (or Windows killed
    /// it) rather than exiting with a code.
    pub exit_code: Option<i32>,
    pub success: bool,
    /// Whether the bytes that ran were compared against a checksum the catalog
    /// published.
    ///
    /// This is a fact about what happened, not a quality score. `false` means the
    /// version published no digest: the download still went out over HTTPS, the
    /// container header was still checked, and the installer still ran - but
    /// nothing pinned those bytes to a value anyone recorded beforehand. Anything
    /// reporting on the install must carry that distinction rather than implying
    /// a check that did not happen.
    ///
    /// Set by the caller in `wafx::install_wafx_app`, which is the only place
    /// that knows whether a digest was published. It is not derived here, because
    /// this module never sees the catalog row.
    pub verified: bool,
}

/// Runs a command produced by [`command_for`].
///
/// The caller must have already established that the file may run: the container
/// header matches the declared type, and the digest matched the catalog's if the
/// catalog published one. When it published none, the caller sets
/// [`InstallOutcome::verified`] to `false` - this function has no way to know,
/// and reports only what it observed about the process.
#[cfg(windows)]
pub fn run(command: &InstallerCommand) -> Result<InstallOutcome, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // GUI installers ignore this flag; console installers (msiexec) get no
    // flashing black window. `msiexec` self-elevates when it needs to, and the
    // downloaded file is launched as the current user, never with a shell.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let status = Command::new(&command.program)
        .args(&command.args)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("could not start the installer: {e}"))?;

    Ok(InstallOutcome {
        exit_code: status.code(),
        success: status.success(),
        // A placeholder the caller replaces: this function never learns whether
        // the catalog published a checksum.
        verified: false,
    })
}

#[cfg(not(windows))]
pub fn run(_command: &InstallerCommand) -> Result<InstallOutcome, String> {
    Err("installing applications is only supported on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_as_strings(command: &InstallerCommand) -> Vec<String> {
        command
            .args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn msi_modes_map_to_fixed_msiexec_arguments() {
        let file = Path::new(r"C:\Users\w\AppData\Roaming\wafx\downloads\firefox-1.0.msi");

        let silent = command_for("msi", "silent", file).unwrap();
        assert_eq!(silent.program, PathBuf::from(MSI_LAUNCHER));
        assert_eq!(
            args_as_strings(&silent),
            vec![
                "/i".to_string(),
                file.to_string_lossy().into_owned(),
                "/qn".to_string(),
                "/norestart".to_string(),
            ],
        );

        let passive = command_for("msi", "passive", file).unwrap();
        assert_eq!(
            args_as_strings(&passive),
            vec![
                "/i".to_string(),
                file.to_string_lossy().into_owned(),
                "/qb".to_string(),
                "/norestart".to_string(),
            ],
        );

        let interactive = command_for("msi", "interactive", file).unwrap();
        assert_eq!(
            args_as_strings(&interactive),
            vec!["/i".to_string(), file.to_string_lossy().into_owned()],
        );
    }

    #[test]
    fn exe_modes_are_quiet_or_bare() {
        let file = Path::new(r"C:\Users\w\AppData\Roaming\wafx\downloads\setup.exe");

        assert_eq!(
            command_for("exe", "silent", file).unwrap(),
            InstallerCommand {
                program: file.to_path_buf(),
                args: vec![OsString::from("/S")],
            },
        );
        assert_eq!(
            command_for("exe", "passive", file).unwrap(),
            InstallerCommand {
                program: file.to_path_buf(),
                args: vec![OsString::from("/S")],
            },
        );
        assert_eq!(
            command_for("exe", "interactive", file).unwrap(),
            InstallerCommand {
                program: file.to_path_buf(),
                args: Vec::new(),
            },
        );
    }

    #[test]
    fn unknown_type_or_mode_is_refused() {
        let file = Path::new("installer.exe");

        // A mode that looks like it carries arguments must not become one.
        assert!(command_for("exe", "silent; calc.exe", file).is_err());
        assert!(command_for("exe", "--quiet --run=setup.exe", file).is_err());
        assert!(command_for("exe", "", file).is_err());
        assert!(command_for("bat", "silent", file).is_err());
        assert!(command_for("powershell", "silent", file).is_err());
        assert!(command_for("", "silent", file).is_err());
    }

    #[test]
    fn the_only_network_value_in_the_command_is_the_verified_path() {
        // Whatever an app is called, none of its metadata becomes an argument:
        // the mapping only sees the type, the mode and the local file.
        let file = Path::new(r"C:\downloads\thing.exe");
        let command = command_for("exe", "silent", file).unwrap();
        let rendered = args_as_strings(&command).join(" ");
        assert!(!rendered.contains("cmd"));
        assert!(!rendered.contains("powershell"));
        assert!(!rendered.contains("http"));
        assert_eq!(command.program, file.to_path_buf());
    }

    #[test]
    fn no_mode_or_type_string_is_ever_concatenated_into_an_argument() {
        // The strongest form of the closed-set claim: whatever is handed to
        // `command_for`, every argument is either a literal from the match
        // arms above or the caller-supplied file path. Nothing is built with
        // `format!` from catalog text, so there is no concatenation to poison.
        let file = Path::new(r"C:\downloads\thing.msi");
        let allowed_args = [
            "/i", "/qn", "/qb", "/norestart", "/S",
            // The only non-literal: the verified path, exactly as given.
            &file.to_string_lossy(),
        ];

        for installer_type in INSTALLER_TYPES {
            for mode in INSTALLER_MODES {
                let command =
                    command_for(installer_type, mode, file).expect("closed-set combination");
                for arg in &command.args {
                    let text = arg.to_string_lossy();
                    assert!(
                        allowed_args.iter().any(|allowed| allowed == &text),
                        "{installer_type}/{mode} produced an unexpected argument: {text}"
                    );
                }
                assert!(
                    command.program == file || command.program == Path::new(MSI_LAUNCHER),
                    "{installer_type}/{mode} ran an unexpected program: {:?}",
                    command.program
                );
            }
        }
    }

    #[test]
    fn every_closed_set_combination_produces_a_command() {
        // Six combinations, all of which the catalog is allowed to publish.
        let file = Path::new("setup.exe");
        for installer_type in INSTALLER_TYPES {
            for mode in INSTALLER_MODES {
                assert!(
                    command_for(installer_type, mode, file).is_ok(),
                    "{installer_type}/{mode} should be supported"
                );
                assert!(check_supported(installer_type, mode).is_ok());
            }
        }
        // And the sets are exactly what the API documents: two containers,
        // three modes.
        assert_eq!(INSTALLER_TYPES, ["exe", "msi"]);
        assert_eq!(INSTALLER_MODES, ["silent", "passive", "interactive"]);
    }
}
