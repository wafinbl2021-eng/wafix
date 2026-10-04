import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { format, Strings } from "../i18n";
import { formatBytes } from "../lib";
import type {
  Toast,
  WafxApp,
  WafxCategory,
  WafxDownloadProgress,
  WafxInstallPhaseEvent,
  WafxInstallResult,
} from "../types";
import { AppsIcon } from "./icons";

/**
 * The Daltoon X catalog screen.
 *
 * Everything here is a read of what Rust fetched. The panel sends two
 * identifiers when the user presses Install — an app id and a version id — and
 * Rust resolves the download URL, the checksum and the installer mode itself.
 * Nothing the webview holds can change what gets launched, which is the same
 * reason the download never happens in here either.
 *
 * The checksum is optional in the catalog, so `install_wafx_app` may come back
 * `verified: false`. That is reported rather than smoothed over: Rust omits the
 * `verify` phase when there was no digest to check, so this side never labels an
 * install as verified on the strength of a phase it did not receive.
 */
type Phase = "download" | "verify" | "install" | "done" | "failed";

type Catalog = { apps: WafxApp[]; categories: WafxCategory[] };

/**
 * The card's name, verbatim in every language.
 *
 * This is a product label, not a sentence: `Steam` names the store and
 * `LuaTools` is the program's own name, so neither is translated and no locale
 * entry carries it. Putting it here rather than in the locale table is what
 * keeps it identical across all seven.
 */
const LUA_TOOLS_LABEL = "Steam LuaTools";

/**
 * What Rust found on the machine, or what happened when the user asked.
 *
 * `status` is a discriminant Rust chooses, never a message this side has to
 * read: the wording lives in the locale table and the reasons live in `detail`,
 * which is shown to nobody. Reading `detail` would be reading an English
 * sentence out of Rust, which is exactly the coupling the catalog above avoids.
 */
type LuaToolsReport = {
  status: "installed" | "launched" | "not_installed" | "runtime_missing" | "error";
  official_page: string | null;
  detail: string | null;
};

/**
 * Whether the card's primary action should start LuaTools.
 *
 * `runtime_missing` is excluded on purpose: the program is there and the button
 * would work on a machine that has the runtime, but this one does not, and
 * telling the user to install a framework is the honest instruction rather than
 * a launch that dies on a dialog they did not ask for.
 */
function luaToolsCanLaunch(status: LuaToolsReport["status"]): boolean {
  return status === "installed" || status === "launched";
}

/**
 * One catalog read.
 *
 * Apps and categories are fetched together and awaited together, so a partial
 * result is never shown: if either call fails the panel offers a retry rather
 * than a grid with no category rail and no explanation.
 */
function readCatalog(): Promise<Catalog> {
  return Promise.all([
    invoke<WafxApp[]>("list_wafx_apps"),
    invoke<WafxCategory[]>("list_wafx_categories"),
  ]).then(([apps, categories]) => ({ apps, categories }));
}

