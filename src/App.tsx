import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  STRINGS,
  Lang,
  applyDocumentLanguage,
  detectInitialLang,
  format,
  formatCount,
  LANG_STORAGE_KEY,
} from "./i18n";
import { ThemeName, detectInitialTheme, THEME_STORAGE_KEY } from "./theme";
import {
  FEATURE_INTELLIGENCE,
  RAM_AUTO_STORAGE_KEY,
  adoptLegacyAvatar,
  discardLegacyAvatar,
  formatBytes,
  purgeLegacySession,
  storedRamAutoMinutes,
  textFor,
} from "./lib";
import {
  AccountView,
  fetchLicense,
  login as accountLogin,
  logout as accountLogout,
  register as accountRegister,
  restoreSession,
} from "./account-client";
import { AuthState, CleanupInfo, CleanupResult, Section, Toast, TweakInfo } from "./types";
import {
  AppsIcon,
  GemIcon,
  HistoryIcon,
  LayersIcon,
  MagnifierIcon,
  RadarIcon,
  RocketIcon,
  UndoIcon,
  HeartPulseIcon,
  ThermometerIcon,
} from "./components/icons";
import { PaywallModal, ProBadge, ShieldBadge, Toggle, UpdateBanner } from "./components/ui";
import {
  BrowserCleanupCard,
  CleanupCard,
  CleanupConfirmModal,
  DiskToolsSection,
  DnsFlushCard,
  DuplicateFinder,
  IpMaskCard,
  LargeFileFinder,
  PasswordBreachCheck,
} from "./components/maintenance";
import { AccountMenu } from "./components/account";
import { TweakIcon } from "./components/tweak-icon";
import { TechnicalDetails, TechnicalToggle } from "./components/technical";
import { DashboardCards } from "./components/dashboard";
import { GameSessionsPanel, TurboBoostPanel } from "./components/gaming";
import { X3dPanel } from "./components/x3d";
import { ScanPanel } from "./components/scan";
import { HealthPanel } from "./components/health";
import { SystemRepairCard } from "./components/repair";
import { AppCacheCard, CookieCleanerCard } from "./components/cleaners";
import { HardwarePanel } from "./components/hardware";
import { RamCleaner, SystemMonitor, useScheduledRamClean } from "./components/monitor";
import {
  AdvisorCard,
  CrashReportsCard,
  LedgerPanel,
  DriftWatchToggle,
  UpdateDriftCard,
} from "./components/intelligence";
import { usePulseSamples } from "./components/command";
import { ScheduledTaskManager, StartupManager } from "./components/startup";
import { ProfilesPanel } from "./components/profiles";
import { PricingPanel } from "./components/pricing";
import { GamingHudCard, ZeroTraceCard } from "./components/pro";
import { TitleBar } from "./components/titlebar";
import { CATEGORY_STYLE } from "./categories";
import { OverviewPanel } from "./components/overview";
import { WorkspaceSidebar } from "./components/workspace-sidebar";
import { DebloatPanel } from "./components/debloat";
import { ApplicationsPanel } from "./components/applications";
import { AdvancedControlCard } from "./components/advanced-controls";
import { CONFIGURABLE_TWEAK_IDS, isCurrentCatalogTweak } from "./catalog";
import "./App.css";
import "./desktop-refresh.css";

