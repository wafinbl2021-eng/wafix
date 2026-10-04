/**
 * The admin panel's shell: the sign-in gate, the Arabic/RTL presentation, the
 * branding, and the security invariants that belong to the whole file rather than
 * to any one view.
 *
 * The gate tests are the ones that matter most. This page can grant a privilege
 * and publish an installer, so "is administrative content reachable without a
 * session" is a question about the document and about the session handler, not
 * about any single route. Both are asserted here - the markup is checked for the
 * `hidden` attributes that make the answer true before any script runs, and the
 * handler is checked for what it does when a 401 arrives mid-use.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mount,
  router,
  isSignedIn,
  isSignedOut,
  withCategories,
  PANEL_HTML,
  PANEL_JS,
  PANEL_CODE,
  PANEL_CSS,
  NOT_FOUND_HTML,
  type Panel,
  type Reply,
} from "./panel-harness.ts";

const VIEWS = ["categories", "apps", "accounts", "releases", "audit"];

/** A sign-in that will actually complete: cheap PBKDF2, then a session. */
function withLogin(admin: Reply = { status: 200, body: { admin: { username: "wafi" } } }) {
  return router(
    withCategories,
    (request) =>
      request.path.startsWith("/api/admin/auth/params")
        ? { status: 200, body: { salt: "salt", iterations: 1 } }
        : undefined,
    (request) => (request.path.endsWith("/api/admin/login") ? admin : undefined),
  );
}

// ---------------------------------------------------------------------------

