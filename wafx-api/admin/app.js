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
  /** Accounts on the current page of the list. A cache, never the authority. */
  accounts: [],
  /** Server-side paging window. `limit` mirrors the API default. */
  accountsOffset: 0,
  accountsLimit: 50,
  /** Exact address to filter by, or "" for the whole list. */
  accountsFilter: "",
  /**
   * Whether another page may exist after the one just read.
   *
   * The API returns `count` as the length of the page it just served, not the
   * length of the table, so the total is genuinely unknowable from this
   * response. A full page is the only evidence there is more.
   */
  accountsMore: false,
  /** The account an open editor is acting on, or null. */
  account: null,
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

/**
 * One API call.
 *
 * `anonymous` marks the sign-in attempt itself. It exists so that a 401 can be
 * treated as "the session is gone" everywhere else without also firing on a
 * mistyped password, which is a 401 too and must stay on the form as a form error
 * rather than tearing the page down.
 */
async function call(path, { method = "GET", body, mutate = false, anonymous = false } = {}) {
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
    const error = new Error(describeError(payload, `فشل الطلب (${response.status})`));
    error.status = response.status;
    error.payload = payload;
    // A 401 means the session is gone or was never valid. Drop back to the
    // sign-in view immediately rather than leaving administrative content on
    // screen with buttons that can only fail: the cookie is HttpOnly, so the
    // page cannot tell it expired except by being told, and this is that answer.
    if (response.status === 401 && !anonymous) sessionExpired();
    throw error;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const VIEWS = ["categories", "apps", "accounts", "releases", "audit"];

function setView(name) {
  if (!VIEWS.includes(name)) name = "categories";
  state.view = name;
  for (const view of VIEWS) show($(`view-${view}`), view === name);
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.view === name);
  }
  if (name === "categories") void loadCategories();
  if (name === "apps") void loadApps();
  // Re-read rather than redisplaying what is already on screen, so a grant
  // revoked or an account disabled in another tab is noticed on return.
  if (name === "accounts") void loadAccounts();
  if (name === "releases") void loadReleases();
  if (name === "audit") void loadAudit();
}

/**
 * The only gate between an unauthenticated visitor and the whole panel.
 *
 * Everything administrative is inside `#topbar` or a `view-*` section, and all of
 * those are `hidden` in the markup as well as here - so the login form is the only
 * thing that can be on screen before a session exists, including during the one
 * round trip `/api/admin/me` takes to find out.
 */
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
  // Everything on screen belonged to the session that has just ended. Leaving it
  // visible would put one operator's read-only view in front of the next, so the
  // cached lists are dropped rather than merely hidden.
  state.account = null;
  state.accounts = [];
  state.accountsFilter = "";
  state.accountsOffset = 0;
  state.accountsMore = false;
  show($("topbar"), false);
  for (const view of VIEWS) show($(`view-${view}`), false);
  show($("view-login"), true);
  show($("versions-editor"), false);
  for (const editor of ["grant-editor", "revoke-editor", "disable-editor"]) show($(editor), false);
  $("accounts-table").querySelector("tbody").replaceChildren();
  show($("accounts-pager"), false);
  show($("accounts-loading"), false);
}

