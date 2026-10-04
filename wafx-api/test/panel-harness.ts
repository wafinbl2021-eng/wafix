/**
 * Test harness for the admin panel's static front end.
 *
 * WHY THIS IS BUILT THE WAY IT IS
 * ===============================
 *
 * The panel is three static files served straight from the Worker - no bundler,
 * no framework, no test runner of its own - so there is nothing to import and no
 * DOM library in the dependency tree to drive it with one. `app.js` also has no
 * exports: it wires itself to the document on load and is then driven by clicks,
 * exactly as a browser drives it.
 *
 * So this file supplies the two things the panel expects from its environment - a
 * `document` and a `fetch` - and runs the *shipped* `admin/app.js` inside
 * `node:vm` against them. Nothing is copied or stubbed-out: if a selector or an id
 * in that file breaks, these tests fail. The alternative, extracting the logic
 * into something importable, would be a rewrite of the panel to suit its tests.
 *
 * The stub implements only what `app.js` actually touches. That is a deliberate
 * limit: every method here is one the panel calls, and adding speculative surface
 * would make the stub look more like a browser than it is.
 *
 * NOT `.test.ts`, so `node --test "test/*.test.ts"` does not run this file as a
 * suite; it is imported by the two suites that drive the panel.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import assert from "node:assert/strict";

/**
 * The panel's directory, found from this file rather than from `process.cwd()`, so
 * the suites behave the same however they were invoked.
 *
 * Built by string joining instead of `new URL("../admin/", import.meta.url)`
 * because `@cloudflare/workers-types` declares its own `URL` class, and that one
 * is not the `string | URL` `node:url` accepts.
 */
const ADMIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "admin");

export const PANEL_HTML = readFileSync(join(ADMIN_DIR, "panel.html"), "utf8");
export const PANEL_JS = readFileSync(join(ADMIN_DIR, "app.js"), "utf8");
export const PANEL_CSS = readFileSync(join(ADMIN_DIR, "styles.css"), "utf8");
export const NOT_FOUND_HTML = readFileSync(join(ADMIN_DIR, "404.html"), "utf8");

/**
 * A source file with its comments removed.
 *
 * Only for checks that must distinguish code from prose. The panel documents its
 * own security rules in comments - including the rule that it never uses
 * `innerHTML` - so a raw-source check for a forbidden API fails on the very
 * sentence that forbids it.
 *
 * Not a general-purpose JS parser, and it does not need to be one: in
 * `admin/app.js` every block-comment delimiter is balanced, no string or
 * regular-expression literal contains a comment opener or a line-comment marker,
 * and every line comment starts its line. `app.js` is also executed unmodified by
 * `mount` below, so the file under test is always the shipped one; only these
 * source assertions read the stripped copy, and a suite fails loudly if that copy
 * ever stops matching the code.
 */
export const PANEL_CODE = PANEL_JS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// A DOM small enough to read
// ---------------------------------------------------------------------------

export interface StubEvent {
  type: string;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface StubClassList {
  add(...names: string[]): void;
  remove(name: string): void;
  contains(name: string): boolean;
  toggle(name: string, force?: boolean): boolean;
}

export class StubNode {
  tagName: string;
  childNodes: StubNode[] = [];
  classes = new Set<string>();
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  hidden = false;
  value = "";
  checked = false;
  disabled = false;
  readOnly = false;
  required = false;
  selected = false;
  ownText = "";
  parent: StubNode | null = null;

  private readonly handlers = new Map<string, ((event: StubEvent) => unknown)[]>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  /**
   * Rebuilt per access rather than stored, so it never holds a stale reference.
   *
   * The arrow functions capture `this` lexically, which is why this needs no
   * `const self = this`. For that to stay correct, `classes` below must keep one
   * identity for the node's whole life - hence `className`'s setter clearing and
   * refilling it instead of replacing it.
   */
  get classList(): StubClassList {
    const classes = this.classes;
    return {
      add: (...names) => {
        for (const name of names) classes.add(name);
      },
      remove: (name) => {
        classes.delete(name);
      },
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const wanted = force ?? !classes.has(name);
        if (wanted) classes.add(name);
        else classes.delete(name);
        return wanted;
      },
    };
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  set className(value: string) {
    this.classes.clear();
    for (const part of value.split(/\s+/)) {
      if (part !== "") this.classes.add(part);
    }
  }

