/**
 * Admin panel.
 *
 * Two things in this file are load-bearing and worth reading before changing
 * either of them.
 *
 * 1. THE PASSWORD IS STRETCHED HERE, NOT ON THE SERVER.
 *    `deriveVerifier` runs PBKDF2-SHA256 at the iteration count the API reports.
 *    Cloudflare's runtime caps PBKDF2 at 100,000 iterations and the Workers Free
 *    plan allows 10 ms of CPU per request, which PBKDF2 exceeds by a wide
 *    margin, so the Worker's copy of this logic could not run at the OWASP
 *    figure. The browser has no such limit. The API stores only SHA-256 of the
 *    verifier this function returns.
 *
 * 2. DATABASE VALUES ARE WRITTEN WITH textContent, NEVER innerHTML.
 *    Every value shown here originates in D1. Assigning it as markup would turn
 *    a description or an app name into script execution inside the one page
 *    that can publish an installer. `el()` is the only way this file creates
 *    elements.
 */

const API = "";

/** Header that proves a mutating request came from this page, not a cross-site form. */
const ADMIN_HEADER = { "X-WAFI-Admin": "1" };

const state = {
  admin: null,
  view: "categories",
  categories: [],
  /** Application whose versions are on screen, or null. */
  selectedApp: null,
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Creates an element. `text` is assigned as text, so a value from the database
 * can never become markup.
 */
function el(tag, text, attrs) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      if (key === "class") node.className = value;
      else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    }
  }
  return node;
}

const $ = (id) => document.getElementById(id);

function show(node, visible) {
  if (node) node.hidden = !visible;
}

function setError(id, message) {
  const node = $(id);
  if (!node) return;
  node.textContent = message ?? "";
  show(node, Boolean(message));
}

/** Renders an API error's field map into one readable line. */
function describeError(payload, fallback) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = payload.error;
  if (!error) return fallback;
  const fields = error.fields;
  if (fields && typeof fields === "object") {
    const parts = Object.entries(fields).map(([key, message]) => `${key}: ${message}`);
    if (parts.length > 0) return `${error.message} (${parts.join("; ")})`;
  }
  return error.message ?? fallback;
}

let toastTimer;
function toast(message) {
  const node = $("toast");
  node.textContent = message;
  show(node, true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(node, false), 4000);
}

// ---------------------------------------------------------------------------
// Password derivation
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * PBKDF2-SHA256, returning 32 bytes as lowercase hex.
 *
 * `iterations` is whatever the API reported for this account rather than a
 * constant here, so raising the stored figure later takes effect without a
 * change to this file.
 */
async function deriveVerifier(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(bits);
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

async function call(path, { method = "GET", body, mutate = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (mutate) Object.assign(headers, ADMIN_HEADER);

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // The session cookie must ride along; it is HttpOnly so this is the only
    // way it travels.
    credentials: "same-origin",
  });

  const text = await response.text();
  let payload = null;
  if (text !== "") {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const error = new Error(describeError(payload, `Request failed (${response.status})`));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const VIEWS = ["categories", "apps", "releases", "audit"];

function setView(name) {
  if (!VIEWS.includes(name)) name = "categories";
  state.view = name;
  for (const view of VIEWS) show($(`view-${view}`), view === name);
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.view === name);
  }
  if (name === "categories") void loadCategories();
  if (name === "apps") void loadApps();
  if (name === "releases") void loadReleases();
  if (name === "audit") void loadAudit();
}

function signedIn(admin) {
  state.admin = admin;
  show($("view-login"), false);
  show($("topbar"), true);
  $("who").textContent = admin.username;
  setView(state.view);
}

