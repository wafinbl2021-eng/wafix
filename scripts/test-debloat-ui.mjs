import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Bundles a module and imports it, so the checks below read the real thing. */
async function loadModule(relative, platform = "node") {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(relative, import.meta.url))],
    bundle: true,
    format: "esm",
    platform,
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
}

const { DEBLOAT_COPY, DEBLOAT_IMPACT } = await loadModule("../src/components/debloat-copy.ts");
const { ADVANCED_COPY } = await loadModule("../src/components/advanced-copy.ts");
const { CONFIGURABLE_TWEAK_IDS, isCurrentCatalogTweak } = await loadModule("../src/catalog.ts");
const { LANGUAGES } = await loadModule("../src/i18n.ts", "neutral");

/**
 * The languages this copy has to cover, taken from the app's own declaration
 * rather than written out in this file.
 *
 * It used to be a hard-coded six, left over from before Arabic shipped, and it
 * failed loudly the moment a seventh language arrived — which was the right
 * outcome for the wrong reason. The list has to be remembered, so the same edit
 * would have been needed for the eighth language, and it fails as a bare key
 * mismatch rather than as the thing that is actually wrong.
 *
 * Reading `LANGUAGES` states the invariant that matters: every declared language
 * has copy, and no copy survives for a language that is no longer declared.
 * `test:brand` pins `LANGUAGES` against the shipped `STRINGS` table
 * independently, so deriving the list here cannot mask a language being dropped
 * — it would fail there instead, with a message that names the cause.
 */
const declaredLanguages = LANGUAGES.map((language) => language.code).sort();
assert.ok(declaredLanguages.length > 0, "no languages declared - this check is pointed at nothing");
assert.deepEqual(
  Object.keys(DEBLOAT_COPY).sort(),
  declaredLanguages,
  `debloat copy covers ${JSON.stringify(Object.keys(DEBLOAT_COPY).sort())} but the app declares ${JSON.stringify(declaredLanguages)}`,
);
assert.deepEqual(Object.keys(DEBLOAT_IMPACT).sort(), [
  "clipchamp",
  "copilot",
  "news",
  "outlook",
  "solitaire",
  "weather",
]);

for (const [lang, copy] of Object.entries(DEBLOAT_COPY)) {
  for (const key of [
    ...Object.values(DEBLOAT_IMPACT),
    "publisherMismatch",
    "protectedPackage",
    "dependency",
    "nonRemovable",
    "unverifiedRemovability",
    "requiresStandardUser",
    "previewIntro",
    "recoveryNote",
    "removable",
    "all",
    "filterLabel",
    "details",
    "elevatedTitle",
  ]) {
    assert.ok(copy[key]?.trim(), `${lang}: missing ${key}`);
    if (lang !== "en")
      assert.notEqual(copy[key], DEBLOAT_COPY.en[key], `${lang}: untranslated ${key}`);
  }
}

assert.deepEqual([...CONFIGURABLE_TWEAK_IDS].sort(), [
  "ecoqos_rules",
  "limit_do_background_download",
  "monitor_refresh_profile",
]);
assert.equal(isCurrentCatalogTweak("disable_copilot"), false);
assert.equal(isCurrentCatalogTweak("turbo_boost"), true);
assert.deepEqual(Object.keys(ADVANCED_COPY).sort(), declaredLanguages);
for (const [lang, copy] of Object.entries(ADVANCED_COPY)) {
  for (const key of [
    "ecoConflict",
    "doReadback",
    "doRestore",
    "monitorPreview",
    "monitorConfirm",
    "monitorRestore",
  ]) {
    assert.ok(copy[key]?.trim(), `${lang}: missing ${key}`);
    if (lang !== "en")
      assert.notEqual(copy[key], ADVANCED_COPY.en[key], `${lang}: untranslated ${key}`);
  }
}
console.log(
  `Debloat and advanced UI copy: ${declaredLanguages.length} locales (${declaredLanguages.join(", ")}), recovery and safety text checked.`,
);