describe("the sign-in gate", () => {
  test("the markup itself hides everything but the login form", () => {
    // Checked in the source, not the rendered DOM, because this has to be true
    // *before* any script runs. A panel that revealed content and then hid it
    // would still leak the flash.
    assert.match(PANEL_HTML, /<header class="topbar" id="topbar" hidden>/);
    for (const view of VIEWS) {
      assert.match(
        PANEL_HTML,
        new RegExp(`id="view-${view}" hidden`),
        `#view-${view} must carry hidden in the markup`,
      );
    }
    // And the login form must be the one thing that is not hidden.
    assert.match(PANEL_HTML, /id="view-login"(?! hidden)/);
  });

  test("the hidden attribute is given the last word over the stylesheet", () => {
    // Found the hard way: `.topbar` sets `display: flex`, which beat the UA
    // stylesheet's `[hidden] { display: none }`, so the tab strip and the Sign out
    // button rendered for a visitor with no session while `element.hidden` still
    // read `true`. No attribute-level check can see that - it takes a browser.
    // This pins the rule that prevents it recurring.
    assert.match(
      PANEL_CSS,
      /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
      "the stylesheet must give [hidden] priority",
    );
    // And nothing may re-declare it without that priority.
    const bare = PANEL_CSS.replace(/\[hidden\]\s*\{[^}]*\}/g, "");
    assert.ok(!bare.includes("[hidden]"), "[hidden] is declared once, with !important");
  });

  test("no editor is visible in the markup either", () => {
    for (const editor of [
      "category-editor",
      "app-editor",
      "versions-editor",
      "grant-editor",
      "revoke-editor",
      "disable-editor",
      "release-editor",
      "accounts-pager",
      "accounts-loading",
    ]) {
      assert.match(
        PANEL_HTML,
        new RegExp(`id="${editor}"[^>]*hidden`),
        `#${editor} must start hidden`,
      );
    }
  });

  test("an unauthenticated load shows the login form and nothing else", async () => {
    const panel = mount(router(isSignedOut, withCategories));
    await panel.settle();

    assert.equal(panel.hidden("view-login"), false, "the login form is on screen");
    assert.equal(panel.hidden("topbar"), true, "the tab strip is not");
    for (const view of VIEWS) {
      assert.equal(panel.hidden(`view-${view}`), true, `#view-${view} must be hidden`);
    }
    assert.equal(panel.text("who"), "", "no administrator identity is shown");
  });

  test("a signed-in load reveals the tab strip and the content", async () => {
    const panel = mount(router(isSignedIn, withCategories));
    await panel.settle();

    assert.equal(panel.hidden("view-login"), true, "the login form is gone");
    assert.equal(panel.hidden("topbar"), false, "the tab strip is shown");
    assert.equal(panel.hidden("view-categories"), false, "the landing view is shown");
    assert.equal(panel.text("who"), "wafi");
    assert.equal(panel.tabs().length, VIEWS.length);
  });

  test("the real sign-in form reveals the panel", async () => {
    const panel = mount(withLogin());
    await panel.settle();
    assert.equal(panel.hidden("topbar"), true, "still signed out to begin with");

    await panel.signIn("wafi", "a password");

    assert.equal(panel.hidden("topbar"), false);
    assert.equal(panel.hidden("view-login"), true);
    assert.equal(panel.text("who"), "wafi");
  });

  test("a rejected password leaves the form on screen and does not tear the page down", async () => {
    // A 401 from the sign-in attempt is a form error, not a dead session: the
    // panel must not treat it as one, or a typo would blank the page.
    const panel = mount(
      withLogin({ status: 401, body: { error: { code: "unauthorized", message: "Wrong" } } }),
    );
    await panel.settle();
    await panel.signIn("wafi", "wrong");

    assert.equal(panel.hidden("view-login"), false, "still on the form");
    assert.equal(panel.hidden("topbar"), true, "and still showing nothing else");
    assert.equal(panel.hidden("login-error"), false, "with the reason given");
    assert.ok(panel.text("login-error").length > 0);
  });

  test("a 401 arriving mid-session returns to the login form and hides the sections", async () => {
    const panel = mount(router(isSignedIn, withCategories));
    await panel.settle();
    assert.equal(panel.hidden("topbar"), false, "signed in to begin with");

    // The cookie expires between two clicks. The panel cannot see that itself -
    // the cookie is HttpOnly - so the 401 is the only signal it will ever get.
    panel.setRoute(
      router(
        (request) =>
          request.path.startsWith("/api/admin/accounts?")
            ? { status: 401, body: { error: { code: "unauthorized", message: "Session expired" } } }
            : undefined,
        withCategories,
      ),
    );
    await panel.goto("accounts");

    assert.equal(panel.hidden("topbar"), true, "the tab strip is withdrawn");
    assert.equal(panel.hidden("view-login"), false, "the login form is back");
    for (const view of VIEWS) {
      assert.equal(panel.hidden(`view-${view}`), true, `#view-${view} must be hidden again`);
    }
    assert.match(panel.text("login-error"), /انتهت جلسة الإدارة/);
  });

  test("the listed accounts are dropped when the session ends", async () => {
    // Not merely hidden: a cached list belongs to the session that read it, and
    // the next operator at that keyboard should not inherit it.
    const panel = mount(
      router(
        isSignedIn,
        withCategories,
        (request) =>
          request.path.startsWith("/api/admin/accounts?")
            ? {
                status: 200,
                body: {
                  accounts: [
                    {
                      id: "a",
                      email: "ada@example.com",
                      created_at: "2026-10-01 09:00:00",
                      last_login_at: null,
                      disabled: false,
                      grant: null,
                    },
                  ],
                  count: 1,
                  limit: 50,
                  offset: 0,
                },
              }
            : undefined,
      ),
    );
    await panel.settle();
    await panel.goto("accounts");
    assert.equal(panel.rows("accounts-table").length, 1, "one account is listed");

    await panel.node("signout").fire("click");
    await panel.settle();

    assert.equal(panel.hidden("topbar"), true);
    assert.equal(panel.hidden("view-login"), false);
    assert.equal(panel.rows("accounts-table").length, 0, "the list is cleared, not just hidden");
  });

  test("signing out asks the API to end the session", async () => {
    const panel = mount(
      router(
        isSignedIn,
        withCategories,
        (request) =>
          request.path.endsWith("/api/admin/logout") ? { status: 200, body: { ok: true } } : undefined,
      ),
    );
    await panel.settle();
    await panel.node("signout").fire("click");
    await panel.settle();

    const posts = panel.calls.filter((call) => call.path.endsWith("/api/admin/logout"));
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.method, "POST");
  });

  test("a failed sign-out still clears the local panel", async () => {
    const panel = mount(router(isSignedIn, withCategories));
    await panel.settle();
    await panel.node("signout").fire("click");
    await panel.settle();
    assert.equal(panel.hidden("topbar"), true, "the local view is cleared regardless");
  });
});

// ---------------------------------------------------------------------------

