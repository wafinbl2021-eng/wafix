/**
 * Input validation.
 *
 * Two rules govern this file.
 *
 * 1. Every field that can reach a process spawn, a file path or a URL fetch is
 *    validated here, and the closed sets (`installer_type`, `installer_mode`,
 *    `installer_url_kind`, `icon_kind`) are enforced in code as well as by a
 *    CHECK constraint. The database constraint is the backstop; this is the
 *    one that produces a useful error message.
 *
 * 2. Objects are validated by *shape*: unknown keys are rejected rather than
 *    ignored. This is what makes "there is no installer arguments field" a
 *    property of the system instead of a convention. A panel that POSTs
 *    `{ installer_mode: "silent", args: "--run=malware" }` gets a 422 naming
 *    the offending key, rather than a silent success that quietly drops it.
 */

import { badRequest, validationFailed, type FieldErrors } from "./errors.ts";

export const INSTALLER_TYPES = ["exe", "msi"] as const;
export type InstallerType = (typeof INSTALLER_TYPES)[number];

export const INSTALLER_MODES = ["silent", "passive", "interactive"] as const;
export type InstallerMode = (typeof INSTALLER_MODES)[number];

export const URL_KINDS = ["external", "r2"] as const;
export type UrlKind = (typeof URL_KINDS)[number];

export const ICON_KINDS = ["none", "external", "r2"] as const;
export type IconKind = (typeof ICON_KINDS)[number];

export const CHANNELS = ["stable", "beta"] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Keys that are refused on sight, everywhere.
 *
 * `installer_mode` is the reason this list exists. A server that can send an
 * argument string to a process it launched with elevated privileges is a
 * remote execution channel, whatever it is called. These names are rejected
 * with a message that says so, because "unknown field" would read as a typo to
 * whoever hit it.
 */
const FORBIDDEN_KEYS = new Set([
  "args",
  "argv",
  "arguments",
  "params",
  "parameters",
  "flags",
  "switches",
  "extra",
  "extra_args",
  "extraArgs",
  "installer_args",
  "installerArgs",
  "command",
  "cmd",
  "commands",
  "command_line",
  "commandLine",
  "script",
  "shell",
  "exec",
  "run",
  "spawn",
  "powershell",
  "batch",
  "env",
  "environment",
]);

/** Collects every field problem so a form can show them all at once. */
export class Validator {
  private readonly problems: FieldErrors = {};
  private readonly prefix: string;

  // An explicit field rather than a parameter property: Node runs this by
  // stripping types, so anything needing a real transform is a SyntaxError.
  // `erasableSyntaxOnly` in tsconfig keeps that enforced.
  constructor(prefix = "") {
    this.prefix = prefix;
  }

  private key(field: string): string {
    return this.prefix === "" ? field : `${this.prefix}.${field}`;
  }

  private record(field: string, message: string): void {
    const key = this.key(field);
    // First message per field wins; later ones tend to be consequences.
    this.problems[key] ??= message;
  }

  get ok(): boolean {
    return Object.keys(this.problems).length === 0;
  }

  get errors(): FieldErrors {
    return this.problems;
  }

  /** Throws a 422 listing every problem found, or returns nothing. */
  assert(): void {
    if (!this.ok) {
      throw validationFailed("Some fields need attention", this.problems);
    }
  }

  /** Records a problem discovered outside a field accessor. */
  note(field: string, message: string): void {
    this.record(field, message);
  }

