import { useEffect, useRef, useState } from "react";
import { LANGUAGES, Lang, Strings } from "../i18n";
import { THEMES, ThemeName } from "../theme";
import {
  ERROR_REPORTS_KEY,
  errorReportsEnabled,
  fileToAvatarDataUrl,
  readAvatar,
  removeAvatar,
  writeAvatar,
} from "../lib";
import { validateCredentials, validateRegistration } from "../account-client";
import { AuthState } from "../types";
import { CheckIcon, CrownIcon } from "./icons";
import { Avatar } from "./ui";
import "./account-menu.css";

/**
 * Validation codes from `validateCredentials` / `validateRegistration`, in the
 * user's language.
 *
 * A map rather than returning a finished string so the checks can be unit-tested
 * without an i18n bundle, and so `account-client.ts` stays free of presentation.
 * A code with no entry falls through to being shown verbatim, which cannot
 * happen today — the tests below pin that.
 */
const problems: Record<string, (s: Strings) => string> = {
  emailRequired: (s) => s.auth.emailRequired,
  emailInvalid: (s) => s.auth.emailInvalid,
  passwordRequired: (s) => s.auth.passwordRequired,
  passwordTooShort: (s) => s.auth.passwordTooShort,
  passwordMismatch: (s) => s.auth.passwordMismatch,
};

/**
 * The signed-out sign-in / registration form, and the signed-in summary.
 *
 * Three fields when registering (email, password, confirm) and two when signing
 * in. Deliberately absent, and why:
 *
 *   - **Name and date of birth.** The API takes an address and a verifier and
 *     nothing else. `accounts` in `migrations/0003_accounts.sql` has no column
 *     for a name, so asking for one would be collecting data nothing stores.
 *   - **Forgot password and resend verification.** Both need an email sender,
 *     and Daltoon X 1.0.0 has none: no verification step exists, so there is nothing
 *     to resend, and password recovery is deferred to 1.1. Showing a link that
 *     cannot work would be worse than not showing it.
 *   - **"Remember me".** It used to choose between `localStorage` and
 *     `sessionStorage`. The session now lives in a DPAPI-encrypted file owned by
 *     Rust, so there is nothing for the frontend to remember or forget.
 *
 * The API answers a bad sign-in, an unknown address and a disabled account
 * identically, and this form shows that answer verbatim. Anything else here would
 * rebuild the enumeration channel the API exists to remove.
 */