  get textContent(): string {
    return this.ownText + this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = String(value);
    this.childNodes = [];
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "class") {
      this.className = value;
      return;
    }
    // data-view -> dataset.view, matching the DOM's own camel-casing.
    if (name.startsWith("data-")) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: StubNode[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.childNodes.push(node);
    }
  }

  replaceChildren(...nodes: StubNode[]): void {
    this.childNodes = [];
    this.ownText = "";
    this.append(...nodes);
  }

  /** Only tag selectors - the sole form `app.js` uses is `querySelector("tbody")`. */
  querySelector(selector: string): StubNode | null {
    const wanted = selector.toUpperCase();
    for (const child of this.childNodes) {
      if (child.tagName === wanted) return child;
      const nested = child.querySelector(selector);
      if (nested !== null) return nested;
    }
    return null;
  }

  descendants(): StubNode[] {
    const out: StubNode[] = [];
    for (const child of this.childNodes) {
      out.push(child, ...child.descendants());
    }
    return out;
  }

  addEventListener(type: string, handler: (event: StubEvent) => unknown): void {
    const existing = this.handlers.get(type) ?? [];
    existing.push(handler);
    this.handlers.set(type, existing);
  }

  /**
   * Fires an event and awaits every handler.
   *
   * The panel's handlers are async, and several are reached through `void` calls
   * the tab wiring cannot return a promise from. Awaiting the handlers is what
   * makes a click's follow-up fetch observable before the next assertion.
   *
   * Returns the event, so a test can check that a handler cancelled the default
   * action - a submit that did not call `preventDefault` would reload the page in
   * a browser, and nothing else here would notice.
   */
  async fire(type: string): Promise<StubEvent> {
    const event: StubEvent = {
      type,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault(): void {
        this.defaultPrevented = true;
      },
      stopPropagation(): void {
        this.propagationStopped = true;
      },
    };
    for (const handler of this.handlers.get(type) ?? []) {
      await handler(event);
    }
    return event;
  }
}

/**
 * Builds the document from `panel.html` itself rather than from a hand-written
 * list. The ids therefore come from the shipped markup, which is what lets the
 * "every id app.js reaches for exists" assertion mean anything.
 */