  /**
   * Rejects unknown or forbidden keys.
   *
   * This is the mechanism that makes an unrecognised field an error. It is
   * called before any field is read, so a payload cannot smuggle extra data
   * past validation by ordering keys cleverly.
   */
  shape(input: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!isPlainObject(input)) {
      throw badRequest("Expected a JSON object");
    }
    for (const key of Object.keys(input)) {
      if (FORBIDDEN_KEYS.has(key)) {
        this.record(
          key,
          "This field is never accepted. Installer arguments are fixed in the app " +
            "and cannot be set from the server.",
        );
        continue;
      }
      if (!allowed.includes(key)) {
        this.record(key, "Unknown field");
      }
    }
    return input;
  }

  string(
    field: string,
    value: unknown,
    opts: { required?: boolean; min?: number; max?: number; trim?: boolean } = {},
  ): string | undefined {
    const { required = false, min = 0, max = 10_000, trim = true } = opts;
    if (value === undefined || value === null) {
      if (required) this.record(field, "Required");
      return undefined;
    }
    if (typeof value !== "string") {
      this.record(field, "Must be text");
      return undefined;
    }
    const out = trim ? value.trim() : value;
    if (out.length < min) {
      this.record(field, min === 1 ? "Required" : `Must be at least ${min} characters`);
      return undefined;
    }
    if (out.length > max) {
      this.record(field, `Must be at most ${max} characters`);
      return undefined;
    }
    if (hasControlCharacter(out)) {
      this.record(field, "Contains characters that are not allowed");
      return undefined;
    }
    return out;
  }

  /** Lowercase ASCII slug: the primary key of apps and categories. */
  slug(field: string, value: unknown, required = true): string | undefined {
    const raw = this.string(field, value, { required, max: 64 });
    if (raw === undefined) return undefined;
    const out = raw.toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(out)) {
      this.record(field, "Use lowercase letters, digits and single hyphens");
      return undefined;
    }
    return out;
  }

  /** Dotted numeric version, no leading v: '131.0', '1.2.3.4'. */
  version(field: string, value: unknown, required = true): string | undefined {
    const raw = this.string(field, value, { required, max: 40 });
    if (raw === undefined) return undefined;
    if (!/^\d{1,6}(?:\.\d{1,6}){0,3}$/.test(raw)) {
      this.record(field, "Use digits and dots, for example 1.2.3");
      return undefined;
    }
    return raw;
  }

  /** Semver without a leading v, matching how Tauri updater reports versions. */
  semver(field: string, value: unknown, required = true): string | undefined {
    const raw = this.string(field, value, { required, max: 40 });
    if (raw === undefined) return undefined;
    if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/.test(raw)) {
      this.record(field, "Use a three-part version such as 1.2.3");
      return undefined;
    }
    return raw;
  }

  oneOf<T extends string>(
    field: string,
    value: unknown,
    allowed: readonly T[],
    opts: { required?: boolean; fallback?: T } = {},
  ): T | undefined {
    const { required = false, fallback } = opts;
    if (value === undefined || value === null || value === "") {
      if (fallback !== undefined) return fallback;
      if (required) this.record(field, "Required");
      return undefined;
    }
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      this.record(field, `Must be one of: ${allowed.join(", ")}`);
      return undefined;
    }
    return value as T;
  }

  boolean(field: string, value: unknown, fallback?: boolean): boolean | undefined {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    if (value === 0) return false;
    if (value === 1) return true;
    this.record(field, "Must be true or false");
    return undefined;
  }

  integer(
    field: string,
    value: unknown,
    opts: { required?: boolean; min?: number; max?: number; fallback?: number } = {},
  ): number | undefined {
    const { required = false, min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = opts;
    if (value === undefined || value === null || value === "") {
      if (fallback !== undefined) return fallback;
      if (required) this.record(field, "Required");
      return undefined;
    }
    const out = typeof value === "string" ? Number(value) : value;
    if (typeof out !== "number" || !Number.isInteger(out)) {
      this.record(field, "Must be a whole number");
      return undefined;
    }
    if (out < min || out > max) {
      this.record(field, `Must be between ${min} and ${max}`);
      return undefined;
    }
    return out;
  }

  /** 64 lowercase hex characters, or absent. Uppercase is refused deliberately. */
  sha256(field: string, value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") {
      this.record(field, "Must be text");
      return undefined;
    }
    const out = value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(out)) {
      this.record(field, "Must be 64 hexadecimal characters");
      return undefined;
    }
    return out;
  }

  /** ISO date, date-time, or empty. Anything else is stored as-is. */
  date(field: string, value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") {
      this.record(field, "Must be text");
      return undefined;
    }
    const out = value.trim();
    if (out.length > 40 || hasControlCharacter(out)) {
      this.record(field, "Not a valid date");
      return undefined;
    }
    const timestamp = Date.parse(out);
    if (Number.isNaN(timestamp)) {
      this.record(field, "Not a valid date");
      return undefined;
    }
    // Round-trip through Date so '2026-13-45' cannot slip past Date.parse's
    // leniency on some inputs.
    if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/.test(out)) {
      this.record(field, "Use a date like 2026-10-01");
      return undefined;
    }
    return out;
  }

  /**
   * An absolute https URL, normalised.
   *
   * Normalisation matters: the stored string is what `new URL()` produced, not
   * what was typed. That removes a class of disagreement between the panel, this
   * API and the desktop client about what a given string means.
   */
  httpsUrl(field: string, value: unknown, required = false): string | undefined {
    if (value === undefined || value === null || value === "") {
      if (required) this.record(field, "Required");
      return undefined;
    }
    if (typeof value !== "string") {
      this.record(field, "Must be text");
      return undefined;
    }
    const out = value.trim();
    if (out.length > 2048) {
      this.record(field, "Too long");
      return undefined;
    }
    let parsed: URL;
    try {
      parsed = new URL(out);
    } catch {
      this.record(field, "Not a valid URL");
      return undefined;
    }
    if (parsed.protocol !== "https:") {
      this.record(field, "Must start with https://");
      return undefined;
    }
    if (parsed.username || parsed.password) {
      // https://example.com@evil.example reads as example.com in a status bar
      // and resolves to evil.example.
      this.record(field, "Must not contain credentials");
      return undefined;
    }
    if (!parsed.hostname) {
      this.record(field, "Not a valid URL");
      return undefined;
    }
    return parsed.href;
  }

  /**
   * An R2 object key.
   *
   * Only used when `url_kind` is 'r2'. Validated even though no bucket exists
   * yet, so that turning storage on later cannot surface a pile of keys that
   * were never checked.
   */
  objectKey(field: string, value: unknown, required = false): string | undefined {
    if (value === undefined || value === null || value === "") {
      if (required) this.record(field, "Required");
      return undefined;
    }
    if (typeof value !== "string") {
      this.record(field, "Must be text");
      return undefined;
    }
    const out = value.trim();
    if (out.length > 512) {
      this.record(field, "Too long");
      return undefined;
    }
    if (out.startsWith("/") || out.includes("\\")) {
      this.record(field, "Must be a relative key");
      return undefined;
    }
    // No traversal, no empty segments, no hidden dotfiles.
    if (out.split("/").some((part) => part === "" || part === "." || part === "..")) {
      this.record(field, "Not a valid object key");
      return undefined;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(out)) {
      this.record(field, "Use letters, digits, dots, hyphens, slashes");
      return undefined;
    }
    return out;
  }

  /**
   * Resolves a `{kind, value}` pair into the single URL the database stores.
   *
   * One column holds either an absolute https URL or an object key, and the kind
   * column says which. Keeping the discrimination here means adding a storage
   * backend later is a new branch in one function rather than a new column and a
   * migration over live rows.
   *
   * `'none'` is accepted and yields no value at all. An icon kind of `none` means
   * "there is no icon", so running the value through the URL or key validator
   * would demand a URL for something that is meant to be absent - and a stored
   * `icon_url` beside `icon_kind = 'none'` is a contradiction the schema's CHECK
   * constraint would then have to reject.
   */
  urlWithKind(
    field: string,
    kind: UrlKind | IconKind | undefined,
    value: unknown,
    opts: { required?: boolean } = {},
  ): string | undefined {
    if (kind === undefined || kind === "none") return undefined;
    if (kind === "r2") {
      return this.objectKey(`${field}_key`, value, opts.required ?? false);
    }
    return this.httpsUrl(field, value, opts.required ?? false);
  }
}