export function AuthSection({
  s,
  auth,
  avatar = null,
  onChangePhoto,
  onRemovePhoto,
  onAuthenticate,
  onLogout,
}: {
  s: Strings;
  auth: AuthState;
  /** Device-local profile photo and its controls, owned by AccountMenu. */
  avatar?: string | null;
  onChangePhoto?: () => void;
  onRemovePhoto?: () => void | Promise<void>;
  onAuthenticate: (mode: "login" | "register", email: string, password: string) => Promise<void>;
  onLogout: () => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  // The session is still being restored. Rendering the form now would show a
  // signed-out state that is about to become a signed-in one, which is a flash
  // of the wrong screen on every launch.
  if (auth.status === "loading") {
    return (
      <div className="flex items-center gap-2 border-b border-line p-4 text-xs text-ink-3">
        <span
          aria-hidden
          className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-[var(--app-accent)]"
        />
        {s.auth.checkingSession}
      </div>
    );
  }

  if (auth.status === "authenticated") {
    // "Logged in as name@example.com" as a bare line of text reads like a
    // status message. An avatar + the address + a verification badge reads
    // like an account — same information, and it's the first thing anyone
    // sees when they open this menu.
    return (
      <div className="relative overflow-hidden border-b border-line p-3.5">
        {/* A wash of the active theme behind the account block, so the top of
            the menu reads as a header rather than as the first grey row of a
            list. */}
        <span
          aria-hidden
          className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full opacity-20 blur-2xl"
          style={{ background: auth.isPro ? "#fbbf24" : "var(--app-accent)" }}
        />
        <div className="relative flex items-center gap-3">
          {/* Clicking the avatar itself opens the photo picker — the picture
              is the control, no extra row of buttons needed for the happy
              path. The photo stays on this device only. */}
          <button
            type="button"
            onClick={onChangePhoto}
            title={s.menu.changePhoto}
            aria-label={s.menu.changePhoto}
            className="group relative shrink-0 rounded-full transition-transform hover:scale-105"
          >
            <Avatar email={auth.email} isPro={auth.isPro} photo={avatar} />
            <span className="pointer-events-none absolute inset-[2px] grid place-items-center rounded-full bg-black/55 opacity-0 transition-opacity group-hover:opacity-100">
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-white">
                <path
                  d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6L16.5 7h2A1.5 1.5 0 0 1 20 8.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5v-8Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="12.5" r="3" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </span>
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-ink" title={auth.email}>
              {auth.email}
            </p>
            {auth.emailVerified ? (
              <p className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-emerald-400">
                <CheckIcon className="h-3 w-3" />
                {s.auth.emailVerified}
              </p>
            ) : (
              <p className="mt-0.5 text-[11px] font-medium text-amber-400">
                {s.auth.emailNotVerified}
              </p>
            )}
          </div>
        </div>

        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        {avatar && (
          <button
            onClick={onRemovePhoto}
            className="mt-2 w-full text-left text-[11px] font-medium text-ink-3 transition-colors hover:text-ink-2"
          >
            {s.menu.removePhoto}
          </button>
        )}
        <button
          onClick={onLogout}
          className="mt-2 w-full rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-3 transition-colors hover:bg-surface-hover hover:text-ink-2"
        >
          {s.auth.logout}
        </button>
      </div>
    );
  }

  /**
   * Client-side checks, then hand off.
   *
   * These are conveniences, not security. The API never sees a password — only a
   * stretched verifier — so it cannot judge one, and neither can this. The point
   * is to catch an empty field or two mistyped passwords without a round trip.
   */
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const problem =
      mode === "register"
        ? validateRegistration(email, password, confirm)
        : validateCredentials(email, password);
    if (problem) {
      const translate = problems[problem];
      // An unmapped code would be a new validator code with no string. Showing
      // the raw code is ugly but honest; a test below asserts every code is
      // mapped, so this branch exists only as a guard.
      setError(translate ? translate(s) : problem);
      return;
    }

    setWorking(true);
    try {
      // No `remember`, and no name: the session is Rust's to keep and the API
      // stores no name.
      await onAuthenticate(mode, email.trim(), password);
    } catch (err) {
      // Whatever the API said, shown as-is. For a bad sign-in that is the
      // deliberately vague "Invalid email or password", and paraphrasing it here
      // would risk saying something more specific than the server was willing to.
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="border-b border-line p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
        {s.menu.account}
      </p>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={s.auth.email}
          className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-[var(--app-accent)]"
        />
        <input
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={s.auth.password}
          className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-[var(--app-accent)]"
        />
        {mode === "register" && (
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={s.auth.confirmPassword}
            className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-[var(--app-accent)]"
          />
        )}
        {mode === "register" && <p className="text-[11px] text-ink-3">{s.auth.passwordHint}</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={working}
          className="rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          {working ? s.auth.working : mode === "login" ? s.auth.loginButton : s.auth.registerButton}
        </button>
        <button
          type="button"
          onClick={() => {
            // The password fields are cleared on the way across. Switching
            // between sign-in and registration reuses this component, and leaving
            // a typed password sitting in state after a mode change is the kind
            // of thing that ends up in a screenshot.
            setMode((m) => (m === "login" ? "register" : "login"));
            setPassword("");
            setConfirm("");
            setError(null);
          }}
          className="text-xs text-ink-3 hover:text-ink-2"
        >
          {mode === "login" ? s.auth.switchToRegister : s.auth.switchToLogin}
        </button>
      </form>
    </div>
  );
}

export function AccountMenu({
  s,
  lang,
  setLang,
  theme,
  setTheme,
  auth,
  open: openProp,
  onOpenChange,
  onAuthenticate,
  onLogout,
  onUpgrade,
  onViewPlan,
  pushToast,
}: {
  s: Strings;
  lang: Lang;
  setLang: (l: Lang) => void;
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
  auth: AuthState;
  /** Lets a caller elsewhere in the tree (e.g. "sign in to save this")
   *  force the menu open. Falls back to purely internal state when omitted,
   *  so every other existing call site keeps working unchanged. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onAuthenticate: (mode: "login" | "register", email: string, password: string) => Promise<void>;
  onLogout: () => void;
  onUpgrade: () => void;
  /** Opens the plans screen. Same destination for both tiers: a Free
   *  account is comparing, a Pro account is checking what it pays for. */
  onViewPlan: () => void;
  pushToast: (kind: "success" | "error", message: string) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === "function" ? v(open) : v;
    onOpenChange?.(next);
    setInternalOpen(next);
  };
  const [errReports, setErrReports] = useState(() => errorReportsEnabled());
  const isPro = auth.status === "authenticated" && auth.isPro;

  // Device-local profile photo, kept as a file by the Rust side; there is no
  // upload — see fileToAvatarDataUrl in lib.ts and src-tauri/src/avatar.rs.
  // Loaded in an effect rather than a useState initializer because reading it
  // is async, and reloaded whenever the signed-in account changes.
  // Stored together with the address it was loaded for, and only rendered
  // when the two still agree. Holding the photo alone was half of the bug
  // where a new account wore the previous one's face: even once the files
  // were separated, the picture already in memory stayed on screen across a
  // sign-out and the next sign-in.
  const [loadedAvatar, setLoadedAvatar] = useState<{
    email: string;
    photo: string | null;
  } | null>(null);
  const signedInAs = auth.status === "authenticated" ? auth.email : null;
  const avatar = loadedAvatar && loadedAvatar.email === signedInAs ? loadedAvatar.photo : null;
  const photoInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!signedInAs) return;
    let alive = true;
    void readAvatar(signedInAs).then((photo) => {
      if (alive) setLoadedAvatar({ email: signedInAs, photo });
    });
    return () => {
      alive = false;
    };
  }, [signedInAs]);

  async function onPhotoPicked(file: File | undefined) {
    if (!file) return;
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      // Persist before showing it. The old order set state first and swallowed
      // a failed write, so a photo that never made it to disk still appeared
      // to have been saved until the next launch proved otherwise.
      if (!signedInAs) return;
      await writeAvatar(signedInAs, dataUrl);
      setLoadedAvatar({ email: signedInAs, photo: dataUrl });
    } catch {
      // Not an image, or the browser refused to decode it: keep whatever was
      // there before, but say so - a picker that silently does nothing on
      // failure is indistinguishable from a picker that is simply broken.
      // The thrown error's own message is internal/English and not meant for
      // display, so the toast always uses the translated string instead.
      pushToast("error", s.menu.photoFailed);
    }
  }

  async function removePhoto() {
    try {
      if (!signedInAs) return;
      await removeAvatar(signedInAs);
      setLoadedAvatar({ email: signedInAs, photo: null });
    } catch {
      pushToast("error", s.menu.photoFailed);
    }
  }

  function toggleErrorReports() {
    const next = !errReports;
    setErrReports(next);
    localStorage.setItem(ERROR_REPORTS_KEY, next ? "on" : "off");
  }

  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}
    >
      {/* Signed in, the trigger *is* the avatar — the same face shown inside
          the menu, so the button says whose account this is before it's
          opened. Signed out there is no account to represent, so it stays a
          plain glyph. */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`grid h-9 w-9 place-items-center rounded-full transition-transform hover:scale-105 ${
          auth.status === "authenticated"
            ? // The avatar draws its own rim; a second ring here just stacked
              // another circle on a slightly different radius.
              ""
            : `bg-surface-2 text-ink-2 ring-1 ring-line-2 hover:bg-surface-hover ${
                open ? "ring-2 ring-white/40" : ""
              }`
        }`}
        aria-label={s.menu.account}
        aria-expanded={open}
      >
        {auth.status === "authenticated" ? (
          <Avatar email={auth.email} isPro={isPro} photo={avatar} size="sm" />
        ) : (
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
            <circle cx="12" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="M4.5 20c1.4-3.6 4.4-5.5 7.5-5.5s6.1 1.9 7.5 5.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* A compact panel with scrolling for shorter windows. */}
          <div className="account-panel animate-card absolute right-0 z-50 mt-2 max-h-[calc(100vh-9rem)] overflow-y-auto overflow-x-hidden">
            <AuthSection
              s={s}
              auth={auth}
              avatar={avatar}
              onChangePhoto={() => photoInput.current?.click()}
              onRemovePhoto={removePhoto}
              onAuthenticate={onAuthenticate}
              onLogout={onLogout}
            />
            {/* The webview's own file input: no plugin, no permissions — the
                browser dialog hands us the bytes and they stay local. */}
            <input
              ref={photoInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                void onPhotoPicked(e.target.files?.[0]);
                e.target.value = "";
              }}
            />

            <div className="border-b border-line p-3">
              {isPro ? (
                /* Same reasoning as the sidebar card: a Pro subscriber should
                   see that they bought something, not the same grey line a
                   Free account gets. */
                <>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                    {s.menu.plan}
                  </p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5">
                      <CrownIcon className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                      <span className="text-sm font-bold uppercase tracking-wide text-amber-300">
                        {s.menu.planPro}
                      </span>
                    </span>
                    <button
                      onClick={() => {
                        setOpen(false);
                        onViewPlan();
                      }}
                      className="rounded-lg border border-line-2 px-2.5 py-1 text-xs font-semibold text-ink-2 transition-colors hover:border-amber-400/50 hover:text-ink"
                    >
                      {s.menu.viewPlan}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                    {s.menu.plan}
                  </p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-ink">{s.menu.planFree}</span>
                    <span className="flex items-center gap-1.5">
                      <button
                        onClick={() => {
                          setOpen(false);
                          onViewPlan();
                        }}
                        className="rounded-lg border border-line-2 px-2.5 py-1 text-xs font-semibold text-ink-2 transition-colors hover:border-amber-400/50 hover:text-ink"
                      >
                        {s.menu.viewPlan}
                      </button>
                      <button
                        onClick={() => {
                          setOpen(false);
                          onUpgrade();
                        }}
                        className="rounded-lg bg-gradient-to-r from-amber-300 to-yellow-500 px-3 py-1 text-xs font-bold text-amber-950 transition hover:-translate-y-px hover:brightness-110"
                      >
                        {s.menu.upgradeButton}
                      </button>
                    </span>
                  </div>
                </>
              )}
            </div>

            <div className="border-b border-line p-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                {s.menu.language}
              </p>
              <div className="account-languages">
                {LANGUAGES.map((l) => (
                  <button
                    key={l.code}
                    onClick={() => setLang(l.code)}
                    aria-pressed={lang === l.code}
                    className="account-language"
                  >
                    {l.native}
                    {lang === l.code && <CheckIcon className="h-3.5 w-3.5" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-b border-line p-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                {s.menu.theme}
              </p>
              {/* Swatches only: with a dozen themes the labels forced a
                  two-column grid that dominated the panel. The color is the choice.

                  A fixed 7-column grid rather than flex-wrap, so the dots line
                  up in even columns instead of drifting with the panel width —
                  and 14 themes fill it exactly, leaving no orphan gaps. */}
              {/* 24px dots on a 7-column grid left only ~3px of clearance
                  either side inside this panel, so the selected dot's 2px ring
                  and the hover scale both spilled onto their neighbours. 20px
                  dots with a wider gap leave room for both. `ring-offset` keeps
                  the ring off the swatch itself rather than growing outwards. */}
              <div className="account-themes">
                {THEMES.map((t) => (
                  <button
                    key={t.code}
                    onClick={() => setTheme(t.code)}
                    title={s.themeLabels[t.code]}
                    aria-label={s.themeLabels[t.code]}
                    aria-pressed={theme === t.code}
                    className="account-theme"
                    style={{ "--swatch": t.swatch } as React.CSSProperties}
                  >
                    <span className="account-theme-color" />
                    {theme === t.code && <CheckIcon className="h-3 w-3" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-b border-line p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                    {s.menu.errorReports}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
                    {s.menu.errorReportsBody}
                  </p>
                </div>
                <button
                  role="switch"
                  aria-checked={errReports}
                  aria-label={s.menu.errorReports}
                  onClick={toggleErrorReports}
                  className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
                    errReports ? "bg-indigo-500" : "bg-surface-hover"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                      errReports ? "left-[18px]" : "left-0.5"
                    }`}
                  />
                </button>
              </div>
            </div>

            <div className="border-b border-line p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                {s.menu.support}
              </p>
              {/* There is no Daltoon X support destination yet, and this row does
                  not pretend otherwise. The button it replaced pointed at PC
                  Tweaker's support page, which is not a place to send a Daltoon X
                  user; inventing a replacement domain is not a call to make
                  here. Phase 8 gives this a real target — at which point this
                  text and a button both come back. */}
              <p className="mt-1.5 rounded-lg bg-surface-2 px-2.5 py-2 text-[12px] leading-relaxed text-ink-3">
                {s.menu.supportUnavailable}
              </p>
            </div>

            <div className="p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                {s.menu.about}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{s.menu.aboutBody}</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