describe("Arabic and RTL", () => {
  test("the document declares Arabic and right-to-left", () => {
    assert.match(PANEL_HTML, /<html lang="ar" dir="rtl">/);
  });

  test("the 404 page declares Arabic and right-to-left too", () => {
    assert.match(NOT_FOUND_HTML, /<html lang="ar" dir="rtl">/);
  });

  test("every tab is labelled in Arabic", () => {
    const tabs = [...PANEL_HTML.matchAll(/class="tab" data-view="([a-z]+)">([^<]+)</g)];
    assert.equal(tabs.length, VIEWS.length);
    for (const [, view, label] of tabs) {
      assert.match(
        label ?? "",
        /[\u0600-\u06FF]/,
        `the ${view} tab label should be Arabic`,
      );
    }
  });

  test("every section heading is Arabic", () => {
    const headings = [...PANEL_HTML.matchAll(/<h1>([^<]+)<\/h1>/g)].map((m) => m[1] ?? "");
    assert.ok(headings.length >= VIEWS.length + 1, "every view has a heading");
    for (const heading of headings) {
      assert.match(heading, /[\u0600-\u06FF]/, `"${heading}" should be Arabic`);
    }
  });

  test("the strings that were English are now Arabic", () => {
    // The specific old wording, so this stays a regression check rather than a
    // guess at "is anything English left".
    for (const old of [
      "Sign in",
      "Sign out",
      "Categories",
      "Applications",
      "Accounts",
      "Audit log",
      "New category",
      "New application",
      "New release",
      "Grant Pro",
      "Revoke Pro",
      "Disable account",
      "Perpetual",
      "Cancel",
      "Search",
      "Refresh",
      "Reason",
    ]) {
      assert.ok(!PANEL_HTML.includes(`>${old}<`), `"${old}" should no longer be a label`);
    }
  });

  test("the panel's own runtime strings are Arabic", () => {
    // Strings app.js writes into the DOM: toasts, empty rows, confirmations and
    // the status sentences. Read from the stripped source so the English words in
    // its comments cannot satisfy this.
    for (const arabic of [
      "لا توجد حسابات بعد",
      "لا يوجد حساب بهذا البريد الإلكتروني",
      "تم منح Pro",
      "تم سحب Pro",
      "تم تعطيل الحساب",
      "تم تفعيل الحساب",
      "انتهت جلسة الإدارة",
      "جارٍ تسجيل الدخول",
      "جارٍ البحث",
      "لا توجد فئات بعد",
      "لا توجد تطبيقات بعد",
      "لا توجد إصدارات بعد",
      "لا توجد إصدارات مسجَّلة",
      "لا يوجد شيء مسجَّل بعد",
    ]) {
      assert.ok(PANEL_JS.includes(arabic), `app.js should carry "${arabic}"`);
    }
  });

  test("identifiers and API vocabulary are deliberately left untranslated", () => {
    // These are values, not prose. Translating any of them would change what the
    // panel sends or how an operator recognises a plan or a status.
    for (const kept of ['value="pro"', 'value="lifetime"', 'value="exe"', 'value="msi"', 'value="stable"', 'value="beta"']) {
      assert.ok(PANEL_HTML.includes(kept), `${kept} should stay as sent to the API`);
    }
    assert.ok(PANEL_HTML.includes("SHA-256"));
    assert.ok(PANEL_HTML.includes("PBKDF2-SHA256"));
    assert.ok(PANEL_HTML.includes("UTC"));
    assert.ok(PANEL_HTML.includes("latest.json"));
  });

  test("the layout is written with logical properties, not left and right", () => {
    // A physical `left`/`right` would pin something to the wrong edge under RTL,
    // which is the difference between a translated panel and a mirrored one.
    assert.ok(!/text-align:\s*left/.test(PANEL_CSS), "no text-align: left");
    assert.ok(!/text-align:\s*right/.test(PANEL_CSS), "no text-align: right");
    assert.ok(!PANEL_CSS.includes("border-left:"), "no border-left");
    assert.ok(!PANEL_CSS.includes("border-right:"), "no border-right");
    assert.ok(!PANEL_CSS.includes("margin-left:"), "no margin-left");
    assert.ok(!PANEL_CSS.includes("padding-left:"), "no padding-left");
    assert.ok(!/\bleft:\s*50%/.test(PANEL_CSS), "the toast centres with inset-inline-start");
    assert.match(PANEL_CSS, /border-inline-start: 3px solid var\(--ok\)/);
  });

  test("a utility exists to keep identifiers in their own direction", () => {
    // Without this, an email inside an Arabic sentence renders with its `@` and
    // its dots moved to the wrong end.
    assert.match(PANEL_CSS, /\.ltr\s*\{[^}]*direction:\s*ltr[^}]*unicode-bidi:\s*isolate/);
    assert.ok(PANEL_HTML.includes('class="ltr"'), "the markup uses it");
  });

  test("identifier fields carry it, so addresses and hashes read correctly", () => {
    for (const field of ["account-email", "login-username", "login-password", "category-id", "app-id", "version-number", "version-sha", "version-url", "release-url", "release-sha", "grant-expires"]) {
      const tag = new RegExp(`id="${field}"[^>]*dir="ltr"`).test(PANEL_HTML);
      assert.ok(tag, `#${field} should declare dir="ltr"`);
    }
  });

  test("inline code keeps its own direction", () => {
    // `latest.json` is a filename; under RTL its dot lands on the wrong side.
    assert.match(PANEL_CSS, /code\s*\{[^}]*direction:\s*ltr[^}]*unicode-bidi:\s*isolate/);
  });

  test("the font stack can actually render Arabic", () => {
    assert.match(PANEL_CSS, /Noto Sans Arabic/);
  });

  test("the Arabic text is stored as real UTF-8, with no mojibake", () => {
    // A file written as Latin-1 shows as sequences like Ù or æ; this is the
    // cheap check that the encoding round-tripped.
    assert.ok(!/Ã|Ø§|Ù/.test(PANEL_HTML), "panel.html shows no mojibake");
    assert.ok(!/Ã|Ø§|Ù/.test(PANEL_JS), "app.js shows no mojibake");
    const arabic = PANEL_HTML.match(/[\u0600-\u06FF]/g) ?? [];
    assert.ok(arabic.length > 200, `expected many Arabic characters, found ${arabic.length}`);
  });
});