function App() {
  const [lang, setLangState] = useState<Lang>(() => detectInitialLang());
  const s = STRINGS[lang];

  function setLang(l: Lang) {
    setLangState(l);
    localStorage.setItem(LANG_STORAGE_KEY, l);
  }

  const [theme, setThemeState] = useState<ThemeName>(() => detectInitialTheme());

  function setTheme(t: ThemeName) {
    setThemeState(t);
    localStorage.setItem(THEME_STORAGE_KEY, t);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // A layout effect, not an effect: `dir` decides which way the document mirrors,
  // so it has to be set before the browser paints rather than after. The cost is
  // a synchronous style recalculation on language change and nothing else.
  useLayoutEffect(() => {
    applyDocumentLanguage(lang);
  }, [lang]);

  // Starts as `loading`, never as `authenticated` on the strength of a stored
  // value. There is no stored value any more — the session lives in a
  // DPAPI-encrypted file only Rust can read — so this is genuinely unknown
  // until restoreSession() answers.
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  const isProUnlocked = auth.status === "authenticated" && auth.isPro;

  /**
   * Turns an account view into app state.
   *
   * `isPro` starts false and is corrected by refreshLicense() as soon as it
   * resolves. It is never taken from the server's `/me` reply: a client that can
   * be told "you are Pro" by a plain HTTP boolean is a client whose Pro can be
   * spoofed. The licence is signed, and it is the only thing that unlocks a
   * Pro tweak.
   */
  function applyAccount(account: AccountView) {
    setAuth({
      status: "authenticated",
      email: account.email,
      isPro: false,
      // 1.0.0 has no email verification: no verification request, no
      // unverified state, nothing to wait for.
      emailVerified: true,
      plan: null,
      // No Stripe in 1.0.0, so there is never a billing customer to show.
      hasBilling: false,
      lastLoginAt: account.last_login_at,
    });
    // Fire-and-forget: refreshLicense() handles its own errors and must never
    // block the account screen on a signing hiccup.
    void refreshLicense();
  }

  /**
   * Asks the API who is signed in, once.
   *
   * Called on launch and after a sign-in. **Not** called on window focus and
   * **not** polled: there is no deep link back from a payment page to notice, and
   * a repeating request would be a heartbeat the user never agreed to.
   *
   * A network failure keeps whatever state we had. Recording "signed out" because
   * a request timed out would discard a perfectly good session.
   */
  async function refreshAccount() {
    const state = await restoreSession();
    switch (state.status) {
      case "signed-in":
        applyAccount(state.account);
        return;
      case "signed-out":
        setAuth({ status: "anonymous" });
        return;
      case "error":
        pushToast("error", state.error.message);
        // Only a genuine sign-out clears state. An unreachable or failing API
        // leaves the previous state alone.
        if (state.error.kind === "not_signed_in") setAuth({ status: "anonymous" });
        return;
      case "loading":
        return;
    }
  }

  /**
   * Fetches a freshly signed Pro entitlement and records what Rust concluded.
   *
   * The fetch, the signature check, the product and account binding and the
   * expiry all happen in `src-tauri/src/license.rs`; this receives two fields
   * and nothing else. That split is the point: `isPro` here decides what the
   * *badge* says, and `apply_tweak` independently re-verifies from the cache
   * before any Pro tweak runs - so patching this flag changes a label, not an
   * entitlement. See `src-tauri/src/license.rs`.
   *
   * A failure is silent on purpose and changes nothing. It runs in the
   * background after a successful `/me`, on every launch and after every
   * sign-in; a paying customer on a plane must not be shown an error because a
   * refresh could not complete, and the cached licence keeps working until it
   * ages out. The one thing that is never done is reporting a failed refresh as
   * "not Pro".
   */
  async function refreshLicense() {
    try {
      const licence = await fetchLicense();
      setAuth((current) =>
        current.status === "authenticated"
          ? { ...current, isPro: licence.is_pro, plan: licence.plan ?? null }
          : current,
      );
    } catch {
      // Offline, signed out, or the deployment cannot sign. Whatever was cached
      // before keeps working until its grace period runs out.
    }
  }

  useEffect(() => {
    // Any session token an older version wrote to localStorage/sessionStorage is
    // a live credential nobody is revoking. Delete it before anything else runs.
    purgeLegacySession();

    // Restore once, on launch. No focus listener and no polling — see
    // refreshAccount.
    void refreshAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Before per-account photos the file belonged to the computer rather than to an
  // account. Whoever is signed in as the app starts is the one who was using it
  // when the update landed, so the old photo is theirs. Doing this at sign-in
  // instead would hand it to the next account.
  useEffect(() => {
    if (auth.status === "authenticated" && auth.lastLoginAt === null) {
      void adoptLegacyAvatar(auth.email);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status === "authenticated" ? auth.email : null]);

  function logout() {
    // Rust drops the cookie it would have replayed, whether or not the server
    // answered, so there is no local token left behind to clear.
    void accountLogout();
    setAuth({ status: "anonymous" });
    // Without this, a still-fresh cached Pro license would keep unlocking
    // Pro tweaks for whoever uses the app next on this machine, for up to
    // its grace period — including an anonymous session.
    void invoke("clear_license").catch(() => {});
    // Same reasoning for the photo: a machine-wide leftover from before
    // per-account storage must not survive to be inherited by whoever signs
    // in next. Each account's own photo is untouched and waiting for them.
    void discardLegacyAvatar();
  }

  /**
   * Signs in, or creates an account and then signs in.
   *
   * Registration is followed by an explicit sign-in rather than returning a
   * session: the API issues no cookie on `/register` (it answers every outcome
   * identically so it cannot be used to discover which addresses exist), so
   * there is nothing to be signed in with until the login request is made.
   *
   * Takes no `remember` flag and no name or date of birth, because there is
   * nothing for them to decide or fill: the session is Rust's to keep and the
   * `accounts` table has no column for a name. Both were removed from the
   * signature rather than accepted-and-ignored, so no caller can pass them.
   */
  async function authenticate(mode: "login" | "register", email: string, password: string) {
    if (mode === "register") {
      // Every outcome — created, or already existed — answers the same way, and
      // the caller is told the same thing. Whether the address was taken is not
      // something this app is allowed to reveal.
      await accountRegister(email, password);
    }

    const state = await accountLogin(email, password);
    if (state.status === "signed-in") {
      applyAccount(state.account);
      return;
    }
    if (state.status === "error") {
      if (state.error.kind === "not_signed_in") {
        // The API's single answer for a wrong password, an unknown address and
        // a disabled account. Passing it through unchanged is what stops this
        // screen from becoming the enumeration channel the API works to remove.
        throw new Error(state.error.message);
      }
      throw new Error(state.error.message);
    }
    // Signed out without an error. Treated as a failure rather than a success,
    // because the user asked to be signed in and is not.
    throw new Error(s.auth.backendNotConfigured);
  }

  /**
   * Upgrading to Pro.
   *
   * Phase 6 previously anticipated a checkout; in this release Pro is granted by
   * an administrator. There is no payment provider, no price to take and no
   * checkout to open. Throwing rather than returning quietly is deliberate — the
   * button is reachable, and a click that does nothing is worse than one that
   * says why.
   */
  async function startCheckout(): Promise<never> {
    throw new Error(s.pricing.notAvailableYet);
  }

  /**
   * A one-off tip.
   *
   * Same reason as `startCheckout`: no payment provider in 1.0.0. Nothing here
   * depended on the session either way — a tip is not tied to an account and
   * unlocks nothing — but there is nowhere to send one.
   */
  async function buyCoffee(): Promise<never> {
    throw new Error(s.pricing.notAvailableYet);
  }

  /**
   * The Stripe billing portal.
   *
   * Nothing to show: there is no Stripe customer for an account to have, which
   * is why `AuthState.hasBilling` is hard-coded false in 1.0.0. The button is
   * hidden rather than shown-and-broken, so this exists only to satisfy the
   * signature the pricing panel expects.
   */
  async function openBillingPortal(): Promise<never> {
    throw new Error(s.pricing.notAvailableYet);
  }

  const CATEGORIES: { key: Section; label: string; icon: React.ReactElement }[] = [
    {
      key: "overview",
      label: s.tabs.overview,
      icon: <HeartPulseIcon className="h-[18px] w-[18px]" />,
    },
    { key: "scan", label: s.tabs.scan, icon: <RadarIcon className="h-[18px] w-[18px]" /> },
    { key: "health", label: s.tabs.health, icon: <HeartPulseIcon className="h-[18px] w-[18px]" /> },
    {
      key: "hardware",
      label: s.tabs.hardware,
      icon: <ThermometerIcon className="h-[18px] w-[18px]" />,
    },
    { key: "performance", label: s.tabs.performance, icon: CATEGORY_STYLE.performance.icon },
    { key: "gaming", label: s.tabs.gaming, icon: CATEGORY_STYLE.gaming.icon },
    { key: "privacy", label: s.tabs.privacy, icon: CATEGORY_STYLE.privacy.icon },
    { key: "startup", label: s.tabs.startup, icon: <RocketIcon className="h-[18px] w-[18px]" /> },
    { key: "debloat", label: "Debloat", icon: <LayersIcon className="h-[18px] w-[18px]" /> },
    { key: "ui", label: s.tabs.ui, icon: CATEGORY_STYLE.ui.icon },
    { key: "manutenzione", label: s.tabs.manutenzione, icon: CATEGORY_STYLE.manutenzione.icon },
    { key: "profiles", label: s.tabs.profiles, icon: <LayersIcon className="h-[18px] w-[18px]" /> },
    { key: "ledger", label: s.tabs.ledger, icon: <HistoryIcon className="h-[18px] w-[18px]" /> },
    { key: "pricing", label: s.tabs.pricing, icon: <GemIcon className="h-[18px] w-[18px]" /> },
    {
      key: "applications",
      label: s.tabs.applications,
      icon: <AppsIcon className="h-[18px] w-[18px]" />,
    },
  ];

  const [tweaks, setTweaks] = useState<TweakInfo[]>([]);
  const [cleanupTargets, setCleanupTargets] = useState<CleanupInfo[]>([]);
  const [filter, setFilterState] = useState<Section>("overview");
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);

  /**
   * Picking a section always clears an active search.
   *
   * While `searching` is true every section panel is suppressed (see the
   * `&& !searching` guards below) and the list shows matches from every
   * section instead. That meant clicking a sidebar entry with text still in
   * the search box changed nothing on screen — the app looked frozen rather
   * than filtered. Navigating is an explicit "show me this section", so it
   * wins over a leftover query.
   */
  const setFilter = useCallback((section: Section) => {
    setFilterState(section);
    setQuery("");
    contentRef.current?.scrollTo({ top: 0 });
  }, []);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  /** Id of the tweak whose exact registry write is currently disclosed. */
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState<CleanupInfo | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // Owned here rather than inside RamCleaner so the schedule keeps running
  // when the user navigates away from the Scan screen.
  const [ramAutoMinutes, setRamAutoMinutes] = useState<number>(storedRamAutoMinutes);
  // Command Center bridge: the Pulse asks for scans and mirrors the panel.
  const pulseSamples = usePulseSamples();
  const toastSeq = useRef(0);

  const autoClean = useScheduledRamClean(ramAutoMinutes);

  function chooseRamAuto(minutes: number) {
    setRamAutoMinutes(minutes);
    localStorage.setItem(RAM_AUTO_STORAGE_KEY, String(minutes));
  }

  async function refresh() {
    const [list, cleanup] = await Promise.all([
      invoke<TweakInfo[]>("list_tweaks"),
      invoke<CleanupInfo[]>("list_cleanup_targets"),
    ]);
    setTweaks(list);
    setCleanupTargets(cleanup);
  }

  useEffect(() => {
    refresh().catch((e) => pushToast("error", String(e)));
  }, []);

  function pushToast(kind: Toast["kind"], message: string) {
    // Every user-visible error funnels through here, which makes it the one
    // honest hook for opt-in error reporting: what gets reported is exactly
    // what the user saw, never more.
    if (kind === "error") reportError(message);
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4000);
  }

  async function toggle(tweak: TweakInfo) {
    const text = textFor(s.tweaks, tweak.id, tweak.name, tweak.description);
    if (tweak.requires_pro && !isProUnlocked) {
      setPaywallFeature(text.name);
      return;
    }
    setBusyId(tweak.id);
    try {
      if (tweak.applied) {
        await invoke("rollback_tweak", { id: tweak.id });
        pushToast("success", format(s.toasts.rolledBack, { name: text.name }));
      } else {
        await invoke("apply_tweak", { id: tweak.id });
        pushToast("success", format(s.toasts.applied, { name: text.name }));
      }
      await refresh();
    } catch (e) {
      // The Rust side re-verifies Pro independently of this screen's own
      // gate above — see license.rs. In normal use that gate already stops
      // a non-Pro user from getting here, so the only realistic way to hit
      // this is a genuine subscriber whose cached proof of that went stale
      // from being offline past the grace period. Rust's raw error message
      // ("requires an active subscription") would be misleading for them —
      // they have one — so this is worded around reconnecting instead.
      const message = String(e);
      if (message.startsWith("PRO_REQUIRED: ")) {
        pushToast("error", s.toasts.licenseNeedsRefresh);
      } else {
        pushToast("error", message);
      }
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Turns off every applied tweak in one action. Goes through the batched
   * `rollback_tweaks` command so the whole restore costs a single UAC prompt
   * instead of one per admin-level tweak, and reports per-tweak failures
   * rather than stopping at the first one.
   */
  async function restoreAll() {
    const appliedIds = tweaks
      .filter((t) => t.applied && !CONFIGURABLE_TWEAK_IDS.has(t.id))
      .map((t) => t.id);
    setConfirmRestore(false);
    if (appliedIds.length === 0) {
      pushToast("error", s.restore.nothingToast);
      return;
    }
    setRestoring(true);
    try {
      const failures = await invoke<string[]>("rollback_tweaks", { ids: appliedIds });
      failures.forEach((f) => pushToast("error", f));
      await refresh();
      const restored = appliedIds.length - failures.length;
      if (restored > 0) pushToast("success", formatCount(s.restore.doneToast, restored));
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setRestoring(false);
    }
  }

  async function runCleanup(info: CleanupInfo) {
    setBusyId(info.id);
    setConfirmCleanup(null);
    try {
      const result = await invoke<CleanupResult>("run_cleanup", { id: info.id });
      const base = formatCount(s.cleanupResultToast, result.deleted_count, {
        freed: formatBytes(result.freed_bytes),
      });
      const suffix =
        result.skipped_count > 0
          ? formatCount(s.cleanupResultToastSkipped, result.skipped_count)
          : ".";
      pushToast("success", base + suffix);
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setBusyId(null);
    }
  }

  /** Cleans only the preview items the user left ticked. Same result/toast
   *  shape as the full cleanup — from the user's side it's the same action,
   *  just scoped. */
  async function runCleanupSelected(info: CleanupInfo, names: string[]) {
    setBusyId(info.id);
    setConfirmCleanup(null);
    try {
      const result = await invoke<CleanupResult>("run_cleanup_selected", {
        id: info.id,
        names,
      });
      const base = formatCount(s.cleanupResultToast, result.deleted_count, {
        freed: formatBytes(result.freed_bytes),
      });
      const suffix =
        result.skipped_count > 0
          ? formatCount(s.cleanupResultToastSkipped, result.skipped_count)
          : ".";
      pushToast("success", base + suffix);
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setBusyId(null);
    }
  }

  const searching = query.trim().length > 0;

  const visibleTweaks = useMemo(() => {
    // Turbo Boost is deliberately excluded: it has its own dedicated card on
    // the Gaming screen, so listing it again would show two controls for it.
    const base = tweaks.filter((t) => t.id !== "turbo_boost");

    // While searching, ignore the selected section and look everywhere —
    // otherwise the user has to already know which category a tweak lives in,
    // which is exactly what the search is there to avoid.
    if (searching) {
      const needle = query.trim().toLowerCase();
      return base.filter((t) => {
        const text = textFor(s.tweaks, t.id, t.name, t.description);
        return (
          text.name.toLowerCase().includes(needle) ||
          text.description.toLowerCase().includes(needle)
        );
      });
    }

    if (
      filter === "overview" ||
      filter === "scan" ||
      filter === "health" ||
      filter === "hardware" ||
      filter === "startup" ||
      filter === "pricing" ||
      filter === "profiles"
    )
      return [];

    const inCategory = base.filter((t) => t.category === filter);

    // Give Pro items some prominence without turning a section into a
    // storefront: the first two Pro tweaks move to the top, and every other
    // one keeps its place further down among the free ones. A section that
    // opened with nothing but padlocks would read as "this app is all about
    // the money", which is the opposite of what earns the upgrade.
    //
    // Order within each group is preserved (a stable partition), so this never
    // scrambles the list — it only lifts the first couple of entries.
    const PROMOTED_PRO = 2;
    const promoted: TweakInfo[] = [];
    const rest: TweakInfo[] = [];
    for (const t of inCategory) {
      if (t.requires_pro && promoted.length < PROMOTED_PRO) promoted.push(t);
      else rest.push(t);
    }
    return [...promoted, ...rest];
  }, [tweaks, filter, query, searching, s]);

  const showCleanup = filter === "manutenzione" && !searching;
  const showPrivacyExtras = filter === "privacy" && !searching;
  const showGamingExtras = filter === "gaming" && !searching;
  const showOverview = filter === "overview" && !searching;
  const showScan = filter === "scan" && !searching;
  const showHealth = filter === "health" && !searching;
  const showHardware = filter === "hardware" && !searching;
  const showStartup = filter === "startup" && !searching;
  const showPricing = filter === "pricing" && !searching;
  const showProfiles = filter === "profiles" && !searching;
  const showLedger = FEATURE_INTELLIGENCE && filter === "ledger" && !searching;
  // The catalog screen shows applications, not tweaks, so the applied-count
  // line and the tweak search box would both describe a list that is not on
  // screen. The section header uses `currentLabel` like every other section.
  const showApplications = filter === "applications" && !searching;
  const turboBoostApplied = tweaks.find((t) => t.id === "turbo_boost")?.applied ?? false;
  const catalogTweaks = tweaks.filter((t) => isCurrentCatalogTweak(t.id));
  const appliedCount = catalogTweaks.filter(
    (t) => t.applied && !CONFIGURABLE_TWEAK_IDS.has(t.id),
  ).length;
  const restorableCount = tweaks.filter(
    (t) => t.applied && !CONFIGURABLE_TWEAK_IDS.has(t.id),
  ).length;
  // What the pricing page can honestly promise a Free user.
  const freeTweakCount = catalogTweaks.filter((t) => !t.requires_pro).length;

  const currentLabel = CATEGORIES.find((c) => c.key === filter)?.label ?? "";

  // The title bar shows the machine as it is right now, from the same samples
  // the monitor draws. Before the first sample lands both are null, and the
  // bar leaves the meters out rather than drawing a 0% that would read as an
  // idle machine.
  const latestPulse = pulseSamples.length > 0 ? pulseSamples[pulseSamples.length - 1] : null;
  const ramPct =
    latestPulse && latestPulse.ramTotal > 0
      ? (latestPulse.ramUsed / latestPulse.ramTotal) * 100
      : null;

  return (
    <div className="desktop-refresh bg-app text-ink flex h-screen flex-col overflow-hidden [font-family:var(--font-app)]">
      {/* The window is frameless, so the app draws its own chrome. */}
      <TitleBar
        s={s}
        appliedCount={appliedCount}
        totalCount={catalogTweaks.length}
        cpuPct={latestPulse ? latestPulse.cpu : null}
        ramPct={ramPct}
      />

      <main className="flex min-h-0 flex-1">
        {/* Control Room shell: an opaque raised band for navigation, separated
          from the content floor by a hairline — depth from luminance and
          borders, never blur or shadows. */}
        <WorkspaceSidebar
          s={s}
          items={CATEGORIES}
          active={filter}
          isPro={isProUnlocked}
          showHistory={FEATURE_INTELLIGENCE}
          onNavigate={setFilter}
          onTip={async () => {
            try {
              await buyCoffee();
            } catch (e) {
              pushToast("error", String(e instanceof Error ? e.message : e));
            }
          }}
        />

        <div
          ref={contentRef}
          className="workspace-content app-field min-w-0 flex-1 overflow-y-auto px-8 py-7"
        >
          {/* The pricing comparison needs the extra width to sit side by side;
            every other screen reads better kept narrow. */}
          <div
            className={`workspace-page mx-auto ${showPricing ? "workspace-pricing-page" : ""} ${showPricing || showOverview ? "max-w-5xl" : "max-w-3xl"}`}
          >
            <header
              className={`workspace-header border-line flex items-start justify-between gap-4 ${filter === "debloat" ? "mb-2" : "mb-6 border-b pb-4"}`}
            >
              {/* The pricing screen leads with its own hero title, so
                the section heading would just be a duplicate above it. */}
              <div className="min-w-0">
                {!showPricing && filter !== "debloat" && (
                  <h1 className="type-page page-title">{currentLabel}</h1>
                )}
                {showApplications && (
                  <p className="mt-1 text-ink-3 type-data text-[12.5px]">
                    {s.applications.subtitle}
                  </p>
                )}
                {/* Overview and Startup provide their own counts; the catalog
                  screen has no tweaks to count. */}
                {!showOverview &&
                  !showStartup &&
                  !showPricing &&
                  !showApplications &&
                  filter !== "debloat" && (
                    <div className="mt-1 flex items-center gap-3">
                      <p className="text-ink-3 type-data text-[12.5px]">
                        {formatCount(s.appliedCount, appliedCount, { total: catalogTweaks.length })}
                      </p>
                      {/* Restore supported settings from their saved values. */}
                      {restorableCount > 0 && (
                        <button
                          onClick={() => setConfirmRestore(true)}
                          disabled={restoring}
                          className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-1 text-xs font-semibold text-ink-2 transition-colors hover:border-line-2 hover:bg-surface-hover hover:text-white disabled:cursor-wait disabled:opacity-60"
                        >
                          <UndoIcon className="h-3.5 w-3.5" />
                          {restoring ? s.restore.running : s.restore.button}
                        </button>
                      )}
                    </div>
                  )}
              </div>
              {!showPricing && !showApplications && filter !== "debloat" && (
                <div className="relative ms-auto w-56 shrink-0">
                  <MagnifierIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                    aria-label={s.search.placeholder}
                    placeholder={s.search.placeholder}
                    className="w-full rounded-xl border border-line bg-surface-2 py-2 pl-9 pr-8 text-sm text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-line-2 focus:bg-surface-hover"
                  />
                  {searching && (
                    <button
                      onClick={() => setQuery("")}
                      aria-label={s.search.clear}
                      className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-surface-hover hover:text-ink-2"
                    >
                      ✕
                    </button>
                  )}
                </div>
              )}

              <AccountMenu
                s={s}
                lang={lang}
                setLang={setLang}
                theme={theme}
                setTheme={setTheme}
                auth={auth}
                open={accountMenuOpen}
                onOpenChange={setAccountMenuOpen}
                onAuthenticate={authenticate}
                onLogout={logout}
                onUpgrade={() => setPaywallFeature(s.menu.planPro)}
                onViewPlan={() => setFilter("pricing")}
                pushToast={pushToast}
              />
            </header>

            {showOverview && (
              <OverviewPanel
                s={s}
                lang={lang}
                tweaks={tweaks}
                samples={pulseSamples}
                onNavigate={setFilter}
              />
            )}

            {/* Free RAM leads the home screen: it is the card people use every
              day (one click, schedulable), so it earns the top spot over the
              passive monitor below it. */}
            {showScan && (
              <>
                <RamCleaner
                  s={s}
                  samples={pulseSamples}
                  autoMinutes={ramAutoMinutes}
                  onChangeAuto={chooseRamAuto}
                  auto={autoClean}
                  pushToast={pushToast}
                />
                <SystemMonitor s={s} />
                {/* One concrete, hardware-motivated recommendation — never a
                  pile. Hidden entirely when the flag is off. */}
                {FEATURE_INTELLIGENCE && (
                  <AdvisorCard
                    s={s}
                    tweaks={tweaks}
                    busyId={busyId}
                    isPro={isProUnlocked}
                    onRequirePro={() => setPaywallFeature(s.menu.planPro)}
                    onApply={toggle}
                  />
                )}
              </>
            )}

            {showScan && <DashboardCards s={s} onNavigate={setFilter} />}

            {showHardware && (
              <HardwarePanel
                s={s}
                isPro={isProUnlocked}
                onRequirePro={() => setPaywallFeature(s.driverBooster.title)}
                pushToast={pushToast}
              />
            )}

            {showHealth && (
              <SystemRepairCard
                s={s}
                isPro={isProUnlocked}
                onRequirePro={() => setPaywallFeature(s.systemRepair.title)}
                pushToast={pushToast}
              />
            )}

            {showHealth && (
              <HealthPanel
                title={s.healthPanel.title}
                subtitle={s.healthPanel.subtitle}
                refreshLabel={s.healthPanel.refresh}
                computeLabel={s.healthPanel.compute}
                computingLabel={s.healthPanel.computing}
                idleHint={s.healthPanel.idleHint}
                showMore={s.healthPanel.showMore}
                showLess={s.healthPanel.showLess}
                stages={[
                  s.healthPanel.stageProfile,
                  s.healthPanel.stageTweaks,
                  s.healthPanel.stageSecurity,
                  s.healthPanel.stageScoring,
                ]}
                verdicts={{
                  excellent: s.healthPanel.verdictExcellent,
                  good: s.healthPanel.verdictGood,
                  fair: s.healthPanel.verdictFair,
                  needsWork: s.healthPanel.verdictNeedsWork,
                }}
                baseline={{
                  title: s.healthPanel.baselineTitle,
                  hint: s.healthPanel.baselineHint,
                  run: s.healthPanel.baselineRun,
                  running: s.healthPanel.baselineRunning,
                  empty: s.healthPanel.baselineEmpty,
                }}
                change={{
                  sinceLast: s.healthPanel.changeSinceLast,
                  noChange: s.healthPanel.changeNone,
                  firstRun: s.healthPanel.changeFirstRun,
                  whyTitle: s.healthPanel.changeWhyTitle,
                  contributes: s.healthPanel.changeContributes,
                  structural: s.healthPanel.changeStructural,
                  trend: s.healthPanel.changeTrend,
                }}
                categoryLabels={s.healthPanel.categories}
              />
            )}

            {showLedger && (
              <>
                {/* Above the ledger: a crash is the one thing on this screen
                  that needs acting on, and it renders nothing at all when
                  there are no reports. */}
                {/* Above the crash card: a reverted tweak is something the
                  user can act on right now, and it renders nothing when
                  nothing drifted. */}
                <DriftWatchToggle s={s} pushToast={pushToast} />
                <UpdateDriftCard s={s} tweaks={tweaks} onChanged={refresh} pushToast={pushToast} />
                <CrashReportsCard s={s} pushToast={pushToast} />
                <LedgerPanel
                  s={s}
                  lang={lang}
                  tweaks={tweaks}
                  onChanged={refresh}
                  pushToast={pushToast}
                />
              </>
            )}

            {showStartup && <StartupManager s={s} pushToast={pushToast} />}

            {/* Keep operation state alive when navigating during a removal. */}
            <div hidden={filter !== "debloat" || searching}>
              <DebloatPanel
                lang={lang}
                active={filter === "debloat" && !searching}
                onNavigate={setFilter}
              />
            </div>

            {showStartup && <ScheduledTaskManager s={s} pushToast={pushToast} />}

            {showApplications && <ApplicationsPanel s={s} pushToast={pushToast} />}

            {showProfiles && (
              <ProfilesPanel
                s={s}
                lang={lang}
                lifetimeOwned={
                  isProUnlocked && auth.status === "authenticated" && auth.plan === "lifetime"
                }
                onViewPlans={() => setFilter("pricing")}
                tweaks={tweaks}
                isPro={isProUnlocked}
                authed={auth.status === "authenticated"}
                onRequireAuth={() => {
                  pushToast("error", s.profiles.signInRequired);
                  setAccountMenuOpen(true);
                }}
                onRequirePro={() => setPaywallFeature(s.profiles.title)}
                onChanged={refresh}
                pushToast={pushToast}
              />
            )}

            {showPricing && (
              <PricingPanel
                s={s}
                lang={lang}
                isPro={isProUnlocked}
                heldPlan={auth.status === "authenticated" ? auth.plan : null}
                hasBilling={auth.status === "authenticated" && auth.hasBilling}
                freeTweakCount={freeTweakCount}
                onOpenLifetimeTools={() => setFilter("profiles")}
                onChoosePro={async () => {
                  // A signed-out visitor is exactly who this button is for, so
                  // send them to the account menu rather than to a pricing
                  // error. For a signed-in account the answer is that there is
                  // nothing to buy: Pro is granted by hand in 1.0.0.
                  if (auth.status !== "authenticated") {
                    pushToast("error", s.auth.loginRequiredForCheckout);
                    setAccountMenuOpen(true);
                    return;
                  }
                  try {
                    await startCheckout();
                  } catch (e) {
                    pushToast("error", String(e instanceof Error ? e.message : e));
                  }
                }}
                onManageBilling={async () => {
                  try {
                    await openBillingPortal();
                  } catch (e) {
                    pushToast("error", String(e instanceof Error ? e.message : e));
                  }
                }}
              />
            )}

            {showScan && (
              <div id="scan-results">
                <ScanPanel
                  s={s}
                  tweaks={tweaks}
                  cleanupTargets={cleanupTargets}
                  isPro={isProUnlocked}
                  onRequirePro={() => setPaywallFeature(s.menu.planPro)}
                  onFixed={refresh}
                  pushToast={pushToast}
                />
              </div>
            )}

            {showPrivacyExtras && (
              <>
                <ZeroTraceCard
                  s={s}
                  isPro={isProUnlocked}
                  onRequirePro={() => setPaywallFeature(s.zeroTrace.title)}
                  pushToast={pushToast}
                />
                <PasswordBreachCheck s={s} />
              </>
            )}

            {showGamingExtras && (
              <>
                <GameSessionsPanel
                  s={s}
                  isPro={isProUnlocked}
                  onRequirePro={() => setPaywallFeature(s.gameSessions.title)}
                />
                <TurboBoostPanel
                  s={s}
                  applied={turboBoostApplied}
                  onChanged={refresh}
                  pushToast={pushToast}
                />
                {/* Below the two headline cards: Game Sessions and Turbo Boost
                  are what this screen is known for, and the aligner applies to
                  a minority of processors. */}
                <X3dPanel s={s} pushToast={pushToast} />
              </>
            )}

            {/* On the UI screen: it is a panel the user places, sizes and
              locks, which is the kind of thing that screen is for. Above the
              tweak list, like every other screen's headline card — below
              forty-odd rows nobody scrolled far enough to find it. */}
            {filter === "ui" && !searching && (
              <GamingHudCard
                s={s}
                isPro={isProUnlocked}
                onRequirePro={() => setPaywallFeature(s.hud.title)}
                pushToast={pushToast}
              />
            )}

            <ul className="flex flex-col gap-3">
              {visibleTweaks.map((t, i) => {
                if (
                  t.id === "ecoqos_rules" ||
                  t.id === "limit_do_background_download" ||
                  t.id === "monitor_refresh_profile"
                ) {
                  return (
                    <li key={t.id} className="animate-card">
                      <AdvancedControlCard
                        id={t.id}
                        lang={lang}
                        isPro={isProUnlocked}
                        onRequirePro={setPaywallFeature}
                      />
                    </li>
                  );
                }
                const style = CATEGORY_STYLE[t.category];
                const text = textFor(s.tweaks, t.id, t.name, t.description);
                return (
                  <li
                    key={t.id}
                    style={{ animationDelay: `${i * 40}ms` }}
                    className="animate-card panel panel-hover group relative overflow-hidden p-4"
                  >
                    {/* The category tint only shows on hover, and only at the
                      corner the light comes from — enough to tell two sections
                      apart, not enough to colour the card. */}
                    <div
                      className={`pointer-events-none absolute inset-0 bg-gradient-to-br opacity-0 transition-opacity duration-300 group-hover:opacity-100 ${style.ring}`}
                    />
                    <div className="relative flex items-center gap-4">
                      {/* A backlit module, not a tile. The backlight is gold on
                        a Pro tweak and the theme accent otherwise, so the tier
                        registers before any badge is read. */}
                      <div
                        className="icon-module grid h-11 w-11 shrink-0 place-items-center"
                        style={
                          {
                            "--module-tint": style.tint,
                            "--module-glow": t.requires_pro
                              ? "rgb(230 187 74 / 0.42)"
                              : "color-mix(in oklab, var(--accent) 45%, transparent)",
                          } as React.CSSProperties
                        }
                      >
                        <TweakIcon id={t.id} fallback={style.icon} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-white">
                            {text.name}
                          </h2>
                          {/* The (i) is the door to the exact system change.
                            A description can be argued with; a registry path
                            can be checked in regedit, so it is one click away
                            rather than buried in a FAQ. */}
                          {t.changes.length > 0 ? (
                            <TechnicalToggle
                              open={inspecting === t.id}
                              label={s.transparency.title}
                              hive={t.hive}
                              onClick={() => {
                                setInspecting(inspecting === t.id ? null : t.id);
                              }}
                            />
                          ) : (
                            t.hive !== "—" && (
                              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-2">
                                {t.hive}
                              </span>
                            )
                          )}
                          {t.requires_admin && <ShieldBadge label={s.badges.admin} />}
                          {t.requires_pro && <ProBadge label={s.badges.pro} />}
                        </div>
                        <p className="mt-1 max-w-[52ch] text-[12.5px] leading-[1.55] text-ink-3">
                          {text.description}
                        </p>
                        {inspecting === t.id && <TechnicalDetails changes={t.changes} s={s} />}
                      </div>
                      <Toggle
                        checked={t.applied}
                        busy={busyId === t.id}
                        onClick={() => toggle(t)}
                        s={s}
                      />
                    </div>
                  </li>
                );
              })}

              {showPrivacyExtras && (
                <IpMaskCard s={s} onExplain={() => pushToast("error", s.ipMask.explainerToast)} />
              )}

              {showCleanup && (
                <DiskToolsSection
                  s={s}
                  isPro={isProUnlocked}
                  onRequirePro={() => setPaywallFeature(s.diskOptimize.title)}
                  onToast={pushToast}
                />
              )}

              {showCleanup &&
                cleanupTargets.map((c) => (
                  <CleanupCard
                    key={c.id}
                    s={s}
                    info={c}
                    text={textFor(s.cleanup, c.id, c.name, c.description)}
                    busy={busyId === c.id}
                    isPro={isProUnlocked}
                    onRequirePro={() =>
                      setPaywallFeature(textFor(s.cleanup, c.id, c.name, c.description).name)
                    }
                    onRun={(info) => setConfirmCleanup(info)}
                  />
                ))}

              {showCleanup && <DnsFlushCard s={s} onToast={pushToast} />}

              {showCleanup && <BrowserCleanupCard s={s} onToast={pushToast} />}

              {/* Directly under the browser cleaner it supersedes for cookies:
                that card wipes the whole cookie file and signs the user out of
                everything, which is why most people click it once. This one is
                the version they can use every week. */}
              {showCleanup && (
                <CookieCleanerCard
                  s={s}
                  isPro={isProUnlocked}
                  onRequirePro={() => setPaywallFeature(s.cookieCleaner.title)}
                  onToast={pushToast}
                />
              )}

              {showCleanup && (
                <AppCacheCard
                  s={s}
                  isPro={isProUnlocked}
                  onRequirePro={() => setPaywallFeature(s.appCache.title)}
                  onToast={pushToast}
                />
              )}

              {showCleanup && (
                <DuplicateFinder
                  s={s}
                  isPro={isProUnlocked}
                  onRequirePro={() => setPaywallFeature(s.duplicateFinder.title)}
                  onToast={pushToast}
                />
              )}

              {showCleanup && (
                <LargeFileFinder
                  s={s}
                  isPro={isProUnlocked}
                  onRequirePro={() => setPaywallFeature(s.largeFiles.title)}
                  onToast={pushToast}
                />
              )}

              {/* "No tweaks in this category" only makes sense on a screen that
                IS a tweak category. It was an opt-out list of every other
                section, which meant each new screen had to remember to add
                itself — PC Health never did, and has been telling people it
                had no tweaks coming soon ever since. Asking whether the
                current filter is a real category cannot drift that way. */}
              {visibleTweaks.length === 0 &&
                (searching || Object.prototype.hasOwnProperty.call(CATEGORY_STYLE, filter)) &&
                !showCleanup &&
                !showPrivacyExtras &&
                !showScan &&
                !showStartup &&
                !showPricing && (
                  <li className="animate-card rounded-2xl border border-dashed border-line p-10 text-center text-sm text-ink-3">
                    {searching
                      ? format(s.search.noResults, { query: query.trim() })
                      : s.emptyCategory}
                  </li>
                )}
            </ul>

            <p className="mx-auto mt-8 max-w-lg text-center text-xs leading-relaxed text-ink-3">
              {s.headerNote}
            </p>
          </div>
        </div>
      </main>

      {confirmCleanup && (
        <CleanupConfirmModal
          s={s}
          info={confirmCleanup}
          displayName={
            textFor(s.cleanup, confirmCleanup.id, confirmCleanup.name, confirmCleanup.description)
              .name
          }
          onCancel={() => setConfirmCleanup(null)}
          onConfirmAll={() => runCleanup(confirmCleanup)}
          onConfirmSelected={(names) => runCleanupSelected(confirmCleanup, names)}
        />
      )}

      {confirmRestore && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="animate-card w-full max-w-sm rounded-2xl border border-line bg-slate-900 p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-ink">{s.restore.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-3">
              {formatCount(s.restore.body, restorableCount)}
            </p>
            <button
              onClick={restoreAll}
              className="mt-5 w-full rounded-xl bg-amber-500 py-2.5 text-sm font-semibold text-amber-950 transition-colors hover:bg-amber-400"
            >
              {s.restore.confirm}
            </button>
            <button
              onClick={() => setConfirmRestore(false)}
              className="mt-2 w-full rounded-xl py-2 text-sm font-medium text-ink-3 hover:text-ink-2"
            >
              {s.restore.cancel}
            </button>
          </div>
        </div>
      )}

      {paywallFeature && (
        <PaywallModal
          s={s}
          featureName={paywallFeature}
          onClose={() => setPaywallFeature(null)}
          // Send them to the plans instead of straight to a checkout for a
          // plan they never picked — they should see monthly vs yearly first.
          onNotify={() => {
            setPaywallFeature(null);
            setFilter("pricing");
          }}
        />
      )}

      <UpdateBanner s={s} onToast={pushToast} />

      <div className="pointer-events-none fixed bottom-6 right-6 flex flex-col gap-2">
        {toasts.map((t) => (
          // Calm feedback: an opaque surface with a status-colored icon and
          // hairline. Status is carried by icon shape AND color, never color
          // alone.
          <div
            key={t.id}
            className={`animate-toast bg-surface-2 border-line-2 text-ink pointer-events-auto flex items-center gap-2.5 rounded-[10px] border px-4 py-3 text-[13px] font-medium ${
              t.kind === "success" ? "[&>svg]:text-ok" : "[&>svg]:text-danger"
            }`}
          >
            {t.kind === "success" ? (
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 shrink-0">
                <path
                  d="m5 13 4 4L19 7"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 shrink-0">
                <path
                  d="M12 9v4m0 4h.01M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
