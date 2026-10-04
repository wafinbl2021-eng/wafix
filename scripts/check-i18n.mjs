// Validates the translation table beyond what the compiler can see.
//
// TypeScript already guarantees every locale has every key (they all satisfy
// the `Strings` interface). What it cannot check is the *content*: a string
// that loses its `{count}` placeholder in one language still type-checks, but
// renders a broken sentence — with a literal gap where the number should be —
// to every user of that language. This catches that before it ships.
//
// Run with: npm run check:i18n
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["src/i18n.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
});

const code = Buffer.from(bundled.outputFiles[0].text).toString("base64");
const { STRINGS, LANGUAGES } = await import(`data:text/javascript;base64,${code}`);

/**
 * The languages to check, read from the app's own declaration.
 *
 * This used to be a literal list of six, and adding Arabic to `src/locales/`
 * did not fail it. Every loop below iterates this, so a language missing from
 * the literal was not validated at all: it passed by omission, not by being
 * correct. Nothing about this checker may be able to skip a language that ships,
 * so the list is derived rather than restated — a language declared is a language
 * checked, and the parity assertions below catch a declaration that has no table
 * or a table no declaration claims.
 */
const LANGS = LANGUAGES.map((language) => language.code);

// Italian, because it is the language the copy was written in and the one every
// other table is diffed against for missing and extra keys.
const REFERENCE = "it";

/** The six CLDR plural categories, matching `PluralCategory` in `src/i18n.ts`. */
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

/**
 * True for a plural bundle, and only for one.
 *
 * Mirrors `isPluralForms` in `src/i18n.ts`, which is what the app itself uses to
 * tell a bundle from a nested table at runtime. The two must agree: a marker
 * this checker does not recognise would be flattened as a table here and
 * checked as a bundle there.
 */
const isPluralBundle = (value) =>
  typeof value === "object" && value !== null && typeof value.$plural === "string";

/**
 * Flattens a locale table into dotted path → leaf.
 *
 * A plural bundle is a leaf, not a nested table, and that distinction is the
 * whole reason this function is not a one-liner. Treating a bundle as a table
 * to descend into produced `scan.issuesFound.$plural` plus one sibling per CLDR
 * category and no `scan.issuesFound` at all — so a correctly translated Arabic
 * string was reported as a missing key, and each of its forms as an extra one.
 * Forty-five bundle sites turned into 294 problems, none of them real.
 *
 * A language with no table flattens to nothing rather than throwing. That case
 * is already recorded by the declaration-parity loop below, and it is the one a
 * developer hits the moment they add a language — so it has to arrive as
 * "declared in LANGUAGES but has no table", not as a stack trace from here that
 * buries the one sentence that says what to do about it.
 */
function flatten(value, prefix = "", out = {}) {
  if (!value || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPluralBundle(child)) out[path] = child;
    else if (child && typeof child === "object" && !Array.isArray(child)) flatten(child, path, out);
    else out[path] = child;
  }
  return out;
}

/** Every `{name}` in a sentence, sorted, so two sentences compare by content. */
const placeholdersIn = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const signature = (text) => placeholdersIn(text).join(",");

/**
 * Everything wrong with one value, plus the set of placeholder signatures its
 * sentences declare.
 *
 * `signatures` is `null` for a value that is not text at all — a number, a
 * boolean, an array — because there is nothing to compare. Those still have to
 * *exist* in every language, which the key-parity loops below enforce; they just
 * cannot disagree about placeholders.
 */