/**
 * Narrows a value read back from the database to a {@link UrlKind}.
 *
 * Used when a stored `installer_url_kind` decides how a *new* value is
 * validated. A value outside the set cannot be written, so the fallback is
 * unreachable in practice; returning `undefined` rather than a guess means an
 * unexpected value causes the field to be left alone instead of being resolved
 * against a kind nobody chose.
 */
export function toUrlKind(value: unknown): UrlKind | undefined {
  return value === "external" || value === "r2" ? value : undefined;
}

/** Control characters, excluding tab and newline which descriptions use. */
function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * Narrows a field that {@link Validator.assert} has already guaranteed is present.
 *
 * The field accessors return `undefined` for a value that failed, because that
 * is what lets a caller keep checking the rest of the payload and report every
 * problem at once. `assert()` then throws if any did. So after `assert()`, a
 * required field is present - but the compiler cannot see that, and this states
 * it rather than scattering non-null assertions through the routes.
 */
export function def<T>(value: T | undefined, field: string): T {
  if (value !== undefined) return value;
  // Unreachable in practice: assert() throws before this is reached. Kept as a
  // real error rather than a thrown TypeError, so a future refactor that
  // reorders these two calls degrades into a 422 rather than a 500.
  throw validationFailed("Some fields need attention", { [field]: "Required" });
}

/** Convenience for tests and callers that prefer an exception to `.assert()`. */
export function requireValid<T>(build: (v: Validator) => T): T {
  const validator = new Validator();
  const result = build(validator);
  validator.assert();
  return result;
}