/** A 401 anywhere but the sign-in form: the session died under us. */
function sessionExpired() {
  if (state.admin === null) {
    // Already signed out - which is what `/api/admin/me` returning 401 on load
    // means. Nothing to announce, because nobody was ever shown anything.
    signedOut();
    return;
  }
  signedOut();
  setError("login-error", "انتهت جلسة الإدارة. يرجى تسجيل الدخول مرة أخرى.");
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
    // `append` returns undefined, so the class goes on the row itself. Written
    // the way `loadApps` does it: chaining `.firstChild` off `append` throws a
    // TypeError the moment the category list is empty.
    const row = el("tr", "لا توجد فئات بعد");
    row.classList.add("empty");
    tbody.append(row);
    return;
  }

  for (const category of state.categories) {
    const row = el("tr");
    row.append(el("td", category.id));
    row.append(el("td", category.name));
    row.append(el("td", category.sort_order));
    row.append(el("td", `${category.published_app_count} / ${category.app_count}`));
    row.append(actionCell([
      { label: "تعديل", run: () => openCategoryEditor(category) },
      {
        label: "حذف",
        danger: true,
        run: async () => {
          if (!confirm(`حذف الفئة "${category.name}"؟ ستصبح التطبيقات داخلها بدون فئة.`)) return;
          await call(`/api/admin/categories/${encodeURIComponent(category.id)}`, {
            method: "DELETE",
            mutate: true,
          });
          toast("تم حذف الفئة");
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
    $("category-editor-title").textContent = `تعديل ${existing.id}`;
    $("category-id").value = existing.id;
    $("category-id").readOnly = true;
    $("category-name").value = existing.name;
    $("category-sort").value = existing.sort_order;
  } else {
    $("category-editor-title").textContent = "فئة جديدة";
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
    const row = el("tr", "لا توجد تطبيقات بعد");
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
    row.append(el("td", app.featured ? "نعم" : ""));
    row.append(el("td", app.published ? "نعم" : ""));
    row.append(actionCell([
      { label: "الإصدارات", run: () => void openVersions(app.id) },
      { label: "تعديل", run: () => openAppEditor(app) },
      {
        label: "حذف",
        danger: true,
        run: async () => {
          if (!confirm(`حذف التطبيق "${app.name}" وكل إصداراته؟`)) return;
          await call(`/api/admin/apps/${encodeURIComponent(app.id)}`, { method: "DELETE", mutate: true });
          toast("تم حذف التطبيق");
          await loadApps();
        },
      },
    ]));
    tbody.append(row);
  }
}

function fillCategorySelect(selected) {
  const select = $("app-category");
  select.replaceChildren(el("option", "بدون", { value: "" }));
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
    $("app-editor-title").textContent = `تعديل ${existing.id}`;
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
    $("app-editor-title").textContent = "تطبيق جديد";
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
  $("versions-for").textContent = `للتطبيق ${appId}`;
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
    const row = el("tr", "لا توجد إصدارات بعد");
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
    row.append(el("td", version.published ? "نعم" : ""));
    row.append(el("td", version.release_date ?? ""));
    row.append(actionCell([
      {
        label: version.published ? "إلغاء النشر" : "نشر",
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
        label: "حذف",
        danger: true,
        run: async () => {
          if (!confirm(`حذف الإصدار ${version.version}؟`)) return;
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
// Accounts
// ---------------------------------------------------------------------------

/**
 * What the panel is allowed to say about an account, and where it says it from.
 *
 * `grant` is present whenever the account holds an *unrevoked* grant, which is
 * not the same as a grant that still entitles anybody to Pro: an expiry that has
 * already passed leaves the row in place, because `pro_grants_one_live` is
 * unique over `(account_id) WHERE revoked_at IS NULL` and nothing expires a row
 * out from under that index. So "expired" is decided here, from the timestamp,
 * rather than inferred from the presence of a grant. Getting that backwards
 * would report a lapsed paid account as entitled.
 */
function grantStatus(account) {
  if (account.grant === null) return { label: "لا يوجد Pro", kind: "" };
  if (account.grant.expires_at !== null && Date.parse(account.grant.expires_at) <= Date.now()) {
    return { label: "Pro منتهية", kind: "warn" };
  }
  return { label: "Pro فعّالة", kind: "ok" };
}

function badge(text, kind) {
  return el("span", text, { class: kind === "" ? "badge" : `badge ${kind}` });
}

/** A table cell whose text is an identifier, so it needs its own direction. */
function ltrCell(text) {
  return el("td", text, { class: "ltr" });
}

/**
 * The actions offered for one account, and the conditions on them.
 *
 * Grant appears only when there is no unrevoked grant to conflict with: offered
 * otherwise it could only ever draw a 409 from `pro_grants_one_live`. Revoke
 * appears whenever an unrevoked grant exists, including one whose expiry has
 * passed - that row still occupies the live slot, so it is still the thing that
 * has to be revoked. Enable appears only for a disabled account.
 */
function accountActionsCell(account) {
  const cell = el("td");
  cell.className = "actions";

  if (account.grant === null) {
    cell.append(actionButton({ label: "منح Pro", variant: "primary", run: () => openGrantEditor(account) }));
  } else {
    cell.append(actionButton({ label: "سحب Pro", danger: true, run: () => openRevokeEditor(account) }));
  }

  if (account.disabled) {
    cell.append(actionButton({ label: "تفعيل", variant: "ghost", run: () => actOn(account, enableAccount) }));
  } else {
    cell.append(actionButton({ label: "تعطيل", danger: true, run: () => openDisableEditor(account) }));
  }

  return cell;
}

/**
 * Draws one page of accounts.
 *
 * Only the six fields the API selects are rendered. It does not read
 * `password_hash`, `password_salt` or `iterations` at all, so there is nothing
 * here to redact - which is a stronger position than filtering a wider response
 * and hoping the filter keeps up.
 */
function renderAccounts(rows) {
  const tbody = $("accounts-table").querySelector("tbody");
  tbody.replaceChildren();

  if (rows.length === 0) {
    const row = el(
      "tr",
      state.accountsFilter === "" ? "لا توجد حسابات بعد" : "لا يوجد حساب بهذا البريد الإلكتروني",
    );
    row.classList.add("empty");
    tbody.append(row);
  }

  for (const account of rows) {
    const row = el("tr");

    row.append(ltrCell(account.email));

    const status = el("td");
    status.append(badge(account.disabled ? "معطّل" : "مفعّل", account.disabled ? "danger" : "ok"));
    row.append(status);

    const pro = el("td");
    pro.append(badge(grantStatus(account).label, grantStatus(account).kind));
    row.append(pro);

    row.append(account.grant === null ? el("td", "-") : ltrCell(account.grant.plan));
    row.append(ltrCell(account.created_at));
    row.append(
      account.last_login_at === null ? el("td", "لم يسجّل الدخول بعد") : ltrCell(account.last_login_at),
    );
    row.append(accountActionsCell(account));

    tbody.append(row);
  }

  // Paging. `next` is enabled only on a full page, which is the sole evidence the
  // API contract gives that more rows exist.
  const first = rows.length === 0 ? 0 : state.accountsOffset + 1;
  const last = state.accountsOffset + rows.length;
  $("accounts-prev").disabled = state.accountsOffset === 0;
  $("accounts-next").disabled = !state.accountsMore;
  $("accounts-page").textContent = rows.length === 0 ? "" : `${first}–${last}`;
  show($("accounts-pager"), rows.length > 0 || state.accountsOffset > 0);
}

/**
 * Fetches the current page of accounts.
 *
 * Never throws: every caller uses it to reconcile after a mutation or a tab
 * switch, and an exception here would replace the real error with a secondary
 * one. A failed read therefore leaves the table empty and puts the reason in
 * `account-error`, rather than showing rows nobody can vouch for.
 */
async function loadAccounts() {
  show($("accounts-loading"), true);
  setError("account-error", null);
  try {
    const params = new URLSearchParams({
      limit: String(state.accountsLimit),
      offset: String(state.accountsOffset),
    });
    if (state.accountsFilter !== "") params.set("email", state.accountsFilter);

    const data = await call(`/api/admin/accounts?${params.toString()}`);
    const rows = Array.isArray(data.accounts) ? data.accounts : [];
    state.accounts = rows;
    state.accountsMore = rows.length >= state.accountsLimit;
    renderAccounts(rows);
  } catch (error) {
    state.accounts = [];
    state.accountsMore = false;
    renderAccounts([]);
    // A 401 has already been turned into the sign-in view by `call`; saying so
    // again here would put an error on a page the operator has just been moved
    // off, and on the login form it is already carrying the real message.
    if (error.status !== 401) setError("account-error", accountFailure(error));
  } finally {
    show($("accounts-loading"), false);
  }
}

/**
 * Turns a failed request into something an operator can act on.
 *
 * The status decides the sentence, because the API's own message is written in
 * English for the caller that made the request and does not say what to do next.
 * 422 and the unmapped default keep the API's message verbatim: it names the
 * rejected field, which is the entire value of that status, and a field name is
 * not prose to be translated.
 */
function accountFailure(error) {
  if (error.status === 401) return "انتهت جلسة الإدارة. يرجى تسجيل الدخول مرة أخرى.";
  if (error.status === 403) return "رفض الـ API هذا الطلب. التعديلات تتطلب جلسة إدارة مسجَّلة من هذه الصفحة.";
  if (error.status === 404) return "الحساب غير موجود.";
  if (error.status === 409) return "هذا الحساب يملك منحة Pro فعّالة بالفعل. اسحبها قبل منح منحة جديدة.";
  if (error.status === 429) return "طلبات كثيرة جدًا. انتظر قليلًا ثم أعد المحاولة.";
  if (error.status >= 500) return `فشل الخادم (${error.status}). حدّث القائمة لمعرفة ما طُبِّق فعليًا.`;
  return error.message;
}

/**
 * Sends one mutation, then re-reads the list whatever the outcome.
 *
 * `finally` rather than the success path on purpose: after a 5xx the request may
 * still have been applied, and a panel reporting the old state would then be
 * confidently wrong. Nothing is retried here or anywhere else - a retried grant
 * is a second grant, and the database is right to refuse it.
 */
async function mutateAccount(path, { method = "POST", body }) {
  try {
    return await call(path, { method, mutate: true, body });
  } finally {
    await loadAccounts();
  }
}

/** Points the open editors at a row, then runs an action against that row. */
function actOn(account, run) {
  state.account = account;
  return run();
}

// --- Grant -----------------------------------------------------------------

/**
 * `datetime-local` yields `YYYY-MM-DDTHH:MM` with no zone and no seconds, and
 * the API accepts only whole seconds with an explicit `Z`. The value is read as
 * UTC, which is what the field's label says it is and the only reading that does
 * not silently shift an expiry by the operator's own offset.
 */
function expiryToIso(local) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/.exec(local);
  return match === null ? null : `${match[1]}:00Z`;
}

/** Default expiry: 24 hours out, in the `datetime-local` shape, already UTC. */
function defaultExpiry() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

function openGrantEditor(account) {
  state.account = account;
  setError("grant-error", null);
  $("grant-for").textContent = account.email;
  $("grant-plan").value = "pro";
  $("grant-perpetual").checked = false;
  $("grant-expires").value = defaultExpiry();
  $("grant-expires").disabled = false;
  $("grant-expires").required = true;
  show($("grant-expiry-field"), true);
  show($("grant-editor"), true);
}

// --- Revoke ----------------------------------------------------------------

function openRevokeEditor(account) {
  state.account = account;
  setError("revoke-error", null);
  $("revoke-for").textContent = account.email;
  $("revoke-reason").value = "";
  show($("revoke-editor"), true);
}

// --- Disable ---------------------------------------------------------------

function openDisableEditor(account) {
  state.account = account;
  setError("disable-error", null);
  $("disable-for").textContent = account.email;
  $("disable-ack").checked = false;
  show($("disable-editor"), true);
}

/**
 * Both of these send an empty object, which is the whole body the API accepts:
 * its field allowlist for these two routes is empty, so any key at all - even a
 * harmless-looking one - is a 422. Sending `{}` rather than no body is
 * deliberate, because the route reads a JSON object.
 */
async function disableAccount() {
  await mutateAccount(`/api/admin/accounts/${encodeURIComponent(state.account.id)}/disable`, {
    method: "POST",
    body: {},
  });
  toast("تم تعطيل الحساب");
}

async function enableAccount() {
  await mutateAccount(`/api/admin/accounts/${encodeURIComponent(state.account.id)}/enable`, {
    method: "POST",
    body: {},
  });
  toast("تم تفعيل الحساب");
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

async function loadReleases() {
  const tbody = $("releases-table").querySelector("tbody");
  tbody.replaceChildren();
  const data = await call("/api/admin/releases");

  if (data.releases.length === 0) {
    const row = el("tr", "لا توجد إصدارات مسجَّلة");
    row.classList.add("empty");
    tbody.append(row);
    return;
  }

  for (const release of data.releases) {
    const row = el("tr");
    row.append(el("td", release.version));
    row.append(el("td", release.channel));
    row.append(el("td", release.published ? "نعم" : ""));
    row.append(el("td", release.release_date ?? ""));
    row.append(el("td", release.installer_sha256 ? `${release.installer_sha256.slice(0, 12)}...` : "-"));
    row.append(el("td", release.notes.slice(0, 80)));
    row.append(actionCell([
      { label: "تعديل", run: () => openReleaseEditor(release) },
      {
        label: release.published ? "إلغاء النشر" : "نشر",
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
        label: "حذف",
        danger: true,
        run: async () => {
          if (!confirm(`حذف الإصدار ${release.version}؟`)) return;
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
    $("release-editor-title").textContent = `تعديل ${existing.version}`;
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
    $("release-editor-title").textContent = "إصدار جديد";
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
    const row = el("tr", "لا يوجد شيء مسجَّل بعد");
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

/**
 * One action button, with the panel's shared behaviour: disabled for the
 * duration of the call so a slow mutation cannot be fired twice, and any thrown
 * error surfaced as a toast rather than swallowed.
 *
 * `variant` picks a real button style for actions that are the point of a view
 * rather than one of several links in a row; without it the small `link` styling
 * the data grids use applies.
 */
function actionButton(action) {
  const button = el("button", action.label, { type: "button" });
  button.className = action.variant ?? (action.danger ? "link danger" : "link");
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
  return button;
}

function actionCell(actions) {
  const cell = el("td");
  cell.className = "actions";
  for (const action of actions) {
    cell.append(actionButton(action));
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
  button.textContent = "جارٍ تسجيل الدخول...";
  try {
    const username = $("login-username").value.trim();
    const password = $("login-password").value;

    // The salt and iteration count come from the API, so a figure raised later
    // is honoured without a change to this file.
    const params = await call(
      `/api/admin/auth/params?username=${encodeURIComponent(username)}`,
      { anonymous: true },
    );
    const verifier = await deriveVerifier(password, params.salt, params.iterations);

    const result = await call("/api/admin/login", {
      method: "POST",
      mutate: true,
      anonymous: true,
      body: { username, verifier },
    });
    $("login-password").value = "";
    signedIn(result.admin);
  } catch (error) {
    setError("login-error", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "تسجيل الدخول";
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
    toast("تم حفظ الفئة");
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
    toast("تم حفظ التطبيق");
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
    toast("تمت إضافة الإصدار");
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
    toast("تم حفظ الإصدار");
    await loadReleases();
  } catch (error) {
    setError("release-error", error.message);
  }
});

$("new-category").addEventListener("click", () => openCategoryEditor(null));
$("new-app").addEventListener("click", () => openAppEditor(null));
$("new-release").addEventListener("click", () => openReleaseEditor(null));
$("reload-audit").addEventListener("click", () => void loadAudit());

// --- Accounts --------------------------------------------------------------

$("account-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("account-error", null);
  const button = $("account-search-submit");

  button.disabled = true;
  button.textContent = "جارٍ البحث...";
  try {
    // An empty box means "no filter", not "match nothing": the field is optional
    // so the list can be re-read without clearing it first. A filter replaces
    // the list rather than narrowing what is on screen, and paging restarts at
    // the first row - page 4 of an unfiltered list has no meaning under one.
    state.accountsFilter = $("account-email").value.trim();
    state.accountsOffset = 0;
    state.account = null;
    await loadAccounts();
  } finally {
    button.disabled = false;
    button.textContent = "بحث";
  }
});

$("account-search-clear").addEventListener("click", () => {
  $("account-email").value = "";
  state.accountsFilter = "";
  state.accountsOffset = 0;
  state.account = null;
  void loadAccounts();
});

$("reload-account").addEventListener("click", () => void loadAccounts());

$("accounts-prev").addEventListener("click", () => {
  state.accountsOffset = Math.max(0, state.accountsOffset - state.accountsLimit);
  void loadAccounts();
});

$("accounts-next").addEventListener("click", () => {
  state.accountsOffset += state.accountsLimit;
  void loadAccounts();
});

$("grant-perpetual").addEventListener("change", () => {
  const perpetual = $("grant-perpetual").checked;
  show($("grant-expiry-field"), !perpetual);
  // Disabled rather than merely hidden: a hidden-but-enabled field is still
  // validated, so ticking Perpetual would be refused by the browser for a date
  // the operator never meant to give. A disabled field is also dropped from the
  // form's own payload, which is why the body below is built by hand either way.
  $("grant-expires").disabled = perpetual;
  // Kept in step, so the two attributes cannot disagree: `required` is what makes
  // the browser block an empty date, and `disabled` is what exempts a perpetual
  // grant from needing one.
  $("grant-expires").required = !perpetual;
});

$("grant-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const account = state.account;
  if (account === null) return;
  setError("grant-error", null);

  const perpetual = $("grant-perpetual").checked;
  const expiresAt = perpetual ? null : expiryToIso($("grant-expires").value);
  if (!perpetual && expiresAt === null) {
    setError("grant-error", "اختر تاريخ انتهاء، أو فعّل خيار الدائم.");
    return;
  }
  if (!confirm(`منح ${$("grant-plan").value} إلى ${account.email}؟`)) return;

  try {
    await mutateAccount(`/api/admin/accounts/${encodeURIComponent(account.id)}/pro`, {
      method: "POST",
      // Exactly the two fields the route's allowlist names, always both present.
      body: { plan: $("grant-plan").value, expires_at: expiresAt },
    });
    show($("grant-editor"), false);
    toast("تم منح Pro");
  } catch (error) {
    setError("grant-error", accountFailure(error));
  }
});

$("revoke-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const account = state.account;
  if (account === null) return;
  setError("revoke-error", null);

  const reason = $("revoke-reason").value.trim();
  if (reason === "") {
    setError("revoke-error", "السبب مطلوب ويُسجَّل في سجل التدقيق.");
    return;
  }
  if (!confirm(`سحب Pro من ${account.email}؟ سيفقد ميزة Pro عند تحديثه التالي.`)) return;

  try {
    await mutateAccount(`/api/admin/accounts/${encodeURIComponent(account.id)}/pro`, {
      method: "DELETE",
      body: { revoke_reason: reason },
    });
    show($("revoke-editor"), false);
    toast("تم سحب Pro");
  } catch (error) {
    setError("revoke-error", accountFailure(error));
  }
});

$("disable-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const account = state.account;
  if (account === null) return;
  setError("disable-error", null);

  if (!$("disable-ack").checked) {
    setError("disable-error", "أكّد أنك تفهم أن هذا يُنهي كل الجلسات النشطة.");
    return;
  }
  if (!confirm(`تعطيل ${account.email}؟ لن يتمكّن من تسجيل الدخول.`)) return;

  try {
    await disableAccount();
    show($("disable-editor"), false);
  } catch (error) {
    setError("disable-error", accountFailure(error));
  }
});

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