function signedOut() {
  state.admin = null;
  state.selectedApp = null;
  show($("topbar"), false);
  for (const view of VIEWS) show($(`view-${view}`), false);
  show($("view-login"), true);
  show($("versions-editor"), false);
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

async function loadCategories() {
  const tbody = $("categories-table").querySelector("tbody");
  tbody.replaceChildren();
  const data = await call("/api/admin/categories");
  state.categories = data.categories ?? [];

  if (state.categories.length === 0) {
    tbody.append(el("tr", "No categories yet")).firstChild?.classList.add("empty");
    return;
  }

  for (const category of state.categories) {
    const row = el("tr");
    row.append(el("td", category.id));
    row.append(el("td", category.name));
    row.append(el("td", category.sort_order));
    row.append(el("td", `${category.published_app_count} / ${category.app_count}`));
    row.append(actionCell([
      { label: "Edit", run: () => openCategoryEditor(category) },
      {
        label: "Delete",
        danger: true,
        run: async () => {
          if (!confirm(`Delete "${category.name}"? Apps in it become uncategorised.`)) return;
          await call(`/api/admin/categories/${encodeURIComponent(category.id)}`, {
            method: "DELETE",
            mutate: true,
          });
          toast("Category deleted");
          await loadCategories();
        },
      },
    ]));
    tbody.append(row);
  }
}

function openCategoryEditor(existing) {
  const editor = $("category-editor");
  show(editor, true);
  setError("category-error", null);
  if (existing) {
    $("category-editor-title").textContent = `Edit ${existing.id}`;
    $("category-id").value = existing.id;
    $("category-id").readOnly = true;
    $("category-name").value = existing.name;
    $("category-sort").value = existing.sort_order;
  } else {
    $("category-editor-title").textContent = "New category";
    $("category-id").value = "";
    $("category-id").readOnly = false;
    $("category-name").value = "";
    $("category-sort").value = "0";
  }
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

async function loadApps() {
  const tbody = $("apps-table").querySelector("tbody");
  tbody.replaceChildren();
  const data = await call("/api/admin/apps");

  if (data.apps.length === 0) {
    const row = el("tr", "No applications yet");
    row.classList.add("empty");
    tbody.append(row);
    return;
  }

  for (const app of data.apps) {
    const row = el("tr");
    row.append(el("td", app.id));
    row.append(el("td", app.name));
    row.append(el("td", app.category_id ?? "-"));
    row.append(el("td", `${app.published_version_count} / ${app.version_count}`));
    row.append(el("td", app.featured ? "yes" : ""));
    row.append(el("td", app.published ? "yes" : ""));
    row.append(actionCell([
      { label: "Versions", run: () => void openVersions(app.id) },
      { label: "Edit", run: () => openAppEditor(app) },
      {
        label: "Delete",
        danger: true,
        run: async () => {
          if (!confirm(`Delete "${app.name}" and all of its versions?`)) return;
          await call(`/api/admin/apps/${encodeURIComponent(app.id)}`, { method: "DELETE", mutate: true });
          toast("Application deleted");
          await loadApps();
        },
      },
    ]));
    tbody.append(row);
  }
}

function fillCategorySelect(selected) {
  const select = $("app-category");
  select.replaceChildren(el("option", "None", { value: "" }));
  for (const category of state.categories) {
    const option = el("option", category.name, { value: category.id });
    if (category.id === selected) option.selected = true;
    select.append(option);
  }
}

function openAppEditor(existing) {
  // The category list is needed for the select even when editing an existing app.
  if (state.categories.length === 0) void loadCategories().then(() => fillCategorySelect(existing?.category_id));
  else fillCategorySelect(existing?.category_id);

  show($("app-editor"), true);
  setError("app-error", null);
  if (existing) {
    $("app-editor-title").textContent = `Edit ${existing.id}`;
    $("app-id").value = existing.id;
    $("app-id").readOnly = true;
    $("app-name").value = existing.name;
    $("app-publisher").value = existing.publisher;
    $("app-description").value = existing.description;
    $("app-icon-kind").value = existing.icon_kind === "r2" ? "external" : existing.icon_kind;
    $("app-icon-url").value = existing.icon_url ?? "";
    $("app-homepage").value = existing.homepage_url ?? "";
    $("app-position").value = existing.position;
    $("app-featured").checked = existing.featured;
    $("app-published").checked = existing.published;
  } else {
    $("app-editor-title").textContent = "New application";
    $("app-id").value = "";
    $("app-id").readOnly = false;
    $("app-name").value = "";
    $("app-publisher").value = "";
    $("app-description").value = "";
    $("app-icon-kind").value = "none";
    $("app-icon-url").value = "";
    $("app-homepage").value = "";
    $("app-position").value = "0";
    $("app-featured").checked = false;
    $("app-published").checked = false;
  }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

async function openVersions(appId) {
  state.selectedApp = appId;
  show($("versions-editor"), true);
  $("versions-for").textContent = `for ${appId}`;
  setError("version-error", null);
  await loadVersions();
}

async function loadVersions() {
  const appId = state.selectedApp;
  if (!appId) return;
  const tbody = $("versions-table").querySelector("tbody");
  tbody.replaceChildren();

  const data = await call(`/api/admin/apps/${encodeURIComponent(appId)}/versions`);
  if (data.versions.length === 0) {
    const row = el("tr", "No versions yet");
    row.classList.add("empty");
    tbody.append(row);
    return;
  }

  for (const version of data.versions) {
    const row = el("tr");
    row.append(el("td", version.version));
    row.append(el("td", version.installer_type));
    row.append(el("td", version.installer_mode));
    row.append(el("td", version.installer_sha256 ? `${version.installer_sha256.slice(0, 12)}...` : "-"));
    row.append(el("td", version.published ? "yes" : ""));
    row.append(el("td", version.release_date ?? ""));
    row.append(actionCell([
      {
        label: version.published ? "Unpublish" : "Publish",
        run: async () => {
          await call(`/api/admin/versions/${encodeURIComponent(version.id)}`, {
            method: "PATCH",
            mutate: true,
            body: { published: !version.published },
          });
          await loadVersions();
        },
      },
      {
        label: "Delete",
        danger: true,
        run: async () => {
          if (!confirm(`Delete version ${version.version}?`)) return;
          await call(`/api/admin/versions/${encodeURIComponent(version.id)}`, {
            method: "DELETE",
            mutate: true,
          });
          await loadVersions();
        },
      },
    ]));
    tbody.append(row);
  }
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

async function loadReleases() {
  const tbody = $("releases-table").querySelector("tbody");
  tbody.replaceChildren();
  const data = await call("/api/admin/releases");

  if (data.releases.length === 0) {
    const row = el("tr", "No releases recorded");
    row.classList.add("empty");
    tbody.append(row);
    return;
  }

  for (const release of data.releases) {
    const row = el("tr");
    row.append(el("td", release.version));
    row.append(el("td", release.channel));
    row.append(el("td", release.published ? "yes" : ""));
    row.append(el("td", release.release_date ?? ""));
    row.append(el("td", release.installer_sha256 ? `${release.installer_sha256.slice(0, 12)}...` : "-"));
    row.append(el("td", release.notes.slice(0, 80)));
    row.append(actionCell([
      { label: "Edit", run: () => openReleaseEditor(release) },
      {
        label: release.published ? "Unpublish" : "Publish",
        run: async () => {
          await call(`/api/admin/releases/${encodeURIComponent(release.id)}`, {
            method: "PATCH",
            mutate: true,
            body: { published: !release.published },
          });
          await loadReleases();
        },
      },
      {
        label: "Delete",
        danger: true,
        run: async () => {
          if (!confirm(`Delete release ${release.version}?`)) return;
          await call(`/api/admin/releases/${encodeURIComponent(release.id)}`, {
            method: "DELETE",
            mutate: true,
          });
          await loadReleases();
        },
      },
    ]));
    tbody.append(row);
  }
}

function openReleaseEditor(existing) {
  show($("release-editor"), true);
  setError("release-error", null);
  // Set here rather than at the call sites, so "which release am I editing" is
  // answered by the function that decides the form's mode. The submit handler
  // reads it to choose PATCH vs POST.
  state.editingReleaseId = existing ? existing.id : null;
  if (existing) {
    $("release-editor-title").textContent = `Edit ${existing.version}`;
    $("release-version").value = existing.version;
    $("release-version").readOnly = true;
    $("release-channel").value = existing.channel;
    $("release-url").value = existing.installer_url;
    $("release-sha").value = existing.installer_sha256 ?? "";
    $("release-size").value = existing.installer_size_bytes ?? "";
    $("release-notes").value = existing.notes;
    $("release-date").value = existing.release_date ?? "";
    $("release-published").checked = existing.published;
  } else {
    $("release-editor-title").textContent = "New release";
    $("release-version").value = "";
    $("release-version").readOnly = false;
    $("release-channel").value = "stable";
    $("release-url").value = "";
    $("release-sha").value = "";
    $("release-size").value = "";
    $("release-notes").value = "";
    $("release-date").value = "";
    $("release-published").checked = false;
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

async function loadAudit() {
  const tbody = $("audit-table").querySelector("tbody");
  tbody.replaceChildren();
  const data = await call("/api/admin/audit?limit=200");
  if (data.entries.length === 0) {
    const row = el("tr", "Nothing recorded yet");
    row.classList.add("empty");
    tbody.append(row);
    return;
  }
  for (const entry of data.entries) {
    const row = el("tr");
    row.append(el("td", entry.at));
    row.append(el("td", entry.username ?? "-"));
    row.append(el("td", entry.action));
    row.append(el("td", entry.target ?? "-"));
    row.append(el("td", entry.ip ?? "-"));
    tbody.append(row);
  }
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function actionCell(actions) {
  const cell = el("td");
  cell.className = "actions";
  for (const action of actions) {
    const button = el("button", action.label, { type: "button" });
    if (action.danger) button.className = "link danger";
    else button.className = "link";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await action.run();
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
      }
    });
    cell.append(button);
  }
  return cell;
}

/** Sends only defined and non-empty values, so "absent" really means absent. */
function compact(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("login-error", null);
  const button = $("login-submit");
  button.disabled = true;
  button.textContent = "Signing in...";
  try {
    const username = $("login-username").value.trim();
    const password = $("login-password").value;

    // The salt and iteration count come from the API, so a figure raised later
    // is honoured without a change to this file.
    const params = await call(`/api/admin/auth/params?username=${encodeURIComponent(username)}`);
    const verifier = await deriveVerifier(password, params.salt, params.iterations);

    const result = await call("/api/admin/login", {
      method: "POST",
      mutate: true,
      body: { username, verifier },
    });
    $("login-password").value = "";
    signedIn(result.admin);
  } catch (error) {
    setError("login-error", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Sign in";
  }
});

$("signout").addEventListener("click", async () => {
  try {
    await call("/api/admin/logout", { method: "POST", mutate: true });
  } catch {
    // Signing out locally matters more than the round trip succeeding.
  }
  signedOut();
});

$("category-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("category-error", null);
  const id = $("category-id").value.trim().toLowerCase();
  const body = compact({ name: $("category-name").value.trim(), sort_order: Number($("category-sort").value) });
  try {
    if ($("category-id").readOnly) {
      await call(`/api/admin/categories/${encodeURIComponent(id)}`, { method: "PATCH", mutate: true, body });
    } else {
      await call("/api/admin/categories", { method: "POST", mutate: true, body: { id, ...body } });
    }
    show($("category-editor"), false);
    toast("Category saved");
    await loadCategories();
  } catch (error) {
    setError("category-error", error.message);
  }
});

$("app-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("app-error", null);
  const id = $("app-id").value.trim().toLowerCase();
  const body = {
    name: $("app-name").value.trim(),
    publisher: $("app-publisher").value.trim(),
    description: $("app-description").value.trim(),
    category_id: $("app-category").value || null,
    icon_kind: $("app-icon-kind").value,
    icon_url: $("app-icon-kind").value === "none" ? null : $("app-icon-url").value.trim(),
    homepage_url: $("app-homepage").value.trim(),
    position: Number($("app-position").value),
    featured: $("app-featured").checked,
    published: $("app-published").checked,
  };
  try {
    await call(`/api/admin/apps/${encodeURIComponent(id)}`, { method: "PUT", mutate: true, body });
    show($("app-editor"), false);
    toast("Application saved");
    await loadApps();
  } catch (error) {
    setError("app-error", error.message);
  }
});

$("version-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("version-error", null);
  const appId = state.selectedApp;
  if (!appId) return;
  const body = {
    version: $("version-number").value.trim(),
    installer_type: $("version-type").value,
    installer_mode: $("version-mode").value,
    // Only 'external' is offered: no R2 bucket exists, and the API refuses the
    // other value with an explanation rather than storing an unusable row.
    installer_url_kind: "external",
    installer_url: $("version-url").value.trim(),
    installer_sha256: $("version-sha").value.trim() || null,
    installer_size_bytes: $("version-size").value ? Number($("version-size").value) : null,
    release_date: $("version-date").value || null,
    published: $("version-published").checked,
  };
  try {
    await call(`/api/admin/apps/${encodeURIComponent(appId)}/versions`, {
      method: "POST",
      mutate: true,
      body,
    });
    $("version-form").reset();
    toast("Version added");
    await loadVersions();
  } catch (error) {
    setError("version-error", error.message);
  }
});

$("release-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("release-error", null);
  const body = compact({
    version: $("release-version").value.trim(),
    channel: $("release-channel").value,
    installer_url: $("release-url").value.trim(),
    installer_sha256: $("release-sha").value.trim(),
    installer_size_bytes: $("release-size").value ? Number($("release-size").value) : undefined,
    notes: $("release-notes").value.trim(),
    release_date: $("release-date").value || undefined,
    published: $("release-published").checked,
  });
  try {
    if ($("release-version").readOnly) {
      const id = state.editingReleaseId;
      await call(`/api/admin/releases/${encodeURIComponent(id)}`, { method: "PATCH", mutate: true, body });
    } else {
      await call("/api/admin/releases", { method: "POST", mutate: true, body });
    }
    show($("release-editor"), false);
    toast("Release saved");
    await loadReleases();
  } catch (error) {
    setError("release-error", error.message);
  }
});

$("new-category").addEventListener("click", () => openCategoryEditor(null));
$("new-app").addEventListener("click", () => openAppEditor(null));
$("new-release").addEventListener("click", () => openReleaseEditor(null));
$("reload-audit").addEventListener("click", () => void loadAudit());

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => setView(tab.dataset.view));
}

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => show($(button.dataset.close), false));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Ask the API who we are rather than assuming a signed-out state, so a refresh
 * does not look like a sign-out and a stale cookie is noticed immediately.
 */
(async function start() {
  try {
    const result = await call("/api/admin/me");
    signedIn(result.admin);
  } catch {
    signedOut();
  }
})();