function inspect(value, lang, key) {
  const notes = [];

  if (!isPluralBundle(value)) {
    if (typeof value === "string" && value.trim() === "") notes.push(`"${key}" is empty`);
    return { notes, signatures: typeof value === "string" ? new Set([signature(value)]) : null };
  }

  // A bundle names the locale whose grammar chooses between its forms. If that
  // is not a locale this build ships, or not the locale the bundle sits in, the
  // counts it renders are the wrong language's — which is exactly the class of
  // bug that type-checks cleanly and then reads wrong on screen.
  if (!LANGS.includes(value.$plural)) {
    notes.push(`"${key}" is a plural bundle for "${value.$plural}", which is not a shipped language`);
  } else if (value.$plural !== lang) {
    notes.push(`"${key}" is a plural bundle for "${value.$plural}" but sits in the ${lang} table`);
  }

  const signatures = new Set();
  for (const [category, text] of Object.entries(value)) {
    if (category === "$plural") continue;
    if (!PLURAL_CATEGORIES.includes(category)) {
      notes.push(`"${key}" has unknown plural category "${category}"`);
      continue;
    }
    if (typeof text !== "string" || text.trim() === "") {
      notes.push(`"${key}" plural form "${category}" is empty`);
      continue;
    }
    signatures.add(signature(text));
  }

  // `other` is the CLDR fallback: the category every count the bundle does not
  // name explicitly lands on, and the only form the type marks as required. A
  // bundle without one renders `undefined` into the sentence.
  if (typeof value.other !== "string" || value.other.trim() === "") {
    notes.push(`"${key}" has no "other" form, which is the fallback every unnamed count lands on`);
  }

  // All forms of one bundle must bind the same variables. A form that drops
  // `{count}` renders a sentence with a literal gap, and only for the counts
  // that select it — which is precisely why a per-string check misses it.
  if (signatures.size > 1) {
    notes.push(
      `"${key}" plural forms disagree about their placeholders: ${[...signatures]
        .map((s) => `[${s}]`)
        .join(" ")}`,
    );
  }

  return { notes, signatures };
}

const problems = [];

// A declared language with no table renders as raw keys; a table no declaration
// claims is a language this check would silently never look at, which is the
// failure mode that let Arabic go unexamined. Neither may exist.
if (LANGS.length === 0) {
  console.error("i18n check FAILED — LANGUAGES is empty, so this check is pointed at nothing");
  process.exit(1);
}
if (!LANGS.includes(REFERENCE)) {
  console.error(
    `i18n check FAILED — reference language "${REFERENCE}" is not in LANGUAGES (${LANGS.join(", ")})`,
  );
  process.exit(1);
}
for (const lang of new Set([...LANGS, ...Object.keys(STRINGS)])) {
  if (LANGS.includes(lang) && !(lang in STRINGS)) problems.push(`${lang}: declared in LANGUAGES but has no table`);
  if (lang in STRINGS && !LANGS.includes(lang)) problems.push(`${lang}: has a table but is not declared in LANGUAGES`);
}

const flat = Object.fromEntries(LANGS.map((lang) => [lang, flatten(STRINGS[lang])]));

for (const key of Object.keys(flat[REFERENCE])) {
  const referenceValue = inspect(flat[REFERENCE][key], REFERENCE, key);
  for (const note of referenceValue.notes) problems.push(`${REFERENCE}: ${note}`);
  const expected = referenceValue.signatures;

  for (const lang of LANGS) {
    const value = flat[lang][key];

    if (value === undefined) {
      problems.push(`${lang}: missing key "${key}"`);
      continue;
    }

    const found = inspect(value, lang, key);
    for (const note of found.notes) problems.push(`${lang}: ${note}`);
    if (found.signatures === null || expected === null) continue;

    // A plain string in one language and a plural bundle in another is
    // legitimate — Italian needs one form where Arabic needs six — so the
    // comparison is against the set of signatures, not against one shape.
    for (const sig of found.signatures) {
      if (!expected.has(sig)) {
        problems.push(
          `${lang}: "${key}" placeholders [${sig}] don't match ${REFERENCE} [${[...expected].join("] [")}]`,
        );
      }
    }
  }
}

// Keys present in a translation but not in the reference: dead strings, or a
// rename that only landed in some languages.
for (const lang of LANGS) {
  for (const key of Object.keys(flat[lang])) {
    if (!(key in flat[REFERENCE])) problems.push(`${lang}: extra key "${key}" not in ${REFERENCE}`);
  }
}

const keys = Object.keys(flat[REFERENCE]);
const bundleCount = keys.filter((key) => isPluralBundle(flat[REFERENCE][key])).length;
const bundleForms = LANGS.reduce(
  (total, lang) =>
    total + keys.filter((key) => isPluralBundle(flat[lang][key])).length,
  0,
);

if (problems.length > 0) {
  console.error(`i18n check FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

console.log(
  `i18n check passed: ${keys.length} keys x ${LANGS.length} languages (${LANGS.join(", ")}), ` +
    `all placeholders consistent. ${bundleCount} plural key(s), ${bundleForms} bundle(s) checked form by form.`,
);