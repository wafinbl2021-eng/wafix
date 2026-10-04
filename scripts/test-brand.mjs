// Phase 7 — the rename guard.
//
// WHAT THIS PROVES
// ================
// After the rename, no string literal in `src/` names the previous product.
// The old name reached users through exactly one channel — the translation
// table — so the guard reads the *code*, not the file text: `App.css` and
// `lib.ts` are allowed to keep saying "PC Tweaker" in prose, because a comment
// that explains why something was renamed is documentation, not a shipped
// string. A text scan could not tell those apart.
//
// THREE THINGS MAKE THIS A GUARD RATHER THAN A REPORT
// =====================================================
// 1. It scans string literals and identifiers via the TypeScript parser, so a
//    comment cannot satisfy it or trip it.
// 2. It runs a SELF-TEST in both directions before it believes its own silence:
//    a synthetic file whose *comment* names the old product must not be
//    reported, and one whose *string literal* names it must be. A guard that
//    has quietly stopped matching anything would otherwise pass forever.
// 3. Its allow-list is EXACT — whole literals, never substrings — so
//    "pc-tweaker-token" being permitted cannot also permit
//    "pc-tweaker-token-and-more".
//
// WHY SOME SURVIVORS ARE ALLOWED
// ===============================
// Exactly three literals are permitted to name the previous product, each with
// a written reason in EXACT_ALLOWED_LITERALS:
//   * `pc-tweaker-token` / `pc-tweaker-email` — purge-only credential cleanup.
//     They are named after the old product because that is literally the key
//     that exists in a user's browser: renaming them would stop the deletion,
//     leaving a bearer token in localStorage that nobody ever revokes.
//   * `pctweaker` — the `product` field on the lifetime-offer payload, which is
//     authored by the *other* product's backend. It is a wire identifier for a
//     third-party server, never displayed.
// Every other occurrence was a name this app shows, and every one of those has
// been renamed. Adding a survivor is a deliberate edit to this file.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

// Every spelling of the previous product that could reach a user, lowercased:
// the spaced display name, the hyphenated storage-key shape, and the run-together
// host shape. Matching case-insensitively matters — `PCTweaker` and `pctweaker`
// are the same brand, and a case-sensitive list would let one of them through.
const OLD_BRAND = ["pc tweaker", "pc-tweaker", "pctweaker"];

/**
 * Whole string literals in `src/` that are permitted to name the previous
 * product, each with the reason it is exempt. Exact matches only — the bare
 * literal `"pctweaker"` permits that product id and nothing containing it.
 */
const EXACT_ALLOWED_LITERALS = [
  {
    literal: '"pc-tweaker-token"',
    why: "purge-only credential cleanup; renaming it would stop the deletion",
  },
  {
    literal: '"pc-tweaker-email"',
    why: "purge-only credential cleanup; renaming it would stop the deletion",
  },
  {
    literal: '"pctweaker"',
    why: "the `product` field on the lifetime-offer payload, which is authored by " +
      "PC Tweaker's own backend (backend/). It is a wire identifier for a " +
      "third-party server, not a name this app displays: changing it would make " +
      "parseLifetimeOffer reject every real offer. Pro/licensing behaviour is " +
      "out of Phase 7 scope.",
  },
];

const ALLOWED = new Set(EXACT_ALLOWED_LITERALS.map((entry) => entry.literal));
const REASON_FOR = new Map(EXACT_ALLOWED_LITERALS.map((entry) => [entry.literal, entry.why]));

const namesOldBrand = (text) => {
  const lower = String(text).toLowerCase();
  return OLD_BRAND.some((brand) => lower.includes(brand));
};

/** Every TypeScript/TSX file under `src/`, as repo-relative posix paths. */
function sourceFiles(dir = path.join(root, "src")) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return found;
}

/**
 * The string literals and identifiers a TypeScript source *contains in code*.
 *
 * Comments are never visited, so prose cannot satisfy or trip a guard. Written
 * to take text rather than a path so the self-test below can feed it a
 * synthetic file that does not exist on disk.
 */
