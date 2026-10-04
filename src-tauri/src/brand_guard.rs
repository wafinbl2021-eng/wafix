//! Guard against the previous product names returning to Rust.
//!
//! `scripts/test-brand.mjs` guards the TypeScript side by parsing it with the
//! TypeScript parser, which lets it tell a comment from a string literal. That
//! distinction is the whole point of the guard: a comment explaining *why*
//! something was renamed is documentation and must be allowed, while a literal
//! is something a user can read and must not carry a dead name. `node --test`
//! cannot read Rust, so the same property is enforced here, over Rust sources,
//! by a small scanner written for exactly this purpose.
//!
//! WHAT MAKES THIS A GUARD RATHER THAN A REPORT
//! ============================================
//! 1. It scans string literals only, so a comment cannot satisfy it or trip it.
//! 2. It runs a SELF-TEST in both directions before it believes its own
//!    silence: a snippet whose *comment* names a previous product must yield no
//!    finding, and one whose *literal* names it must. A scanner that has quietly
//!    stopped matching anything would otherwise pass forever.
//! 3. Its allow-list is EXACT — whole literals, never substrings — so one
//!    permitted literal cannot permit a longer one that merely starts the same
//!    way.
//!
//! WHY SOME LITERALS SURVIVE
//! =========================
//! Every entry in `ALLOWED_LITERALS` is a string a user could see that is not
//! this product's name to this product's users. Each carries a written reason.
//! Adding one is a deliberate edit to that list, not an accident of a scan.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Names this product used to ship under. A literal naming either is a finding.
const PREVIOUS_NAMES: [&str; 2] = ["Wafi X", "PC Tweaker"];

/// The current name. A literal containing it is the whole point of the rename,
/// so it is checked for rather than merely tolerated.
const CURRENT_NAME: &str = "Daltoon X";

/// Whole literals permitted to name a previous product, with the reason.
///
/// Keyed by file name so an entry cannot quietly authorise a literal in a
/// different module.
const ALLOWED_LITERALS: [(&str, &str, &str); 5] = [
    (
        "updatewatch.rs",
        "Wafi X Update drift watch",
        "The drift-watch scheduled task. Its name is user-visible in Task \
         Scheduler, and renaming it would orphan the task every installed copy \
         already has registered -- it would keep running under a name no longer \
         connected to the app, and the old task would never be cleaned up. \
         The task is an internal handle, not this product's display name, and \
         updatewatch.rs pins it with its own test.",
    ),
    (
        "updatewatch.rs",
        "Wafi X ",
        "The prefix the test above asserts on, so that the scheduled task name \
         stays tied to a product identity. Changing the string without changing \
         the task would fail that test rather than pass silently.",
    ),
    (
        "license.rs",
        "the previous PC Tweaker licence key must not still be embedded",
        "An assertion message in the licence tests. It describes a historical \
         key that must stay absent; the file is licensing logic and is out of \
         scope for the rename.",
    ),
    (
        "license.rs",
        "PC Tweaker",
        "One of the product strings the licence tests assert must NOT unlock \
         this app. It is the name of the product being refused, so it has to be \
         spelled the way the licence file spells it.",
    ),
    (
        "license.rs",
        "`{product}` must not unlock Wafi X",
        "An assertion message in the licence tests. The phrase names this app \
         historically in the licence format's own vocabulary; the file is \
         licensing logic and is out of scope for the rename.",
    ),
];

/// One string literal found in a source file.
#[derive(Debug, PartialEq, Eq)]
struct Literal {
    file: String,
    line: usize,
    value: String,
}

impl std::fmt::Display for Literal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}: {:?}", self.file, self.line, self.value)
    }
}