export function ApplicationsPanel({
  s,
  pushToast,
}: {
  s: Strings;
  pushToast: (kind: Toast["kind"], message: string) => void;
}) {
  const [apps, setApps] = useState<WafxApp[]>([]);
  const [categories, setCategories] = useState<WafxCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [phase, setPhase] = useState<Record<string, Phase>>({});
  const [progress, setProgress] = useState<Record<string, WafxDownloadProgress>>({});
  const [failure, setFailure] = useState<Record<string, string>>({});
  const [luaTools, setLuaTools] = useState<LuaToolsReport | null>(null);
  const [luaToolsBusy, setLuaToolsBusy] = useState(false);

  /**
   * Asks Rust what is on the machine.
   *
   * The command takes no arguments and returns a report; nothing here names a
   * path, because nothing here can. A failure leaves the report null and the
   * card draws its own unavailable state rather than pretending LuaTools is
   * installed.
   */
  const readLuaTools = useCallback(async () => {
    try {
      setLuaTools(await invoke<LuaToolsReport>("luatools_status"));
    } catch {
      setLuaTools(null);
    }
  }, []);

  /**
   * Starts LuaTools and reports what Rust decided.
   *
   * Rust has already finished by the time this resolves: it spawns and returns,
   * never waits, so the panel is not blocked while LuaTools is open.
   */
  const launchLuaTools = useCallback(async () => {
    setLuaToolsBusy(true);
    try {
      const report = await invoke<LuaToolsReport>("launch_luatools");
      setLuaTools(report);
      if (report.status === "launched") {
        pushToast("success", `${s.applications.luaToolsStarting}`);
      } else if (report.status === "runtime_missing") {
        pushToast("error", s.applications.luaToolsRuntimeMissing);
      } else if (report.status === "not_installed") {
        pushToast("error", s.applications.luaToolsNotInstalled);
      } else {
        pushToast("error", s.applications.luaToolsFailed);
      }
    } catch {
      pushToast("error", s.applications.luaToolsFailed);
    } finally {
      setLuaToolsBusy(false);
    }
  }, [pushToast, s.applications]);

  const applyCatalog = useCallback((catalog: Catalog) => {
    setApps(catalog.apps);
    setCategories(catalog.categories);
    setLoadError(null);
  }, []);

  /**
   * Reads the catalog, from a click. Used by the retry button in the error
   * view; the initial load goes through the effect below.
   */
  const load = useCallback(async () => {
    try {
      applyCatalog(await readCatalog());
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [applyCatalog]);

  // Mount only. The panel is unmounted whenever the user leaves the
  // Applications section, so there is no stale catalog to reconcile on the way
  // back in. The setters sit in the promise callbacks rather than in the effect
  // body itself: a setter called synchronously here would cascade a render
  // before the section has anything to show.
  useEffect(() => {
    readCatalog()
      .then(applyCatalog, (error: unknown) => setLoadError(errorMessage(error)))
      .finally(() => setLoading(false));
    // Independent of the catalog: a machine can have no catalog reachable and
    // still have LuaTools, and a catalog failure must not blank this card.
    void readLuaTools();
  }, [applyCatalog, readLuaTools]);

  useEffect(() => {
    let cancelled = false;
    const subs: Array<Promise<() => void>> = [];

    subs.push(
      listen<WafxDownloadProgress>("wafx-download-progress", (event) => {
        if (cancelled) return;
        const { app_id: id } = event.payload;
        setProgress((current) => ({ ...current, [id]: event.payload }));
      }),
    );
    subs.push(
      listen<WafxInstallPhaseEvent>("wafx-install-phase", (event) => {
        if (cancelled) return;
        const { app_id: id, phase: step } = event.payload;
        setPhase((current) => (current[id] === "done" ? current : { ...current, [id]: step }));
      }),
    );

    return () => {
      cancelled = true;
      for (const pending of subs) void pending.then((off) => off()).catch(() => {});
    };
  }, []);

  async function install(app: WafxApp) {
    const version = app.versions[0];
    if (!version) return;

    setPhase((current) => ({ ...current, [app.id]: "download" }));
    setProgress((current) => {
      const next = { ...current };
      delete next[app.id];
      return next;
    });
    setFailure((current) => {
      const next = { ...current };
      delete next[app.id];
      return next;
    });

    try {
      const outcome = await invoke<WafxInstallResult>("install_wafx_app", {
        appId: app.id,
        versionId: version.id,
      });
      if (outcome.success) {
        setPhase((current) => ({ ...current, [app.id]: "done" }));
        pushToast("success", `${app.name} — ${s.applications.installed}`);
      } else {
        // The installer ran and declined: an exit code is the whole story here,
        // and the app's own UI has usually already explained why.
        const reason = `exit ${outcome.exit_code ?? "?"}`;
        setPhase((current) => ({ ...current, [app.id]: "failed" }));
        setFailure((current) => ({ ...current, [app.id]: reason }));
        pushToast("error", `${app.name} — ${reason}`);
      }
    } catch (error) {
      const reason = errorMessage(error);
      setPhase((current) => ({ ...current, [app.id]: "failed" }));
      setFailure((current) => ({ ...current, [app.id]: reason }));
      pushToast("error", `${app.name} — ${reason}`);
    } finally {
      setProgress((current) => {
        const next = { ...current };
        delete next[app.id];
        return next;
      });
    }
  }

  const visible = useMemo(
    () => (activeCategory ? apps.filter((app) => app.category_id === activeCategory) : apps),
    [apps, activeCategory],
  );

  /**
   * Whether the LuaTools card belongs in the grid right now.
   *
   * LuaTools is not a catalog entry: it has no category, and Daltoon X neither
   * publishes nor installs it. Showing it under a category chip would put a
   * launcher inside a filter about apps the catalog knows about, so it appears
   * only in the unfiltered view.
   */
  const showLuaTools = activeCategory === null;

  if (loading) {
    return <p className="type-note">{s.applications.loading}</p>;
  }

  if (loadError) {
    return (
      <div role="alert" className="rounded-2xl border border-line bg-surface-1 p-4">
        <p className="text-sm text-ink-3">{s.applications.loadFailed}</p>
        <p className="type-note mt-1">{loadError}</p>
        <button
          type="button"
          onClick={() => {
            setRetrying(true);
            void load().finally(() => setRetrying(false));
          }}
          disabled={retrying}
          className="mt-3 rounded-xl border border-line bg-accent-soft px-4 py-2 text-sm font-semibold text-accent transition hover:brightness-110 disabled:opacity-60"
        >
          {retrying ? s.applications.loading : s.applications.retry}
        </button>
      </div>
    );
  }

  return (
    <div>
      {categories.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          <CategoryChip
            label={s.applications.allCategories}
            active={activeCategory === null}
            onClick={() => setActiveCategory(null)}
          />
          {categories.map((category) => (
            <CategoryChip
              key={category.id}
              label={category.name}
              active={activeCategory === category.id}
              onClick={() => setActiveCategory(activeCategory === category.id ? null : category.id)}
            />
          ))}
        </div>
      )}

      {visible.length === 0 && !showLuaTools ? (
        <p className="type-note">{s.applications.empty}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {showLuaTools && (
            <LuaToolsCard
              s={s}
              report={luaTools}
              busy={luaToolsBusy}
              onLaunch={() => void launchLuaTools()}
              onRefresh={() => void readLuaTools()}
            />
          )}
          {visible.map((app) => (
            <AppCard
              key={app.id}
              s={s}
              app={app}
              phase={phase[app.id]}
              progress={progress[app.id]}
              failure={failure[app.id]}
              onInstall={() => void install(app)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
        active
          ? "border-accent bg-accent-soft text-accent"
          : "border-line bg-surface-1 text-ink-3 hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * One catalog entry.
 *
 * The icon is the `data:` URL Rust already fetched and checked; when the
 * catalog has no icon, or the bytes turn out not to decode, the card draws the
 * same glyph the rest of the app uses for an unidentified category rather
 * than inventing a per-app mark.
 */
function AppCard({
  s,
  app,
  phase,
  progress,
  failure,
  onInstall,
}: {
  s: Strings;
  app: WafxApp;
  phase: Phase | undefined;
  progress: WafxDownloadProgress | undefined;
  failure: string | undefined;
  onInstall: () => void;
}) {
  const version = app.versions[0];
  const busy = phase === "download" || phase === "verify" || phase === "install";
  const percent = progress?.percent ?? null;
  // Rust only forwards a data URL it has already fetched and checked, so a
  // decode failure here means the bytes are malformed. Falling back to the
  // glyph is the right answer either way: an unreadable icon must not take the
  // app's name off the card.
  const [iconBroken, setIconBroken] = useState(false);
  const icon = app.icon_data && !iconBroken ? app.icon_data : null;

  return (
    <section className="flex flex-col rounded-2xl border border-line bg-surface-1 p-4">
      <div className="flex items-start gap-3">
        {icon ? (
          <img
            src={icon}
            alt=""
            className="h-10 w-10 shrink-0 rounded-xl object-contain"
            onError={() => setIconBroken(true)}
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-3"
          >
            <AppsIcon className="h-5 w-5" />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-ink">{app.name}</h3>
          {app.publisher && <p className="type-note truncate">{app.publisher}</p>}
        </div>
      </div>

      {app.description && (
        <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-ink-3">{app.description}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-3">
        {version ? (
          <span className="rounded-lg border border-line bg-surface-2 px-2 py-1">
            {format(s.applications.version, { version: version.version })}
          </span>
        ) : (
          <span className="rounded-lg border border-line bg-surface-2 px-2 py-1">
            {s.applications.noVersion}
          </span>
        )}
        {version?.installer_size_bytes != null && (
          <span>{formatBytes(version.installer_size_bytes)}</span>
        )}
      </div>

      <div className="mt-auto pt-3">
        {busy ? (
          <div>
            <div
              role="progressbar"
              aria-valuenow={percent ?? undefined}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${percent ?? 100}%` }}
              />
            </div>
            <p className="type-note mt-1.5">
              {phase === "verify" || phase === "install"
                ? phase === "verify"
                  ? s.applications.verifying
                  : s.applications.installing
                : percent != null
                  ? format(s.applications.downloading, { percent: `${percent}%` })
                  : formatBytes(progress?.downloaded ?? 0)}
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={onInstall}
            disabled={!version}
            className="w-full rounded-xl border border-line bg-accent-soft px-4 py-2 text-sm font-semibold text-accent transition hover:brightness-110 disabled:opacity-60"
          >
            {phase === "done" ? s.applications.installed : s.applications.install}
          </button>
        )}

        {failure && (
          <p role="alert" className="type-note mt-2 text-danger">
            {failure}
          </p>
        )}
      </div>
    </section>
  );
}

/** Rust returns a plain string for every command failure. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The LuaTools launcher.
 *
 * Shaped like {@link AppCard} so it sits in the same grid without a second
 * card style, and deliberately unlike it in one respect: there is no version
 * chip and no progress bar, because Daltoon X does not distribute LuaTools and
 * has no download or install phase to report. The only thing this card can do
 * is start a program the user already has.
 *
 * The three states it draws come straight from Rust's discriminant. The card
 * never inspects `detail`, so the reasons Rust records for its own audit trail
 * stay invisible here and can be reworded without touching this component.
 */
function LuaToolsCard({
  s,
  report,
  busy,
  onLaunch,
  onRefresh,
}: {
  s: Strings;
  report: LuaToolsReport | null;
  busy: boolean;
  onLaunch: () => void;
  onRefresh: () => void;
}) {
  const app = s.applications;
  // Null means the status read failed, which is not the same as "not
  // installed" -- so the card says it could not tell, and offers a retry,
  // rather than telling the user to install something that may be there.
  const status = report?.status ?? null;
  const canLaunch = status !== null && luaToolsCanLaunch(status);

  // Only shown when Rust supplied it, so this side never invents an address.
  const officialPage = report?.official_page ?? null;

  const officialLink = officialPage ? (
    <a
      href={officialPage}
      target="_blank"
      rel="noreferrer noopener"
      className="type-note mt-2 inline-block underline"
    >
      {app.luaToolsOfficialPage}
    </a>
  ) : null;

  return (
    <section className="flex flex-col rounded-2xl border border-line bg-surface-1 p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-3"
        >
          <AppsIcon className="h-5 w-5" />
        </span>

        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-ink">{LUA_TOOLS_LABEL}</h3>
        </div>
      </div>

      <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-ink-3">
        {app.luaToolsDescription}
      </p>

      <div className="mt-auto pt-3">
        {status === null ? (
          // Could not read the machine. Not the same as absent, so no install
          // advice and no launch button -- just a way to ask again.
          <button
            type="button"
            onClick={onRefresh}
            className="w-full rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink-3 transition hover:brightness-110"
          >
            {app.retry}
          </button>
        ) : canLaunch ? (
          <button
            type="button"
            onClick={onLaunch}
            disabled={busy}
            className="w-full rounded-xl border border-line bg-accent-soft px-4 py-2 text-sm font-semibold text-accent transition hover:brightness-110 disabled:opacity-60"
          >
            {app.luaToolsOpen}
          </button>
        ) : status === "runtime_missing" ? (
          // LuaTools *is* installed here, so this must not claim otherwise. The
          // instruction is the message, and Daltoon X offers no install button:
          // putting a runtime in place is a deliberate act, not a launcher job.
          <div>
            <p role="status" className="text-sm text-danger">
              {app.luaToolsRuntimeMissing}
            </p>
            {officialLink}
          </div>
        ) : (
          <div>
            <p role="status" className="type-note">
              {app.luaToolsNotInstalled}
            </p>
            {officialLink}
          </div>
        )}
      </div>
    </section>
  );
}