export function buildDocument(): {
  byId: Map<string, StubNode>;
  tabs: StubNode[];
  document: {
    getElementById(id: string): StubNode | null;
    createElement(tag: string): StubNode;
    querySelectorAll(selector: string): StubNode[];
  };
} {
  const byId = new Map<string, StubNode>();

  for (const match of PANEL_HTML.matchAll(/id="([A-Za-z0-9_-]+)"/g)) {
    const id = match[1];
    if (id === undefined || byId.has(id)) continue;
    const node = new StubNode("div");
    // Carry over the two attributes the markup declares that assertions and the
    // panel itself both rely on. Without this the stub would report every field as
    // optional and the "is this required?" questions could not be asked of it.
    const tag = new RegExp(`<[a-zA-Z][^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`).exec(
      PANEL_HTML,
    )?.[0];
    if (tag !== undefined) {
      if (/\brequired\b/.test(tag)) node.required = true;
      if (/\bdisabled\b/.test(tag)) node.disabled = true;
    }
    byId.set(id, node);
  }

  // Every grid in the panel renders into a `<tbody>` and is reached with
  // `querySelector("tbody")`, so each `*-table` needs one.
  for (const [id, node] of byId) {
    if (id.endsWith("-table")) node.append(new StubNode("tbody"));
  }

  const tabs: StubNode[] = [];
  for (const match of PANEL_HTML.matchAll(/class="tab" data-view="([a-z]+)"/g)) {
    const view = match[1];
    if (view === undefined) continue;
    const tab = new StubNode("button");
    tab.className = "tab";
    tab.setAttribute("data-view", view);
    tabs.push(tab);
  }

  const closers: StubNode[] = [];
  for (const match of PANEL_HTML.matchAll(/data-close="([A-Za-z0-9_-]+)"/g)) {
    const target = match[1];
    if (target === undefined) continue;
    const closer = new StubNode("button");
    closer.setAttribute("data-close", target);
    closers.push(closer);
  }

  return {
    byId,
    tabs,
    document: {
      getElementById: (id) => byId.get(id) ?? null,
      createElement: (tag) => new StubNode(tag),
      querySelectorAll: (selector) => {
        if (selector === ".tab") return tabs;
        if (selector === "[data-close]") return closers;
        return [];
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Mounting the panel
// ---------------------------------------------------------------------------

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface Reply {
  status: number;
  body: unknown;
}

export const SIGNED_IN: Reply = { status: 200, body: { admin: { username: "wafi" } } };

export const UNAUTHORIZED: Reply = {
  status: 401,
  body: { error: { code: "unauthorized", message: "Sign in to continue" } },
};

/**
 * The panel's landing view is the categories grid, and `signedIn` loads it before
 * any tab is clicked. A stub that 404s there produces an unhandled rejection that
 * node:test attributes to whichever suite happens to be running, so the harness
 * answers it - the same way a real backend would.
 */
export const EMPTY_CATEGORIES: Reply = { status: 200, body: { categories: [] } };

export const NOT_FOUND: Reply = {
  status: 404,
  body: { error: { code: "not_found", message: "no such route" } },
};

/** A route matcher. Returning `undefined` means "not mine". */
export type Route = (request: Recorded) => Reply | undefined;

/** First route that claims the request wins; unmatched requests 404. */
export function router(...routes: Route[]): (request: Recorded) => Reply {
  return (request) => {
    for (const route of routes) {
      const answer = route(request);
      if (answer !== undefined) return answer;
    }
    return NOT_FOUND;
  };
}

export const isSignedIn: Route = (request) =>
  request.path.endsWith("/api/admin/me") ? SIGNED_IN : undefined;

export const isSignedOut: Route = (request) =>
  request.path.endsWith("/api/admin/me") ? UNAUTHORIZED : undefined;

export const withCategories: Route = (request) =>
  request.path.endsWith("/api/admin/categories") ? EMPTY_CATEGORIES : undefined;

export interface Panel {
  calls: Recorded[];
  confirmations: string[];
  settle(): Promise<void>;
  node(id: string): StubNode;
  text(id: string): string;
  hidden(id: string): boolean;
  setConfirm(answer: boolean): void;
  setRoute(reply: (request: Recorded) => Reply): void;
  buttonsIn(id: string): StubNode[];
  button(containerId: string, label: string): StubNode;
  rows(tableId: string): string[][];
  rowButtons(tableId: string, rowIndex: number): StubNode[];
  sent(suffix: string): Recorded[];
  goto(view: string): Promise<void>;
  search(email: string): Promise<void>;
  signIn(username?: string, password?: string): Promise<void>;
  tabs(): StubNode[];
}

export function mount(initial: (request: Recorded) => Reply = () => NOT_FOUND): Panel {
  const { byId, tabs, document } = buildDocument();
  const calls: Recorded[] = [];
  const confirmations: string[] = [];
  let confirmAnswer = true;
  let reply = initial;

  /**
   * The three members of `Response` that `call()` in app.js actually reads: `ok`,
   * `status`, and an async `text()`.
   *
   * Not `async` - nothing here waits, and marking it so would be a promise that
   * resolves for no reason. The panel only ever awaits these.
   */
  const fetchStub = (
    input: unknown,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    const request: Recorded = {
      method: init?.method ?? "GET",
      path: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
      headers: init?.headers ?? {},
    };
    calls.push(request);
    const result = reply(request);
    const text = result.body === undefined ? "" : JSON.stringify(result.body);
    return Promise.resolve({
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: () => Promise.resolve(text),
    });
  };

  runInNewContext(
    PANEL_JS,
    {
      document,
      fetch: fetchStub,
      crypto: webcrypto,
      // `runInNewContext` gives the script ECMAScript built-ins and nothing else:
      // no web APIs. `TextEncoder`, `URLSearchParams` and `URL` all exist in every
      // browser and are all things a page may legitimately use, so the sandbox is
      // given them rather than the panel being written around their absence.
      TextEncoder,
      URLSearchParams,
      URL,
      setTimeout,
      clearTimeout,
      console,
      confirm: (message: string) => {
        confirmations.push(message);
        return confirmAnswer;
      },
    },
    { filename: "admin/app.js" },
  );

  const need = (id: string): StubNode => {
    const node = byId.get(id);
    assert.ok(node !== undefined, `panel.html should define #${id}`);
    return node;
  };

  /** Lets the panel's fire-and-forget loads finish before asserting. */
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 8; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const panel: Panel = {
    calls,
    confirmations,
    settle,
    node: need,
    text: (id) => need(id).textContent,
    hidden: (id) => need(id).hidden,
    tabs: () => tabs,

    setConfirm: (answer) => {
      confirmAnswer = answer;
    },

    setRoute: (next) => {
      reply = next;
    },

    buttonsIn: (id) =>
      need(id)
        .descendants()
        .filter((node) => node.tagName === "BUTTON"),

    button: (containerId, label) => {
      const found = panel.buttonsIn(containerId).find((node) => node.textContent === label);
      assert.ok(found !== undefined, `#${containerId} should offer a "${label}" button`);
      return found;
    },

    /** Table rows as arrays of cell text - the shape most assertions want. */
    rows: (tableId) => {
      const tbody = need(tableId).querySelector("tbody");
      assert.ok(tbody !== null, `#${tableId} should have a tbody`);
      return (tbody?.childNodes ?? []).map((row) =>
        // An empty-state row is one `tr` carrying its own text and no cells,
        // because it is meant to span the width of the table. Reported as a
        // single wide cell so a caller can read it like any other row.
        row.childNodes.length === 0
          ? [row.textContent]
          : row.childNodes.map((cell) => cell.textContent),
      );
    },

    /** The action buttons inside one row's cells, left to right in DOM order. */
    rowButtons: (tableId, rowIndex) => {
      const tbody = need(tableId).querySelector("tbody");
      const row = tbody?.childNodes[rowIndex];
      assert.ok(row !== undefined, `#${tableId} should have a row ${rowIndex}`);
      return (row?.descendants() ?? []).filter((node) => node.tagName === "BUTTON");
    },

    /** Every request whose path ends with `suffix`. */
    sent: (suffix) => calls.filter((call) => call.path.endsWith(suffix)),

    goto: async (view) => {
      const found = tabs.find((node) => node.dataset.view === view);
      assert.ok(found !== undefined, `the tab strip should have a "${view}" tab`);
      await found.fire("click");
      await panel.settle();
    },

    search: async (email) => {
      need("account-email").value = email;
      const event = await need("account-search-form").fire("submit");
      assert.ok(
        event.defaultPrevented,
        "the search form must cancel its own submit, or the browser navigates away",
      );
      await panel.settle();
    },

    /**
     * Drives the real sign-in form, including the PBKDF2 stretch.
     *
     * The iteration count comes from `/api/admin/auth/params`, which the stub
     * answers - so a stub that returns 1 keeps this fast without the panel
     * knowing, which is the point of the panel reading the figure from the API.
     */
    signIn: async (username = "wafi", password = "correct horse") => {
      need("login-username").value = username;
      need("login-password").value = password;
      await need("login-form").fire("submit");
      await panel.settle();
    },
  };

  return panel;
}