/// Extracts every string literal from Rust source, ignoring comments.
///
/// Handles the forms a hand-rolled scanner must get right for this codebase:
/// line comments, nested block comments, byte strings, escapes, character
/// literals, and raw strings with any number of hashes.
fn literals_in(file: &str, source: &str) -> Vec<Literal> {
    #[derive(PartialEq)]
    enum Mode {
        Code,
        LineComment,
        BlockComment(usize),
        Raw(usize),
        Str,
        ByteStr,
    }

    let bytes: Vec<char> = source.chars().collect();
    let mut mode = Mode::Code;
    let mut at = 0usize;
    let mut line = 1usize;
    let mut found = Vec::new();
    // Start of the literal currently being read, for line attribution.
    let mut opened = 0usize;
    let mut raw_body = String::new();
    let mut escaped = false;

    while at < bytes.len() {
        let ch = bytes[at];
        let next = bytes.get(at + 1).copied();
        if ch == '\n' {
            line += 1;
        }

        match mode {
            Mode::Code => match ch {
                '/' if next == Some('/') => {
                    mode = Mode::LineComment;
                    at += 2;
                    continue;
                }
                '/' if next == Some('*') => {
                    mode = Mode::BlockComment(1);
                    at += 2;
                    continue;
                }
                'r' => {
                    // A raw string is `r`, then hashes, then a quote. A bare `r`
                    // followed by neither is an identifier, not a literal.
                    let mut hashes = 0usize;
                    let mut look = at + 1;
                    while bytes.get(look) == Some(&'#') {
                        hashes += 1;
                        look += 1;
                    }
                    if bytes.get(look) == Some(&'"') {
                        raw_body.clear();
                        opened = line;
                        mode = Mode::Raw(hashes);
                        at = look + 1;
                        continue;
                    }
                    at += 1;
                    continue;
                }
                'b' if next == Some('"') => {
                    opened = line;
                    mode = Mode::ByteStr;
                    at += 2;
                    continue;
                }
                'b' if next == Some('\'') => {
                    // Byte character literal: skip the three characters.
                    at += 3;
                    continue;
                }
                '"' => {
                    raw_body.clear();
                    opened = line;
                    escaped = false;
                    mode = Mode::Str;
                    at += 1;
                    continue;
                }
                '\'' => {
                    // Character literal. Skipping naively is safe here because
                    // a lifetime is written without a closing quote on the same
                    // character, so the loop resumes in code.
                    at += 1;
                    while at < bytes.len() {
                        let c = bytes[at];
                        at += 1;
                        if c == '\\' {
                            at += 1;
                            continue;
                        }
                        if c == '\'' || c == '\n' {
                            break;
                        }
                    }
                    continue;
                }
                _ => {
                    at += 1;
                    continue;
                }
            },
            Mode::LineComment => {
                if ch == '\n' {
                    mode = Mode::Code;
                }
                at += 1;
            }
            Mode::BlockComment(depth) => {
                if ch == '/' && next == Some('*') {
                    mode = Mode::BlockComment(depth + 1);
                    at += 2;
                    continue;
                }
                if ch == '*' && next == Some('/') {
                    mode = if depth <= 1 {
                        Mode::Code
                    } else {
                        Mode::BlockComment(depth - 1)
                    };
                    at += 2;
                    continue;
                }
                at += 1;
            }
            Mode::Raw(hashes) => {
                if ch == '"' {
                    // The quote at `at` is the delimiter itself and is already
                    // known; only the hashes still have to match after it. An
                    // empty tail always matches, which is what closes `r"..."`.
                    let rest: String = bytes[at + 1..].iter().collect();
                    let expected: String = std::iter::repeat('#').take(hashes).collect();
                    if rest.starts_with(&expected) {
                        found.push(Literal {
                            file: file.to_string(),
                            line: opened,
                            value: raw_body.clone(),
                        });
                        at += 1 + hashes;
                        mode = Mode::Code;
                        continue;
                    }
                }
                raw_body.push(ch);
                at += 1;
            }
            Mode::Str | Mode::ByteStr => {
                let string_mode = mode == Mode::Str;
                if escaped {
                    escaped = false;
                    raw_body.push(ch);
                    at += 1;
                    continue;
                }
                match ch {
                    '\\' => {
                        escaped = true;
                        raw_body.push(ch);
                        at += 1;
                    }
                    '"' => {
                        if string_mode {
                            found.push(Literal {
                                file: file.to_string(),
                                line: opened,
                                value: raw_body.clone(),
                            });
                        }
                        mode = Mode::Code;
                        at += 1;
                    }
                    // An unterminated string must not swallow the rest of the
                    // file, which would hide every later finding.
                    '\n' => {
                        mode = Mode::Code;
                        at += 1;
                    }
                    _ => {
                        raw_body.push(ch);
                        at += 1;
                    }
                }
            }
        }
    }

    found
}

