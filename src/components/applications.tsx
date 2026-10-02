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
 * The Wafi X catalog screen.
 *
 * Everything here is a read of what Rust fetched. The panel sends two
 * identifiers when the user presses Install — an app id and a version id — and
 * Rust resolves the download URL, the checksum and the installer mode itself.
 * Nothing the webview holds can change what gets launched, which is the same
 * reason the download never happens in here either.
 */
type Phase = "download" | "verify" | "install" | "done" | "failed";

type Catalog = { apps: WafxApp[]; categories: WafxCategory[] };

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
  }, [applyCatalog]);

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

      {visible.length === 0 ? (
        <p className="type-note">{s.applications.empty}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
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
