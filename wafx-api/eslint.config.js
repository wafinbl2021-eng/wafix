import js from "@eslint/js";
import tseslint from "typescript-eslint";

// The Worker, its tests and the admin panel. Separate from the root config on
// purpose: this is a Cloudflare runtime with its own globals (`caches`,
// `D1Database`, `ExecutionContext`), and the root config is scoped to the React app
// in src/.
//
// Two tiers, because the code is two kinds of thing:
//
//   - `src/` and `scripts/` ship, so they get `strictTypeChecked`. Those rules
//     catch real defects rather than style: a promise nobody awaited, a value that
//     might be null, a comparison between incompatible types.
//   - `test/` is thrown away after it runs, and it is full of deliberate casts
//     against the harness's row types and non-null assertions after an index the
//     assertion above already checked. The strict tier calls all of that noise, so
//     tests get `recommendedTypeChecked`, which still carries the rules that
//     matter (floating promises, misused promises, unsafe arguments).
const SHIPPING = ["src/**/*.ts", "scripts/**/*.ts"];
const TESTS = ["test/**/*.ts"];

const scopedTo = (files, configs) => configs.map((config) => ({ ...config, files }));

export default tseslint.config(
  {
    ignores: ["node_modules/", "migrations/", ".wrangler/"],
  },
  js.configs.recommended,
  ...scopedTo(SHIPPING, tseslint.configs.strictTypeChecked),
  ...scopedTo(SHIPPING, tseslint.configs.stylisticTypeChecked),
  ...scopedTo(TESTS, tseslint.configs.recommendedTypeChecked),
  ...scopedTo(TESTS, tseslint.configs.stylisticTypeChecked),
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parserOptions: {
        // Hono, the tests and the seed script are one program with Node's types
        // layered over the Workers types, so both sets of globals are in scope.
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The Worker logs on purpose - it is the only place a stack trace or a SQL
      // message can go. Where it logs matters more than how often.
      "no-console": "off",

      // Numbers are the most common thing in a message ("too long: got 70000,
      // limit 65536"), and `restrict-template-expressions` flags every one of
      // them unless asked not to. The types that matter - `never`, functions,
      // symbols, plain objects - stay forbidden.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],

      // Every value read out of D1 goes through `String()` / `Number()` on the way
      // in, because the driver types say `string` and `number` while the runtime
      // has been known to hand back a bigint or a numeric string depending on
      // version. The rule's premise - that the value is already the right type -
      // is only true because the call site declared the generic that said so.
      "@typescript-eslint/no-unnecessary-type-conversion": "off",
    },
  },
  {
    files: ["src/db.ts"],
    rules: {
      // `first<T>()` and `all<T>()` exist to let each call site name the row shape
      // it is about. T appears once by construction; there is no signature where
      // it could appear twice and still be the point.
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
    },
  },
  {
    files: TESTS,
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `test()` and `describe()` return promises that are meant to be left
      // alone: the runner awaits them itself. This is the documented way to say
      // so, and it keeps the rule live for every other promise in a test.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["test", "describe", "it", "before", "after", "beforeEach", "afterEach"],
            },
          ],
        },
      ],
    },
  },
  {
    files: ["test/harness.ts"],
    rules: {
      // The harness's D1 shim implements an async interface with `node:sqlite`,
      // which is synchronous. The methods have to be `async` to satisfy the
      // interface, and there is nothing to await inside them.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: TESTS,
    rules: {
      // Numbers in messages again, and the same reason as in `src`: a test that
      // says "expected 422, got 400" is more useful than one that says nothing.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },

  // ---------------------------------------------------------------------------
  // Plain JavaScript: the panel and the schema verifier. No build step, so there
  // are no types to check against and the type-aware rules have to come back off.
  // ---------------------------------------------------------------------------
  {
    files: ["admin/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: {
        document: "readonly",
        window: "readonly",
        fetch: "readonly",
        crypto: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        localStorage: "readonly",
        console: "readonly",
        confirm: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["admin/**/*.js", "scripts/**/*.mjs"],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
);