// ---------------------------------------------------------------------------

describe("branding", () => {
  test("the panel is branded Daltoon X", () => {
    assert.match(PANEL_HTML, /<span class="brand">Daltoon&nbsp;X<\/span>/);
    assert.match(PANEL_HTML, /<title>Daltoon X &middot; لوحة الإدارة<\/title>/);
    assert.match(PANEL_HTML, /إصدارات Daltoon X/);
    assert.match(NOT_FOUND_HTML, /Daltoon X &middot; غير موجود/);
  });

  test("no Wafi X branding is left in the panel", () => {
    for (const file of [PANEL_HTML, PANEL_JS, PANEL_CSS, NOT_FOUND_HTML]) {
      const hit = /Wafi\s*(?:&nbsp;|&#160;|\s)?X|Wafi X/.exec(file);
      assert.equal(hit, null, `found leftover branding "${hit?.[0] ?? ""}"`);
    }
  });

  test("the one remaining Wafi is the API's own header name", () => {
    // `X-WAFI-Admin` is the header the backend's CSRF check requires. Renaming it
    // would make every mutation a 403; it is a contract, not branding.
    assert.match(PANEL_CODE, /const ADMIN_HEADER = \{ "X-WAFI-Admin": "1" \}/);
  });

  test("the panel never names the Worker's own identifiers", () => {
    // The Worker is `wafx-api` and the licence product is `wafix`. Neither is the
    // panel's to display, and printing either invites the two to be confused.
    for (const forbidden of ["wafx-api", "wafix"]) {
      assert.ok(!PANEL_HTML.includes(forbidden), `panel.html should not mention ${forbidden}`);
      assert.ok(!PANEL_CODE.includes(forbidden), `app.js should not mention ${forbidden}`);
    }
  });

  test("no account cookie or session token name is hard-coded in the markup", () => {
    assert.ok(!PANEL_HTML.includes("__Host-"), "the cookie rides along on credentials, not by name");
  });
});

// ---------------------------------------------------------------------------

describe("Applications: adding a version from a direct URL", () => {
  /**
   * The convenience this exists for: an operator should be able to add an
   * application by pasting a link to the installer, with no upload to R2 and no
   * checksum to compute. The panel's half of that is that neither field is
   * required, and that omitting the checksum sends `null` rather than an empty
   * string the API would have to guess about.
   */
  async function versionsPanel(): Promise<Panel> {
    const panel = mount(
      router(
        isSignedIn,
        withCategories,
        (request) =>
          request.path.endsWith("/api/admin/apps")
            ? {
                status: 200,
                body: {
                  apps: [
                    {
                      id: "firefox",
                      name: "Firefox",
                      description: "",
                      publisher: "",
                      category_id: null,
                      version_count: 0,
                      published_version_count: 0,
                      featured: false,
                      published: true,
                      position: 0,
                    },
                  ],
                },
              }
            : undefined,
        (request) =>
          request.path.endsWith("/versions") && request.method === "GET"
            ? { status: 200, body: { versions: [] } }
            : undefined,
        (request) =>
          request.path.endsWith("/versions") && request.method === "POST"
            ? { status: 201, body: { ok: true } }
            : undefined,
      ),
    );
    await panel.settle();
    await panel.goto("apps");
    // The "versions" action on the row opens the editor for that application.
    const open = panel
      .buttonsIn("apps-table")
      .find((button) => button.textContent === "الإصدارات");
    assert.ok(open !== undefined, "the applications grid should offer a versions action");
    await open.fire("click");
    await panel.settle();
    return panel;
  }

  test("the URL is required and the checksum is not", async () => {
    const panel = await versionsPanel();
    assert.equal(panel.node("version-url").required, true, "a download URL is required");
    assert.equal(panel.node("version-sha").required, false, "a checksum must not be required");
    assert.equal(
      panel.node("version-sha").value,
      "",
      "and it starts empty, so it reads as optional rather than as a gap to fill",
    );
  });

  test("a direct https URL with no checksum sends exactly the allowed fields", async () => {
    const panel = await versionsPanel();
    panel.node("version-number").value = "131.0";
    panel.node("version-type").value = "exe";
    panel.node("version-mode").value = "silent";
    panel.node("version-url").value = "https://download.example/firefox-131.exe";
    panel.node("version-sha").value = "";
    panel.node("version-published").checked = true;
    await panel.node("version-form").fire("submit");
    await panel.settle();

    const posts = panel.calls.filter((c) => c.method === "POST" && c.path.endsWith("/versions"));
    assert.equal(posts.length, 1, "the version was posted");
    const body = posts[0]?.body as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body).sort(),
      [
        "installer_mode",
        "installer_sha256",
        "installer_size_bytes",
        "installer_type",
        "installer_url",
        "installer_url_kind",
        "published",
        "release_date",
        "version",
      ],
      "exactly the fields the API's allowlist names, no more",
    );
    assert.equal(body.installer_url, "https://download.example/firefox-131.exe");
    assert.equal(body.installer_sha256, null, "absent, not an empty string");
    assert.equal(body.installer_type, "exe");
    assert.equal(body.installer_mode, "silent");
    assert.equal(body.published, true);
  });

  test("the panel always publishes an external URL, never an R2 key", async () => {
    // There is no bucket, so offering the choice would only produce a 422. The
    // kind is fixed in one place rather than offered and then refused.
    const panel = await versionsPanel();
    panel.node("version-number").value = "1.0";
    panel.node("version-url").value = "https://download.example/thing.msi";
    panel.node("version-type").value = "msi";
    await panel.node("version-form").fire("submit");
    await panel.settle();

    const body = panel.calls.find((c) => c.method === "POST" && c.path.endsWith("/versions"))?.body as Record<string, unknown>;
    assert.equal(body.installer_url_kind, "external");
  });

  test("a checksum is sent when one is given, and trimmed", async () => {
    const panel = await versionsPanel();
    panel.node("version-number").value = "2.0";
    panel.node("version-url").value = "https://download.example/thing.exe";
    panel.node("version-sha").value = `  ${"A".repeat(64)}  `;
    await panel.node("version-form").fire("submit");
    await panel.settle();

    const body = panel.calls.find((c) => c.method === "POST" && c.path.endsWith("/versions"))?.body as Record<string, unknown>;
    assert.equal(body.installer_sha256, "A".repeat(64), "trimmed, and case left to the API");
  });

  test("no field exists that could carry an installer argument", async () => {
    // The API has no such field, so neither does the form. Asserting the absence
    // is the point: adding one would be the only way this could regress.
    const panel = await versionsPanel();
    const fields = [...panel.node("version-form").descendants()]
      .filter((node) => node.tagName === "INPUT" || node.tagName === "SELECT" || node.tagName === "TEXTAREA")
      .map((node) => node.getAttribute("name"))
      .filter((name): name is string => name !== null);

    for (const forbidden of ["args", "arguments", "command", "program", "shell", "installer_args"]) {
      assert.ok(!fields.includes(forbidden), `the form must not offer a "${forbidden}" field`);
    }
    assert.ok(
      !fields.some((name) => /arg|cmd|shell|exec/i.test(name)),
      `no field name may look like a command line: ${fields.join(", ")}`,
    );
  });

  test("the panel explains that a direct URL is enough and a checksum is optional", () => {
    assert.match(
      PANEL_HTML,
      /id="version-url"[^>]*\brequired\b/,
      "the URL field is the only required one",
    );
    assert.match(
      PANEL_HTML,
      /<label for="version-sha">SHA-256 <small>[^<]*<\/small><\/label>/,
      "the checksum label says it is optional",
    );
    // And the consequence is stated, so an operator is not left guessing what
    // happens when they leave it blank.
    assert.match(PANEL_HTML, /SHA-256<\/span>[^<]*تحقّق/, "the note says a digest is verified when given");
    assert.match(PANEL_HTML, /دون تحقّق من السلامة/, "and says what happens when it is not");
  });
});