function scan(relative, text) {
  const file = ts.createSourceFile(
    relative,
    text,
    ts.ScriptTarget.ES2022,
    true,
    relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const literals = [];
  const identifiers = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    // `.text` is the cooked value with quotes stripped; `getText` is the raw
    // source form. Quoted forms use the cooked value, templates the raw one
    // (their interpolations are code, and an old product name inside one is
    // still a hit).
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
    else if (ts.isTemplateExpression(node)) literals.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { literals, identifiers };
}

const cache = new Map();
function scanFile(relative) {
  if (!cache.has(relative)) cache.set(relative, scan(relative, read(relative)));
  return cache.get(relative);
}

/** Every naming of the old product found in the code of `src/**`. */
function oldBrandInSrc() {
  const found = [];
  for (const relative of sourceFiles()) {
    const { literals, identifiers } = scanFile(relative);
    for (const literal of literals) {
      if (!namesOldBrand(literal)) continue;
      found.push({ where: relative, kind: "literal", text: literal, raw: JSON.stringify(literal) });
    }
    for (const name of identifiers) {
      if (!namesOldBrand(name)) continue;
      found.push({ where: relative, kind: "identifier", text: name, raw: name });
    }
  }
  return found;
}

// ------------------------------------------------------------- self-testing --

test("the scanner still recognises the old product in a string literal", () => {
  // If the parser call above ever stops visiting literals — a TypeScript
  // upgrade changing the node shapes, a refactor to a regex — every assertion
  // below would pass for the wrong reason. Prove the instrument works first.
  const { literals } = scan("synthetic.ts", 'export const a = "PC Tweaker";');
  assert.ok(
    literals.some((l) => l.includes("PC Tweaker")),
    `the scanner found no literal in ${JSON.stringify(literals)}; it cannot be trusted to find one`,
  );

  const template = scan("synthetic.ts", "export const a = `PC Tweaker ${x}`;");
  assert.ok(
    template.literals.some((l) => l.includes("PC Tweaker")),
    "a template literal naming the old product must be visible to the scanner",
  );

  const ident = scan("synthetic.ts", "export const PC_Tweaker_Legacy = 1;");
  assert.ok(
    ident.identifiers.has("PC_Tweaker_Legacy"),
    "an identifier naming the old product must be visible to the scanner",
  );
});

test("the scanner is not fooled by a comment", () => {
  // The whole reason this guard parses instead of grepping. Documentation that
  // names the old product is allowed and must not be reported; if it were, the
  // guard would be unusable rather than strict.
  const line = scan("synthetic.ts", '// PC Tweaker used to live here\nexport const a = 1;');
  assert.deepEqual(line.literals, [], `a comment produced literals: ${JSON.stringify(line.literals)}`);
  assert.ok(!line.identifiers.has("PC Tweaker"), "a comment produced an identifier");

  const block = scan("synthetic.ts", "/* PC Tweaker\n   PCTweaker */\nexport const a = 1;");
  assert.deepEqual(block.literals, [], "a block comment produced literals");
});

test("the detector matches every spelling it claims to, in any case", () => {
  // The other direction: a spelling added to OLD_BRAND but never actually
  // matched would make the allow-list look unnecessary and hide a real hit.
  const spellings = [
    ...OLD_BRAND,
    // The display-name and acronym capitalisations that a careless edit would
    // reintroduce. Matching is case-insensitive, so these must all be caught.
    "PC Tweaker",
    "PC Tweaker Pro",
    "PcTweaker",
    "PCTWEAKER",
    "pctweaker.app",
  ];
  for (const spelling of spellings) {
    const { literals } = scan("synthetic.ts", `export const a = "${spelling}";`);
    assert.ok(
      literals.some((l) => namesOldBrand(l)),
      `a literal containing ${JSON.stringify(spelling)} was not detected`,
    );
  }
  // And something that merely looks similar must NOT be reported, or the guard
  // would cry wolf on ordinary words.
  for (const innocent of ["tweak", "pc", "pct", "tweaked", "wafix", "wafix.json"]) {
    assert.equal(
      namesOldBrand(innocent),
      false,
      `${JSON.stringify(innocent)} is not the old brand and must not be reported`,
    );
  }
});

test("the exact allow-list cannot be satisfied by a longer literal", () => {
  // Substring allow-listing is the failure mode being closed here: if
  // `"pctweaker"` were matched as a substring, then a brand new user-visible
  // string containing it would sail through unreported.
  for (const allowed of ALLOWED) {
    const inner = allowed.slice(1, -1);
    for (const probe of [`${inner}-and-more`, `prefix-${inner}`, `${inner}.json`]) {
      const raw = JSON.stringify(probe);
      assert.notEqual(raw, allowed, `the synthetic probe ${raw} must differ from the allowed literal`);
      assert.ok(
        namesOldBrand(probe),
        `${raw} contains the old brand, so it is exactly the case that must be caught`,
      );
      assert.ok(!ALLOWED.has(raw), `${raw} is not allowed; a substring match would have permitted it`);
    }
  }
});

// ------------------------------------------------------------------- rename --

test("no user-visible string in src/ names the previous product", () => {
  const found = oldBrandInSrc();
  const unexpected = found.filter((hit) => !ALLOWED.has(hit.raw));
  assert.deepEqual(
    unexpected.map((h) => `${h.where}: ${h.raw}`),
    [],
    `these name the previous product and are not on the exact allow-list:\n${unexpected
      .map((h) => `  ${h.where} ${h.kind} ${h.raw}`)
      .join("\n")}`,
  );
});

test("the only survivors are the three literals on the allow-list", () => {
  const found = oldBrandInSrc();
  // Distinct literals, not occurrences: `lifetime-offer.ts` names the product id
  // three times and that is one decision, not three.
  const survivors = [...new Set(found.map((h) => h.raw))].sort();
  assert.deepEqual(
    survivors,
    [...ALLOWED].sort(),
    `the set of permitted survivors changed. Add the new one to EXACT_ALLOWED_LITERALS ` +
      `deliberately, with a reason.\nfound:   ${JSON.stringify(survivors)}\n` +
      `allowed: ${JSON.stringify([...ALLOWED].sort())}`,
  );
  // Every exemption carries a written reason, so the list cannot grow silently.
  for (const entry of EXACT_ALLOWED_LITERALS) {
    assert.ok(
      typeof entry.why === "string" && entry.why.length > 30,
      `${entry.literal} has no justification on the allow-list`,
    );
  }
  // And every allowed literal must still be used, so a stale exemption cannot
  // quietly widen the surface it covers.
  for (const literal of ALLOWED) {
    assert.ok(
      found.some((h) => h.raw === literal),
      `${literal} is on the allow-list but nothing in src/ uses it any more; remove it`,
    );
  }
});

test("the surviving keys are the purge targets, and nothing writes them", () => {
  // The allow-list above is only safe because these two are read-and-deleted.
  // If something started writing either key, a credential would be stored in
  // web storage again and the exemption would no longer be justified.
  const lib = scanFile("src/lib.ts");
  for (const key of ["pc-tweaker-token", "pc-tweaker-email"]) {
    assert.ok(lib.literals.includes(key), `${key} should still be named in src/lib.ts`);
  }
  const body = read("src/lib.ts");
  for (const call of ["setItem(LEGACY_TOKEN_KEY", "setItem(LEGACY_EMAIL_KEY"]) {
    assert.ok(
      !body.includes(call),
      `nothing may write a purge-only key, but src/lib.ts contains ${call}`,
    );
  }
  assert.match(read("src/lib.ts"), /removeItem\(LEGACY_TOKEN_KEY\)/, "the token key must be deleted");
  assert.match(read("src/lib.ts"), /removeItem\(LEGACY_EMAIL_KEY\)/, "the email key must be deleted");
});

// ----------------------------------------------------------------- app name --

test("the app is called Daltoon X in every locale", async () => {
  const { STRINGS, LANGUAGES } = await import(await bundleI18n());

  const declared = LANGUAGES.map((l) => l.code);
  const shipped = Object.keys(STRINGS);
  assert.deepEqual(
    [...declared].sort(),
    [...shipped].sort(),
    `LANGUAGES lists ${JSON.stringify(declared)} but STRINGS ships ${JSON.stringify(shipped)}`,
  );
  assert.ok(shipped.length > 0, "no locales found — the guard is pointed at nothing");

  for (const locale of shipped) {
    assert.equal(
      STRINGS[locale].appName,
      "Daltoon X",
      `${locale}.appName is ${JSON.stringify(STRINGS[locale].appName)}; it must be "Daltoon X"`,
    );
  }
});

test("no locale's prose still names the previous product", async () => {
  const { STRINGS } = await import(await bundleI18n());
  const offenders = [];
  const walk = (value, keyPath, locale) => {
    if (typeof value === "string") {
      if (namesOldBrand(value)) offenders.push(`${locale}:${keyPath} = ${value}`);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${keyPath}[${i}]`, locale));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, keyPath ? `${keyPath}.${k}` : k, locale);
    }
  };
  for (const [locale, table] of Object.entries(STRINGS)) walk(table, "", locale);

  assert.deepEqual(offenders, [], `prose still names the previous product:\n${offenders.join("\n")}`);
});

/** Bundles `src/i18n.ts` to a data URL so the real, shipped table can be read. */
async function bundleI18n() {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { build } = require("esbuild");
  const bundled = await build({
    entryPoints: [path.join(root, "src", "i18n.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
  });
  return `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`;
}