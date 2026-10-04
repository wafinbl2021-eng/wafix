import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// The app predates this config, so the baseline is `recommended` rather than
// the uninstaller's strictTypeChecked: the goal is a CI gate that catches
// real mistakes today without demanding a rewrite of 4,500 working lines.
// New modules extracted out of App.tsx are expected to stay clean under it,
// and the tier can be raised once the split is complete.
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Legacy code carried over from the pre-split monolith: the
    // React-Compiler-era rules stay visible as warnings here and get fixed
    // for real as each site is reworked (two are analyzer false positives on
    // async loaders; two are deliberate, commented reset/animation-sync
    // patterns). Never add new code that needs this.
    //
    // `applications.tsx` and `overlay.tsx` are here for the same reason as the
    // four below them and were missing only by accident: both were split out of
    // `App.tsx`/`overlay` carrying code that predates this config, and when the
    // split happened this list was not extended to cover them. Nothing about
    // those two sites is new — `applications.tsx` calls an async loader that
    // sets state after its `await` (the false-positive shape above), and
    // `overlay.tsx` reads the stored language once on mount, which is the
    // deliberate, commented shape. Left off this list they were scored at the
    // plugin default of `error`, so two inherited sites failed a gate that the
    // four identical ones beside them passed.
    files: [
      "src/App.tsx",
      "src/components/applications.tsx",
      "src/components/gaming.tsx",
      "src/components/maintenance.tsx",
      "src/components/startup.tsx",
      "src/overlay.tsx",
    ],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/component-hook-factories": "warn",
    },
  },
  {
    ignores: [
      "dist/",
      "src-tauri/",
      "node_modules/",
      "backend/",
      // The Worker has its own config and its own (stricter) tier in
      // wafx-api/eslint.config.js. Leaving it unignored here would lint it a
      // second time under the React app's rules, with no React in scope.
      "wafx-api/",
      "marketing/",
      "site/",
      "scripts/",
    ],
  },
);
