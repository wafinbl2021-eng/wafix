//! No spawned process may flash a console window.
//!
//! This application shells out constantly — powershell, defrag, sc, powercfg,
//! ipconfig, nvidia-smi, taskkill — and on Windows every one of those opens a
//! console window unless the spawn asks it not to. On a consumer desktop tool
//! that reads as a black box blinking on screen while the app works: not a
//! crash, not an error, just something that makes a tweaking utility look
//! exactly like the malware people are afraid it is.
//!
//! Every one of the current spawn sites gets this right. That is the problem
//! this test exists for. The flag is repeated by hand in twenty modules, each
//! declaring its own `const CREATE_NO_WINDOW`, so the invariant is held by
//! nothing but the discipline of whoever writes the next one — and the next
//! one is a single missing line in a builder chain that compiles, runs, does
//! the right thing on the developer's machine if they never look at the
//! screen, and ships.
//!
//! The check reads the source rather than the behaviour because the behaviour
//! only shows up on Windows, in a release build, to somebody watching. A
//! shared helper would be the stronger fix — one place to get right instead of
//! twenty-three — but that is a change to twenty working modules, and this
//! catches the omission either way.
//!
//!   cargo test --test console_windows

use std::path::{Path, PathBuf};

/// `runas` is the elevation path. It exists to raise a UAC prompt, which is a
/// window the user is supposed to see, and `runas::Command` has no
/// `creation_flags` to set in the first place.
const EXEMPT: &str = "runas::";

/// A builder chain longer than this is not a chain, it is a parse failure.
const MAX_STATEMENT_LINES: usize = 16;

/// Guards against this test passing because it found nothing: a moved
/// directory, a renamed module, or a switch to some other spawn API would
/// otherwise leave a green tick over an empty list. Well under the count
/// today, so ordinary deletions do not trip it.
const MINIMUM_EXPECTED_SITES: usize = 15;

fn rust_files(dir: &Path, into: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, into);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            into.push(path);
        }
    }
}

/// The line with every string literal's contents and any trailing comment
/// removed, leaving only what the compiler reads as code.
///
/// A text search cannot otherwise tell a spawn site from a test that mentions
/// one, and three tests here had to mention one: they assert that some module's
/// source does *not* contain `Command::new`, which is the correct way to write
/// that assertion and reads to a grep exactly like the thing being checked for.
/// Those three false positives were not harmless — they made this check fail, so
/// the twenty-odd real sites it exists to protect were going unverified.
///
/// Contents are blanked rather than the line dropped so column positions in the
/// reported message still line up with the source it is quoting.
fn code_only(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
                out.push('"');
            }
            continue;
        }
        match ch {
            // A line comment ends the line. Only reachable outside a string,
            // because the branch above consumes string contents whole — so the
            // `//` in `"https://host/path"` cannot truncate the line here.
            '/' if chars.peek() == Some(&'/') => break,
            '"' => {
                in_string = true;
                out.push('"');
            }
            _ => out.push(ch),
        }
    }
    out
}

/// The property the scan now depends on, asserted directly so an edit to
/// `code_only` cannot quietly put the false positives back.
#[test]
fn the_scan_reads_code_and_not_the_text_that_mentions_it() {
    // Real spawn sites are still seen, in full.
    assert!(code_only("let mut command = Command::new(&path);").contains("Command::new"));
    assert!(code_only("Command::new(&x).creation_flags(CREATE_NO_WINDOW);")
        .contains("creation_flags"));
    assert!(code_only("runas::Command::new(\"powershell\")").contains("runas::"));

    // A spawn site named inside a string is not a spawn site.
    assert!(!code_only(r#".split_once("Command::new(&executable)")"#).contains("Command::new"));
    assert!(!code_only(r#"assert!(!body.contains("Command::new"));"#).contains("Command::new"));
    assert!(!code_only(r#"let needle = "Command::new";"#).contains("Command::new"));

    // Nor is one named in a comment, which is where the fix instructions live.
    assert!(!code_only("// add .creation_flags(CREATE_NO_WINDOW) to the chain")
        .contains("creation_flags"));

    // A `//` inside a string is data, not the start of a comment, so code after
    // the closing quote on the same line survives.
    assert!(code_only(r#"let a = "https://host.test/x.exe"; let b = 1;"#).contains("let b = 1"));

    // An escaped quote does not end the string early, so a needle cannot be
    // smuggled past the scan by writing it after an escaped `\"`.
    assert!(!code_only(r#"let n = "a \"Command::new\" b";"#).contains("Command::new"));
}

#[test]
fn every_spawned_process_is_told_not_to_open_a_console() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&root, &mut files);
    files.sort();

    let mut sites = 0usize;
    let mut unguarded = Vec::new();

    for file in &files {
        let Ok(source) = std::fs::read_to_string(file) else {
            continue;
        };
        let lines: Vec<&str> = source.lines().collect();
        // What the compiler sees, line for line. Every match below is made
        // against this rather than the raw text, so a module that only *writes*
        // about spawn sites is not counted as having one.
        let code: Vec<String> = lines.iter().map(|line| code_only(line)).collect();

        for (index, line) in lines.iter().enumerate() {
            let seen = &code[index];
            if (!seen.contains("Command::new") && !seen.contains("crate::system_tools::run("))
                || seen.contains(EXEMPT)
            {
                continue;
            }
            sites += 1;

            // The whole builder chain, which is where the flag goes — not
            // just the line that names the program.
            let mut statement = String::new();
            for (offset, next) in code.iter().skip(index).take(MAX_STATEMENT_LINES).enumerate() {
                statement.push_str(next);
                statement.push('\n');
                // The shared helper sets creation_flags in the next statement
                // after binding its Command. Chained builders end normally.
                if next.trim_end().ends_with(';')
                    && !(offset == 0 && next.contains("let mut command = Command::new"))
                {
                    break;
                }
            }

            // system_tools::run sets this on its Command centrally; that
            // Command::new site is checked by this same traversal.
            if !statement.contains("creation_flags")
                && !seen.contains("crate::system_tools::run(")
            {
                let name = file
                    .strip_prefix(&root)
                    .unwrap_or(file)
                    .to_string_lossy()
                    .replace('\\', "/");
                // The original line, not the stripped one: the message has to
                // quote the source the reader is going to go and edit.
                unguarded.push(format!("src/{name}:{}  {}", index + 1, line.trim()));
            }
        }
    }

    assert!(
        sites >= MINIMUM_EXPECTED_SITES,
        "only found {sites} spawn sites under {} — this check is looking in the wrong place, \
         or the code stopped using std::process::Command",
        root.display()
    );

    assert!(
        unguarded.is_empty(),
        "{} spawn site(s) would flash a console window. Add \
         `.creation_flags(CREATE_NO_WINDOW)` to the builder chain \
         (`const CREATE_NO_WINDOW: u32 = 0x0800_0000;`, with \
         `use std::os::windows::process::CommandExt;`):\n  {}",
        unguarded.len(),
        unguarded.join("\n  ")
    );
}