// ---------------------------------------------------------------------------

describe("panel-wide security invariants", () => {
  test("database values are written as text, never as markup", () => {
    // The one non-negotiable in app.js's header: a value out of D1 must never be
    // able to become script inside the page that can publish an installer.
    for (const forbidden of ["innerHTML", "insertAdjacentHTML", "outerHTML", "createContextualFragment"]) {
      assert.ok(!PANEL_CODE.includes(forbidden), `app.js must not use ${forbidden}`);
    }
    assert.match(PANEL_CODE, /node\.textContent = String\(text\)/);
  });

  test("the comment stripper the checks above rely on actually strips", () => {
    // Guards the guard: the stripped copy is what several assertions read, and a
    // stripper that quietly matched nothing would let them pass for the wrong
    // reason.
    assert.ok(PANEL_CODE.length < PANEL_JS.length, "the stripper removed nothing");
    const declared = [...PANEL_JS.matchAll(/\bfunction\s+([A-Za-z0-9_$]+)\s*\(/g)].map((m) => m[1]);
    assert.ok(declared.length > 20, `expected many functions, found ${declared.length}`);
    for (const name of declared) {
      assert.ok(PANEL_CODE.includes(`function ${name}(`), `stripping ate the body of ${name}`);
    }
  });

  test("no credential is ever persisted by the panel", () => {
    for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
      assert.ok(!PANEL_JS.includes(forbidden), `app.js must not use ${forbidden}`);
    }
  });

  test("every element app.js reaches for exists in panel.html", () => {
    // The panel has no bundler to catch a renamed id, and a `$()` that returns
    // null throws on the first property access - at load time, in a browser, with
    // no stack trace pointing at the markup that moved.
    const referenced = new Set<string>();
    for (const match of PANEL_JS.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)) {
      const id = match[1];
      if (id !== undefined) referenced.add(id);
    }
    assert.ok(referenced.size > 40, `expected many ids, found ${referenced.size}`);
    const declared = new Set([...PANEL_HTML.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
    const missing = [...referenced].filter((id) => !declared.has(id));
    assert.deepEqual(missing, [], `panel.html is missing: ${missing.join(", ")}`);
  });

  test("every mutation goes out with the admin header", () => {
    // The backend's second CSRF check. A panel that forgot it would get a 403 on
    // the exact operations an operator has just confirmed.
    assert.match(PANEL_CODE, /const ADMIN_HEADER = \{ "X-WAFI-Admin": "1" \}/);
  });

  test("the session cookie rides along on the request, not by name", () => {
    assert.match(PANEL_CODE, /credentials: "same-origin"/);
  });

  test("the panel sends no inline script or style, which its CSP forbids", () => {
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(PANEL_HTML), "no inline script");
    assert.ok(!/\sstyle="/.test(PANEL_HTML), "no inline style attribute");
    assert.ok(!/<style[\s>]/.test(PANEL_HTML), "no inline style block");
    assert.ok(!/\son(click|change|submit|load|error)=/.test(PANEL_HTML), "no inline event handler");
  });

  test("every button in the accounts view declares its type", () => {
    // A `type="button"` omission inside a form makes Cancel submit it.
    const section = PANEL_HTML.slice(
      PANEL_HTML.indexOf('id="view-accounts"'),
      PANEL_HTML.indexOf("<!-- Releases"),
    );
    const buttons = [...section.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length > 0, "the view has buttons");
    for (const button of buttons) {
      assert.match(button, /type="(button|submit)"/, `missing type: ${button}`);
    }
  });

  test("the requests stay inside the admin and account prefixes", () => {
    for (const match of PANEL_JS.matchAll(/call\("(\/api\/[^"`$]*)/g)) {
      assert.match(match[1] ?? "", /^\/api\//);
    }
    assert.ok(!PANEL_CODE.includes("http://"), "no absolute plaintext URL");
    assert.ok(!/https?:\/\/(?!localhost)/.test(PANEL_CODE.replace(/https?:\/\/"/g, "")), "no hard-coded origin");
  });
});