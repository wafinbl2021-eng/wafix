export type ThemeName =
  | "violet"
  | "teal_depths"
  | "amber_dusk"
  | "crimson_steel"
  | "ocean_blue"
  | "forest_emerald"
  | "royal_gold"
  | "slate_mono"
  | "indigo_night"
  | "coral_sunset"
  | "rose_quartz"
  | "cyber_lime"
  | "copper_forge"
  | "magenta_pulse";

/**
 * `swatch` is the single colour the picker paints for this theme, and it is
 * each theme's own `--app-accent` from App.css — so the dot you click is
 * literally the colour you get.
 *
 * It used to be a *pair* rendered as a hard 50/50 diagonal, which read as a
 * dot someone had sliced in half rather than as a colour choice, and didn't
 * match the solid dots on pctweaker.app.
 *
 * The count is deliberately 14: the picker lays these out 7 per row, so 12
 * left two visibly empty slots dangling under the second row.
 *
 * There is no `label` here. The names are user-visible text — the picker's
 * `title` and `aria-label` — so they live in `STRINGS[lang].themeLabels`, keyed
 * by these codes and typed `Record<ThemeName, string>` so that adding a theme
 * below without naming it in every locale fails the build.
 */
export const THEMES: { code: ThemeName; swatch: string }[] = [
  { code: "violet", swatch: "#ff5c8a" },
  { code: "teal_depths", swatch: "#35e0c0" },
  { code: "amber_dusk", swatch: "#ffb84d" },
  { code: "crimson_steel", swatch: "#ff4d6d" },
  { code: "ocean_blue", swatch: "#3d8bff" },
  { code: "forest_emerald", swatch: "#2ecc71" },
  { code: "royal_gold", swatch: "#e8b923" },
  { code: "slate_mono", swatch: "#9aa5b1" },
  { code: "indigo_night", swatch: "#6c63ff" },
  { code: "coral_sunset", swatch: "#ff7a45" },
  { code: "rose_quartz", swatch: "#ffafcb" },
  { code: "cyber_lime", swatch: "#b6ff3c" },
  { code: "copper_forge", swatch: "#d98b4a" },
  { code: "magenta_pulse", swatch: "#ff2fd0" },
];

/**
 * Where the chosen theme is remembered. Exported for the same reason as
 * `LANG_STORAGE_KEY`: the write lives in `App.tsx` and the read here, and a
 * half-renamed pair would reset the user's theme on every launch without any
 * visible error. No migration — Daltoon X has never shipped.
 */
export const THEME_STORAGE_KEY = "wafix-theme";

export function detectInitialTheme(): ThemeName {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return THEMES.some((t) => t.code === stored) ? (stored as ThemeName) : "violet";
}