/// Every `.rs` file under `dir`, sorted so a failure reads the same each run.
fn rust_sources(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// Files the guard does not scan, and why.
///
/// This file holds the allow-list, so it necessarily quotes every literal that
/// list permits. Scanning it would report the guard's own table as findings
/// forever. Its entries are not taken on trust: `every_allowed_literal_exists_where_it_is_claimed`
/// checks each one against the file it names, so an entry that stops matching
/// real code fails the build instead of being skipped.
const EXCLUDED_FILES: [&str; 1] = ["brand_guard.rs"];

/// A literal that names a previous product and is not allow-listed.
fn findings(dir: &Path) -> Vec<Literal> {
    let mut found = Vec::new();
    for path in rust_sources(dir) {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if EXCLUDED_FILES.contains(&name.as_str()) {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(&path) else {
            continue;
        };
        for literal in literals_in(&name, &source) {
            if !PREVIOUS_NAMES
                .iter()
                .any(|old| literal.value.contains(old))
            {
                continue;
            }
            let allowed = ALLOWED_LITERALS
                .iter()
                .any(|(file, value, _)| *file == literal.file && *value == literal.value);
            if !allowed {
                found.push(literal);
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The scanner must not report a previous name that only appears in a
    /// comment. This is the direction that would otherwise make the guard
    /// useless: `license.rs` and `wafx.rs` both explain the rename in prose.
    #[test]
    fn a_previous_name_in_a_comment_is_not_a_finding() {
        let source = r#"
//! Wafi X renamed this product; PC Tweaker is the old name.
// A block comment: /* Wafi X again, and PC Tweaker. */
/* nested /* PC Tweaker */ still a comment */
const LABEL: &str = "Daltoon X";
"#;
        let found = literals_in("sample.rs", source);
        assert_eq!(
            found.iter().map(|l| l.value.as_str()).collect::<Vec<_>>(),
            vec![CURRENT_NAME],
            "only the real literal should be collected"
        );
    }

    /// And the other direction: a literal naming a previous product must be
    /// reported. Without this the guard could stop matching and still pass.
    #[test]
    fn a_previous_name_in_a_literal_is_a_finding() {
        let source = r#"
const TITLE: &str = "Wafi X";
const LEGACY: &str = "PC Tweaker";
"#;
        let values: Vec<String> = literals_in("sample.rs", source)
            .into_iter()
            .map(|l| l.value)
            .collect();
        assert!(values.iter().any(|v| v.contains("Wafi X")), "{values:?}");
        assert!(values.iter().any(|v| v.contains("PC Tweaker")), "{values:?}");
    }

    /// Raw strings, hashes, escapes and byte strings, because a scanner that
    /// mishandles any of them would silently stop covering real literals.
    #[test]
    fn every_literal_form_is_read() {
        let source = r#####"
const PLAIN: &str = "plain \"quoted\" text";
const RAW: &str = r"raw \n text";
const HASHED: &str = r#"hashed "inner" text"#;
const MANY: &str = r###"deep "## inner"###;
const BYTES: &[u8] = b"bytes";
const CHARS: char = '"';
const NESTED: char = '\'';
"#####;
        let values: Vec<String> = literals_in("sample.rs", source)
            .into_iter()
            .map(|l| l.value)
            .collect();
        for expected in ["plain \\\"quoted\\\" text", "raw \\n text", "hashed \"inner\" text", "deep \"## inner"] {
            assert!(
                values.iter().any(|v| v == expected),
                "missing {expected:?} in {values:?}"
            );
        }
        assert!(!values.iter().any(|v| v == "bytes"), "byte strings are not text literals");
        assert_eq!(values.len(), 4, "{values:?}");
    }

    /// An unterminated string must not swallow the remainder of the file, or a
    /// single typo would hide every later finding.
    #[test]
    fn an_unterminated_string_does_not_hide_later_literals() {
        let source = "const A: &str = \"never closed\nconst B: &str = \"Wafi X\";\n";
        let values: Vec<String> = literals_in("sample.rs", source)
            .into_iter()
            .map(|l| l.value)
            .collect();
        assert!(
            values.iter().any(|v| v == "Wafi X"),
            "the later literal should still be seen: {values:?}"
        );
    }

    /// The allow-list is whole literals. A permitted literal must not permit a
    /// longer one that merely starts the same way.
    #[test]
    fn the_allow_list_matches_whole_literals_only() {
        let (file, allowed, _) = ALLOWED_LITERALS[1];
        assert_eq!(file, "updatewatch.rs");
        assert_eq!(allowed, "Wafi X ");
        // The permitted one matches; a longer one with the same start does not.
        let is_allowed = |value: &str| {
            ALLOWED_LITERALS
                .iter()
                .any(|(f, v, _)| *f == file && *v == value)
        };
        assert!(is_allowed("Wafi X "));
        assert!(!is_allowed("Wafi X Update drift watch and more"));
        // And it is scoped to its own file.
        let elsewhere = ALLOWED_LITERALS
            .iter()
            .any(|(f, v, _)| *f == "other.rs" && *v == allowed);
        assert!(!elsewhere);
    }

    /// Every allow-list entry must be an exact whole literal that genuinely
    /// exists in the file it names, with a written reason. Otherwise the list
    /// rots into a list of permissions for strings nobody has.
    #[test]
    fn every_allowed_literal_exists_where_it_is_claimed() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut grouped: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (file, value, reason) in ALLOWED_LITERALS {
            assert!(
                reason.len() > 40,
                "{file}: the entry for {value:?} needs a real reason"
            );
            grouped.entry(file).or_default().push(value);
        }
        for (file, values) in grouped {
            let path = dir.join(file);
            assert!(path.is_file(), "{file} does not exist");
            let source = std::fs::read_to_string(&path).expect("readable source");
            let present: Vec<String> = literals_in(file, &source)
                .into_iter()
                .map(|l| l.value)
                .collect();
            for value in values {
                assert!(
                    present.iter().any(|v| v == value),
                    "{file} no longer contains the literal {value:?}; remove its allow-list entry"
                );
            }
        }
    }

    /// The guard itself, over the real tree.
    #[test]
    fn no_rust_string_literal_names_a_previous_product() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let found = findings(&dir);
        assert!(
            found.is_empty(),
            "Rust string literals naming a previous product, which a user could read: {}",
            found
                .iter()
                .map(Literal::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    /// The rename did reach Rust. Without this the guard above would also pass
    /// on a tree that never mentioned either name.
    #[test]
    fn rust_does_name_the_current_product() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mentioned = rust_sources(&dir)
            .into_iter()
            .filter_map(|path| {
                let source = std::fs::read_to_string(&path).ok()?;
                let name = path.file_name()?.to_string_lossy().into_owned();
                literals_in(&name, &source)
                    .into_iter()
                    .any(|l| l.value.contains(CURRENT_NAME))
                    .then_some(name)
            })
            .count();
        assert!(
            mentioned > 0,
            "no Rust literal names {CURRENT_NAME:?}; the guard would be vacuous"
        );
    }
}
