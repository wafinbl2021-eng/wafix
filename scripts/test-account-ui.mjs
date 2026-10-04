// Phase 4 account-UI tests for Wafi X.
//
// WHAT IS ACTUALLY TESTED
// =======================
// Part A drives the real `src/account-client.ts` against a fake of the four Rust
// commands. Nothing in that file is re-implemented here: the point is to check
// the code the app runs, so the fake has to sit *under* it the way the Tauri IPC
// does. Its semantics are copied from `wafx-api/src/routes/account-auth.ts`, and
// the last test fails if the two drift apart.
//
// Part B is static. It asserts properties of the source that are true by
// construction rather than by behaviour: no PC Tweaker host, no session token in
// web storage, no JWT, no device binding, no polling. Those are the claims the
// phase makes, and none of them is observable from a single run.
//
// Part B parses with the TypeScript compiler and looks at identifiers and string
// literals only. Comments are trivia to the parser, so a guard here is not
// silenced by its own documentation — and equally, documentation is free to
// *mention* `fetch` or a host name in order to explain why it is not used.
//
// WHY A FAKE IPC AND NOT A REAL SERVER
// ====================================
// The client does not speak HTTP. `SameSite=Strict` cannot cross from
// `http://tauri.localhost` to the API, so Rust owns the cookie and the frontend
// only ever calls four commands. A test that stood up a server would be testing
// Rust's transport, which has its own unit tests in `src-tauri/src/account.rs`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const readOptional = (relative) =>
  fs.existsSync(path.join(root, relative)) ? read(relative) : null;

// ------------------------------------------------------------------ parsing --

/** Every TypeScript/TSX file under `src/`, as repo-relative posix paths. */
function sourceFiles(dir = path.join(root, "src")) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return found;
}

const cache = new Map();

/**
 * The identifiers and string literals a file actually contains in code.
 * Comments are not visited, so prose cannot satisfy or trip a guard.
 */
function code(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const file = ts.createSourceFile(
    relative,
    read(relative),
    ts.ScriptTarget.ES2022,
    true,
    relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const identifiers = new Set();
  const strings = [];
  const visit = (node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    if (
      ts.isStringLiteralLike(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      strings.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const result = { identifiers, strings, source: read(relative) };
  cache.set(relative, result);
  return result;
}

/** Every occurrence of `needle` anywhere in the *code* of `relative`. */
function codeHits(relative, needle) {
  const { identifiers, strings } = code(relative);
  const hits = [];
  if (identifiers.has(needle)) hits.push("identifier");
  // `identifiers.has` is exact-match; substring probes are for strings only.
  for (const value of strings) if (value.includes(needle)) hits.push(`string ${value}`);
  return hits;
}

/** Reports `needle` across every file under `src/`. */
function scanSrc(needle) {
  const found = [];
  for (const relative of sourceFiles()) {
    for (const hit of codeHits(relative, needle)) found.push(`${relative}: ${hit}`);
  }
  return found;
}

// -------------------------------------------------------------- Rust lexing --

/**
 * A Rust source file with its comments removed.
 *
 * There is no Rust parser in the tree, and the alternative — matching raw text —
 * makes a guard impossible to write honestly: this file explains at length why
 * it never sends `X-WAFI-Admin` and never sets `SameSite=None`, and a text scan
 * cannot tell that explanation apart from doing it. String literals are kept,
 * because a header name inside `header("...")` really is sent.
 */
function rustCode(relative) {
  const text = read(relative);
  let out = "";
  let state = "code";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        i++;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        i++;
        continue;
      }
      if (char === '"') {
        state = "string";
        out += char;
        continue;
      }
      out += char;
      continue;
    }
    if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += char;
      }
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        i++;
      }
      continue;
    }
    // Inside a string: copy it through, honouring escapes, so a `//` in a URL is
    // not mistaken for the start of a comment.
    out += char;
    if (char === "\\") {
      out += next ?? "";
      i++;
    } else if (char === '"') {
      state = "code";
    }
  }
  return out;
}

/**
 * A Rust file's code with its comments removed *and* its `mod tests` module
 * dropped.
 *
 * The test module is dropped because these guards are about what ships. A module
 * that asserts `"pctweaker"` must not unlock Wafi X necessarily contains the
 * string `"pctweaker"`, and a guard that read the whole file would be asserting
 * that its own test suite does not exist.
 *
 * The marker is the whole `#[cfg(test)] mod tests` pair rather than the attribute
 * alone, because production code legitimately carries test-only `#[cfg(test)]`
 * items — a `LicenseStore` constructor that exists solely so the accepting path
 * can be exercised is one — and cutting at the attribute would delete the code
 * these guards are actually about.
 */
function rustProductionCode(relative) {
  const code = rustCode(relative);
  const marker = /\#\[cfg\(test\)\]\s*mod tests\s*\{/.exec(code);
  if (marker === null) return code;
  assert.equal(
    code.match(/\#\[cfg\(test\)\]\s*mod tests\s*\{/g).length,
    1,
    `${relative} should have exactly one test module`,
  );
  return code.slice(0, marker.index);
}

// ---------------------------------------------------------------- fake world --

/** The session cookie the fake API hands out. Chosen to be greppable. */
const SESSION_TOKEN = "a1b2c3d4e5f6deadbeefcafefacedead0f1e2d3c4b5a69788011223344556677";
const SALT = "00112233445566778899aabbccddeeff";

/**
 * A stand-in for the four Rust commands.
 *
 * Models the API's actual answers, including the parts that exist to withhold
 * information: a decoy salt for an unknown address, one generic message for every
 * way a sign-in can fail, and a registration reply that never varies.
 *
 * The frontend cannot see the two requests Rust makes inside one sign-in, so
 * `loginReply` stands for the *outcome* of that pair: what Rust reports once
 * `/login` and then `/me` have both had their say.
 *
 * @param options.accounts    address -> `{ password, disabled }`
 * @param options.offline     every command rejects, as a dead network would
 * @param options.ipcFailure  a command name whose invoke rejects outright
 * @param options.me          overrides what `account_me` returns
 * @param options.loginReply  overrides what `account_login` returns
 * @param options.license     overrides what `account_license` returns. `null` (the
 *                            default) means "not Pro", which is what a signed-in
 *                            account with no grant is entitled to be told.
 * @param options.licenseFails makes `account_license` reject, as a dropped
 *                            connection or an unreachable signer would
 * @param options.licenseThrowsRaw rejects with a bare value - no `kind` - which
 *                            is what a dying IPC channel looks like
 */
function fakeApi({
  accounts = new Map(),
  offline = false,
  ipcFailure = null,
  me = null,
  loginReply = null,
  license = null,
  licenseFails = false,
  licenseThrowsRaw = null,
} = {}) {
  const calls = [];
  /** The token Rust would have replayed, and whose session it belongs to. */
  const sessions = new Map();

  /** Rust hands back a `MeOutcome`; failures travel as a rejected command. */
  const invoke = async (cmd, args = {}) => {
    calls.push(cmd);

    if (offline) throw new Error("connection refused");
    if (ipcFailure === cmd) throw new Error("channel closed");

    switch (cmd) {
      case "account_me": {
        if (me !== null) return me;
        if (sessions.size === 0) return { signed_in: false };
        const email = [...sessions.values()][0];
        return {
          signed_in: true,
          account: {
            email,
            last_login_at: "2026-01-02T03:04:05.000Z",
            expires_in_seconds: 86_400,
          },
        };
      }

      case "account_login": {
        if (loginReply !== null) return loginReply;
        const record = accounts.get(args.email);
        // Unknown address, wrong verifier and disabled account all produce the
        // same error. The client must not be able to tell them apart.
        //
        // Note this is a *resolved* value, not a rejection: `account_login` is
        // declared `-> MeOutcome`, so a refused sign-in arrives as data. Only
        // `account_register` returns a `Result` and can reject.
        if (!record || record.disabled || record.password !== args.password) {
          return { signed_in: false, error: { kind: "not_signed_in", message: "Invalid email or password" } };
        }
        sessions.set(SESSION_TOKEN, args.email);
        return {
          signed_in: true,
          account: {
            email: args.email,
            last_login_at: "2026-01-01T00:00:00.000Z",
            expires_in_seconds: 86_400,
          },
        };
      }

      case "account_register":
        // The same answer whether the address was free or taken. `ipcFailure`
        // above is the only way this rejects.
        return null;

      case "account_logout":
        sessions.clear();
        return null;

      // The entitlement conclusion, and nothing else. A real `account_license`
      // reaches the network, verifies a signature and writes a cache file before
      // producing this; none of that is the frontend's business, which is the
      // whole reason the command exists.
      case "account_license": {
        if (licenseThrowsRaw !== null) throw licenseThrowsRaw;
        if (licenseFails) throw { kind: "unreachable", message: "offline" };
        if (license !== null) return license;
        return sessions.size === 0
          ? (() => {
              throw { kind: "not_signed_in", message: "Sign in to check your Pro status." };
            })()
          : { is_pro: false };
      }

      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  };

  return { invoke, calls, sessions, salt: SALT };
}

/** Runs `body` with a fake IPC bridge and web storage installed. */
async function withWorld(world, body) {
  const saved = {
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
  };
  globalThis.window = { __TAURI_INTERNALS__: { invoke: world.invoke } };

  /** Records every write, so a test can prove nothing was written. */
  const writes = [];
  const store = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => {
        writes.push([k, v]);
        map.set(k, v);
      },
      removeItem: (k) => {
        writes.push([`remove:${k}`]);
        map.delete(k);
      },
      clear: () => map.clear(),
      key: (i) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    };
  };
  globalThis.localStorage = store();
  globalThis.sessionStorage = store();

  try {
    return await body({ writes });
  } finally {
    globalThis.window = saved.window;
    for (const name of ["localStorage", "sessionStorage"]) {
      if (saved[name] === undefined) delete globalThis[name];
      else globalThis[name] = saved[name];
    }
  }
}

const account = (email, password, disabled = false) =>
  new Map([[email, { password, disabled }]]);

/** The real client, loaded once. */
const client = await import(pathToFileURL(path.join(root, "src/account-client.ts")).href);

// -------------------------------------------------------------- A. behaviour --

test("register, then login, then /me returns the account", async () => {
  const world = fakeApi({ accounts: account("ada@example.com", "correct horse") });
  await withWorld(world, async () => {
    await client.register("ada@example.com", "correct horse");

    const state = await client.login("ada@example.com", "correct horse");
    assert.equal(state.status, "signed-in", JSON.stringify(state));
    assert.equal(state.account.email, "ada@example.com");

    const restored = await client.restoreSession();
    assert.equal(restored.status, "signed-in");
    assert.equal(restored.account.email, "ada@example.com");
    assert.equal(typeof restored.account.last_login_at, "string");
    assert.equal(typeof restored.account.expires_in_seconds, "number");
  });
});

test("the account the UI receives carries no identifier to key anything on", async () => {
  const world = fakeApi({ accounts: account("ada@example.com", "correct horse") });
  await withWorld(world, async () => {
    const state = await client.login("ada@example.com", "correct horse");
    // `/me` does return an id; Rust drops it, because nothing in the UI may key
    // Pro state off a database row.
    assert.deepEqual(Object.keys(state.account).sort(), [
      "email",
      "expires_in_seconds",
      "last_login_at",
    ]);
  });
});

test("register gives the same answer whether or not the address existed", async () => {
  const world = fakeApi({ accounts: account("taken@example.com", "pw12345678") });
  await withWorld(world, async () => {
    await assert.doesNotReject(() => client.register("brand-new@example.com", "pw12345678"));
    await assert.doesNotReject(() => client.register("taken@example.com", "pw12345678"));
  });
});

test("a wrong password is refused with the API's single generic message", async () => {
  const world = fakeApi({ accounts: account("ada@example.com", "correct horse") });
  await withWorld(world, async () => {
    const state = await client.login("ada@example.com", "wrong");
    assert.equal(state.status, "error");
    assert.equal(state.error.kind, "not_signed_in");
    // Exactly the server's wording. Rewriting it here is how the channel reopens:
    // "no such account" versus "wrong password" answers the real question.
    assert.equal(state.error.message, "Invalid email or password");
  });
});

test("an unknown address is indistinguishable from a wrong password", async () => {
  const world = fakeApi({ accounts: account("ada@example.com", "correct horse") });
  await withWorld(world, async () => {
    const unknown = await client.login("nobody@example.com", "correct horse");
    const wrong = await client.login("ada@example.com", "wrong");
    assert.equal(unknown.status, "error");
    assert.equal(wrong.status, "error");
    assert.deepEqual(
      { kind: unknown.error.kind, message: unknown.error.message },
      { kind: wrong.error.kind, message: wrong.error.message },
      "an unknown address and a bad password must be the same answer",
    );
  });
});

test("a disabled account is indistinguishable from a wrong password", async () => {
  const world = fakeApi({ accounts: account("off@example.com", "correct horse", true) });
  await withWorld(world, async () => {
    const disabled = await client.login("off@example.com", "correct horse");
    const wrong = await client.login("ada@example.com", "whatever");
    assert.deepEqual(
      { kind: disabled.error.kind, message: disabled.error.message },
      { kind: wrong.error.kind, message: wrong.error.message },
    );
  });
});

test("/me is authoritative: an account disabled mid-flight is not reported signed in", async () => {
  // Rust asks /login and then /me, and reports /me. Login can succeed and /me
  // still refuse: only /me sits behind the session guard, and only the account
  // row says whether the account is usable. So a sign-in whose `/me` disagreed
  // must come back as a failure with no account attached.
  const world = fakeApi({
    accounts: account("ada@example.com", "correct horse"),
    loginReply: { signed_in: false, error: { kind: "not_signed_in", message: "Session expired, sign in again" } },
  });
  await withWorld(world, async () => {
    const state = await client.login("ada@example.com", "correct horse");
    assert.equal(state.status, "error", "a /me refusal must not be reported as signed in");
    assert.equal(state.error.kind, "not_signed_in");
    assert.equal(state.account, undefined, "no account may be attached to a failure");
  });
});

test("a /me that answers 401 is a sign-out the user can be told about", async () => {
  const world = fakeApi({
    me: { signed_in: false, error: { kind: "not_signed_in", message: "Session expired, sign in again" } },
  });
  await withWorld(world, async () => {
    const state = await client.restoreSession();
    assert.equal(state.status, "error");
    assert.equal(state.error.kind, "not_signed_in");
  });
});

test("logout ends the session, and the next launch starts signed out", async () => {
  const world = fakeApi({ accounts: account("ada@example.com", "correct horse") });
  await withWorld(world, async () => {
    await client.login("ada@example.com", "correct horse");
    await client.logout();
    const state = await client.restoreSession();
    assert.equal(state.status, "signed-out");
    assert.equal(state.account, undefined);
    assert.equal(state.error, undefined, "being signed out is not an error");
  });
});

test("logout never throws, even when the service cannot be reached", async () => {
  await withWorld(fakeApi({ offline: true }), async () => {
    await assert.doesNotReject(() => client.logout(), "a sign-out button that can fail is worse");
  });
});

test("launching with no session is a normal signed-out state, not a fault", async () => {
  const world = fakeApi({});
  await withWorld(world, async () => {
    const state = await client.restoreSession();
    assert.equal(state.status, "signed-out");
    assert.equal(state.error, undefined);
    assert.deepEqual(world.calls, ["account_me"], "one call, and it is the session check");
  });
});

test("launching with a live session restores it", async () => {
  const world = fakeApi({ accounts: account("ada@example.com", "correct horse") });
  await withWorld(world, async () => {
    await client.login("ada@example.com", "correct horse");
    world.calls.length = 0;

    const state = await client.restoreSession();
    assert.equal(state.status, "signed-in");
    assert.equal(state.account.email, "ada@example.com");
    assert.equal(
      world.calls.length,
      1,
      `restore made ${world.calls.length} calls; there must be no polling or heartbeat`,
    );
  });
});

test("a network failure is an error, and never a sign-out", async () => {
  await withWorld(fakeApi({ offline: true }), async () => {
    const state = await client.restoreSession();
    assert.equal(state.status, "error", JSON.stringify(state));
    // The distinction that matters: `unreachable` must not be `signed-out`. A
    // laptop that was asleep mid-request is still signed in.
    assert.equal(state.error.kind, "unreachable");
    assert.notEqual(state.status, "signed-out");
  });
});

test("a failing service is an error, and never a sign-out", async () => {
  // A 5xx does not reject the command: Rust folds it into `MeOutcome.error`,
  // because "the service is down" and "your session ended" are different
  // sentences and the UI has to be able to tell them.
  const world = fakeApi({
    me: { signed_in: false, error: { kind: "server", message: "The sign-in service had a problem. Try again." } },
  });
  await withWorld(world, async () => {
    const state = await client.restoreSession();
    assert.equal(state.status, "error");
    assert.equal(state.error.kind, "server");
    assert.notEqual(state.status, "signed-out");
  });
});

test("a dead IPC channel is reported as unreachable, never as a sign-out", async () => {
  await withWorld(fakeApi({ ipcFailure: "account_me" }), async () => {
    const state = await client.restoreSession();
    assert.equal(state.status, "error");
    assert.equal(state.error.kind, "unreachable");
  });
});

test("a reply that cannot be read is an error, and never a sign-out", async () => {
  await withWorld(fakeApi({ me: { nonsense: true } }), async () => {
    const state = await client.restoreSession();
    assert.equal(state.status, "error", "a malformed reply must not be taken as signed out");
  });
});

test("the raw session token never reaches the frontend", async () => {
  const world = fakeApi({ accounts: account("ada@example.com", "correct horse") });
  await withWorld(world, async ({ writes }) => {
    const state = await client.login("ada@example.com", "correct horse");

    const serialised = JSON.stringify(state);
    assert.ok(
      !serialised.includes(SESSION_TOKEN),
      `the session token appeared in what the UI received: ${serialised}`,
    );
    for (const [key, value] of writes) {
      assert.ok(!String(value).includes(SESSION_TOKEN), `token written to ${key}`);
    }
  });
});

test("nothing is written to web storage during a whole session lifecycle", async () => {
  const world = fakeApi({ accounts: account("ada@example.com", "correct horse") });
  await withWorld(world, async ({ writes }) => {
    await client.restoreSession();
    await client.register("ada@example.com", "correct horse");
    await client.login("ada@example.com", "correct horse");
    await client.restoreSession();
    await client.logout();
    await client.restoreSession();
    assert.deepEqual(writes, [], `web storage was touched: ${JSON.stringify(writes)}`);
  });
});

test("a rejected sign-in is a transport problem, not a verdict on the password", async () => {
  // Defensive: `account_login` returns `MeOutcome`, so it should never reject.
  // If it ever did, the client must say "could not reach the service" rather
  // than imply the credentials were refused — telling someone their password is
  // wrong when the network died is both wrong and a nudge towards a retry storm.
  await withWorld(fakeApi({ ipcFailure: "account_login" }), async () => {
    const state = await client.login("ada@example.com", "correct horse");
    assert.equal(state.status, "error");
    assert.equal(state.error.kind, "unreachable");
    assert.ok(
      !/password/i.test(state.error.message) || /could not reach/i.test(state.error.message),
      `a transport failure must not read as a credential verdict: ${state.error.message}`,
    );
  });
});

test("client-side validation mirrors the API's address rule, not a stricter one", () => {
  assert.equal(client.validateCredentials("", "pw12345678"), "emailRequired");
  assert.equal(client.validateCredentials("   ", "pw12345678"), "emailRequired");
  assert.equal(client.validateCredentials("nope", "pw12345678"), "emailInvalid");
  assert.equal(client.validateCredentials("@example.com", "pw12345678"), "emailInvalid");
  assert.equal(client.validateCredentials("ada@example.com", ""), "passwordRequired");
  assert.equal(client.validateCredentials("ada@example.com", "short12"), "passwordTooShort");

  // Every rejection here is one `readEmail` also rejects, so the client can
  // never turn away an address the server would have accepted.
  for (const bad of [
    "a b@example.com",
    "ada@@example.com",
    ".ada@example.com",
    "ada.@example.com",
    "ada..b@example.com",
    "ada@-example.com",
    "ada@example.com-",
    "ada@",
    "ada@example..com",
    `ada@${"d".repeat(190)}.com`,
  ]) {
    assert.equal(client.validateCredentials(bad, "pw12345678"), "emailInvalid", `should reject ${bad}`);
  }

  // And the half that matters more: `readEmail` does not require a dot in the
  // domain, so neither does this. An earlier version required one and would
  // have made `a@example` unusable with no way to tell the user why.
  for (const good of ["ada@example.com", "a@example", "ada@sub.example.co.uk", "a@b-c.example"]) {
    assert.equal(client.validateCredentials(good, "pw12345678"), null, `should accept ${good}`);
  }

  assert.equal(
    client.validateRegistration("ada@example.com", "longenough", "other123"),
    "passwordMismatch",
  );
  assert.equal(client.validateRegistration("ada@example.com", "longenough", "longenough"), null);
});

// ------------------------------------------------- A2. entitlement behaviour --
//
// The frontend's whole involvement in Pro is one call that answers a question.
// What it must never do is *hold* an entitlement, be told one, or be handed a
// verdict it can supply for itself.

test("a signed-in account with no grant is told it is not Pro", async () => {
  const world = fakeApi({ accounts: account("ada@example.com", "correct horse") });
  await withWorld(world, async () => {
    await client.login("ada@example.com", "correct horse");
    assert.deepEqual(await client.fetchLicense(), { is_pro: false });
  });
});

test("the plan the server signed is what reaches the UI", async () => {
  for (const plan of ["pro", "lifetime"]) {
    const world = fakeApi({
      accounts: account("ada@example.com", "correct horse"),
      license: { is_pro: true, plan },
    });
    await withWorld(world, async () => {
      await client.login("ada@example.com", "correct horse");
      const licence = await client.fetchLicense();
      assert.equal(licence.is_pro, true);
      assert.equal(licence.plan, plan);
    });
  }
});

test("a failed licence check rejects rather than reporting not-Pro", async () => {
  // The distinction the whole design turns on. Returning `{ is_pro: false }` on
  // error would make one dropped connection indistinguishable from a cancelled
  // subscription, and the caller would overwrite a good answer with it.
  const world = fakeApi({
    accounts: account("ada@example.com", "correct horse"),
    licenseFails: true,
  });
  await withWorld(world, async () => {
    await client.login("ada@example.com", "correct horse");
    await assert.rejects(
      () => client.fetchLicense(),
      (reason) => {
        assert.equal(reason.kind, "unreachable");
        return true;
      },
      "a check that could not run must not come back as a negative answer",
    );
  });
});

test("a licence is refused when nobody is signed in", async () => {
  await withWorld(fakeApi(), async () => {
    await assert.rejects(
      () => client.fetchLicense(),
      (reason) => {
        assert.equal(reason.kind, "not_signed_in");
        return true;
      },
    );
  });
});

test("a licence failure with no error shape still rejects", async () => {
  // The second branch of `fetchLicense`'s catch: a rejection that carries no
  // `kind` at all, which is what an IPC channel dying mid-call looks like. It
  // must still be an error - there is no path through this function that turns a
  // failure into `{ is_pro: false }`.
  const world = fakeApi({
    accounts: account("ada@example.com", "correct horse"),
    licenseThrowsRaw: "the channel closed",
  });
  await withWorld(world, async () => {
    await client.login("ada@example.com", "correct horse");
    await assert.rejects(
      () => client.fetchLicense(),
      (reason) => {
        assert.equal(reason.kind, "unreachable");
        return true;
      },
    );
  });
});

test("nothing a licence call returns could be replayed or re-verified", async () => {
  // Two fields. If a signed payload, a signature or an account id ever crossed
  // this boundary they would be in webview memory, where a script could read and
  // replay them - so the assertion is on the exact key set, not on a comment.
  const world = fakeApi({
    accounts: account("ada@example.com", "correct horse"),
    license: {
      is_pro: true,
      plan: "lifetime",
      payload_json: `{"userId":"acct-1","isPro":true,"plan":"lifetime","product":"wafix"}`,
      signature: "AAAA",
      user_id: "acct-1",
      product: "wafix",
      issued_at: 1,
      expires_at: null,
    },
  });
  await withWorld(world, async () => {
    await client.login("ada@example.com", "correct horse");
    assert.deepEqual(Object.keys(await client.fetchLicense()).sort(), ["is_pro", "plan"]);
  });
});

test("a plan this build does not understand never reaches the UI", async () => {
  // `plan_of` fails closed on the Rust side, so this cannot happen in production.
  // Asserted anyway: it is the last point where a strange value from elsewhere
  // could become state, and some later `auth.plan === "lifetime"` must not be
  // one `switch` away from matching it.
  for (const hostile of ["monthly", "LIFETIME", "lifetime ", "", 42, null, { toString: () => "lifetime" }]) {
    const world = fakeApi({
      accounts: account("ada@example.com", "correct horse"),
      license: { is_pro: true, plan: hostile },
    });
    await withWorld(world, async () => {
      await client.login("ada@example.com", "correct horse");
      const licence = await client.fetchLicense();
      assert.equal(licence.is_pro, true, `is_pro should survive a bad plan: ${String(hostile)}`);
      assert.ok(
        licence.plan === undefined || licence.plan === "lifetime",
        `plan must be dropped, got ${JSON.stringify(licence.plan)}`,
      );
    });
  }
});

test("a non-boolean is_pro is treated as not-Pro, never as truthy", async () => {
  for (const hostile of ["true", 1, {}, [], null, undefined]) {
    const world = fakeApi({
      accounts: account("ada@example.com", "correct horse"),
      license: { is_pro: hostile, plan: "lifetime" },
    });
    await withWorld(world, async () => {
      await client.login("ada@example.com", "correct horse");
      assert.deepEqual(
        await client.fetchLicense(),
        { is_pro: false },
        `is_pro: ${JSON.stringify(hostile)} must not read as Pro`,
      );
    });
  }
});

// ------------------------------------------------------------ B. static claims --

test("the session cookie is encrypted to the Windows user, and nothing else", () => {
  const source = read("src-tauri/src/account.rs");
  assert.match(source, /CryptProtectData/, "the cookie must be DPAPI-protected");
  assert.match(source, /CryptUnprotectData/, "and it must be readable again on the next launch");
  assert.ok(
    !/CRYPTPROTECT_LOCAL_MACHINE/.test(source),
    "CRYPTPROTECT_LOCAL_MACHINE must never appear: it would leave the cookie readable by any user on the machine",
  );
});

test("Rust declares an Origin and never the admin header", () => {
  const source = rustCode("src-tauri/src/account.rs");
  assert.match(source, /\.header\("origin"/, "requireAccountOrigin refuses a request without one");
  assert.ok(
    !/x-wafi-admin/i.test(source),
    "X-WAFI-Admin must never be sent on an account route; see middleware/csrf.ts",
  );
});

test("the account transport never weakens the cookie's SameSite", () => {
  const source = rustCode("src-tauri/src/account.rs");
  assert.ok(
    !/SameSite\s*=\s*None/i.test(source),
    "SameSite=None would remove one of the three CSRF layers to make the webview work",
  );
});

test("the account transport binds nothing to the machine", () => {
  const source = rustCode("src-tauri/src/account.rs");
  for (const forbidden of [
    "MachineGuid",
    "GetComputerName",
    "hwid",
    "machine_id",
    "install_id",
    "device_id",
  ]) {
    assert.ok(
      !new RegExp(forbidden, "i").test(source),
      `${forbidden} must not appear in the account transport`,
    );
  }
});

test("Rust persists the session cookie it will replay, byte for byte", () => {
  const source = rustCode("src-tauri/src/account.rs");
  // Two functions, one string. If the persisted form and the sent form can
  // differ, the session works once and then silently 401s.
  assert.match(source, /fn save_session\(/);
  assert.match(source, /fn load_session\(/);
  assert.match(source, /fn request_cookie\(/);
  assert.match(source, /\.header\("cookie", cookie\)/, "the replayed cookie must be the built one");
});

test("the account client has no HTTP and no web storage of its own", () => {
  const relative = "src/account-client.ts";
  for (const forbidden of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon"]) {
    assert.deepEqual(codeHits(relative, forbidden), [], `${forbidden} in ${relative}: Rust owns the transport`);
  }
  for (const forbidden of ["localStorage", "sessionStorage", "Authorization", "Bearer", "jwt"]) {
    assert.deepEqual(codeHits(relative, forbidden), [], `${forbidden} in ${relative}`);
  }
});

test("no PC Tweaker host survives anywhere in the client", () => {
  const found = [...scanSrc("api.pctweaker.app"), ...scanSrc("pctweaker.app/support")];
  assert.deepEqual(found, [], `PC Tweaker hosts still referenced in code:\n${found.join("\n")}`);
});

test("no PC Tweaker host survives in the webview's content security policy", () => {
  const conf = read("src-tauri/tauri.conf.json");
  assert.ok(!/pctweaker/.test(conf), "connect-src must not name a PC Tweaker origin");
  // The worker must still be allowed, or nothing works and the failure looks
  // like a network problem rather than a policy one.
  assert.match(conf, /connect-src[^"]*https:\/\/wafx-api\.wafinbl2021\.workers\.dev/);
});

test("the account base URL has no PC Tweaker default", () => {
  const declaration = read("src/lib.ts").match(/export const API_BASE_URL = [^;]+;/);
  assert.ok(declaration, "API_BASE_URL should still be declared for the Pro paths");
  assert.ok(
    !/pctweaker/i.test(declaration[0]),
    `API_BASE_URL still defaults to a PC Tweaker host: ${declaration[0]}`,
  );
});

test("error reporting is inert rather than pointed at another product's server", () => {
  const source = read("src/lib.ts");
  const body = source.match(/export function reportError\([^)]*\)\s*{([\s\S]*?)\n}/);
  assert.ok(body, "reportError should still exist so its callers keep working");
  assert.ok(!/fetch\(|XMLHttpRequest/.test(body[1]), "reportError must not send anything");
  assert.ok(!/api\/error-reports/.test(body[1]), "reportError must not name a PC Tweaker route");
  // The opt-in toggle is untouched: the key, the reader and the flag all stay.
  assert.match(source, /export const ERROR_REPORTS_KEY = "wafix-error-reports";/);
  assert.match(source, /export function errorReportsEnabled\(\)/);
});

test("legacy session tokens are deleted, and nothing writes them", () => {
  const lib = read("src/lib.ts");
  assert.match(lib, /export function purgeLegacySession\(\)/);
  // Only `removeItem` is allowed on those two keys. A `setItem` would resurrect
  // the very credential the purge exists to destroy.
  assert.ok(!/setItem\(\s*LEGACY_(TOKEN|EMAIL)_KEY/.test(lib), "a legacy key is being written again");
  assert.ok(!/export function storeSession\b/.test(lib), "storeSession should be gone entirely");
  assert.ok(!/export function readToken\b/.test(lib), "readToken should be gone entirely");
  assert.match(read("src/App.tsx"), /purgeLegacySession\(\)/, "the purge must run on launch");
});

test("no bearer token or JWT reaches the frontend", () => {
  const found = [...scanSrc("Authorization"), ...scanSrc("Bearer")];
  for (const needle of ["jwt", "eyJ"]) {
    for (const relative of sourceFiles()) {
      if (code(relative).identifiers.has(needle)) found.push(`${relative}: ${needle}`);
      for (const value of code(relative).strings) {
        if (value.includes(needle)) found.push(`${relative}: string ${value}`);
      }
    }
  }
  assert.deepEqual(found, [], `token-shaped client code:\n${found.join("\n")}`);
});

test("nothing binds the account to a machine, an install, or a telemetry sink", () => {
  const found = [];
  for (const needle of [
    "MachineGuid",
    "GetComputerName",
    "hwid",
    "machine_id",
    "install_id",
    "device_id",
    "sendBeacon",
    "EventSource",
  ]) {
    found.push(...scanSrc(needle));
  }
  assert.deepEqual(found, [], `machine or telemetry coupling:\n${found.join("\n")}`);
});

test("the account session is checked once per launch, with no focus or interval refresh", () => {
  const app = read("src/App.tsx");
  assert.ok(
    !/addEventListener\("focus"/.test(app),
    "a focus listener would re-check the session every time the window is touched",
  );
  assert.ok(
    !/setInterval\([^)]*refreshAccount/.test(app),
    "an interval would be a heartbeat nobody agreed to",
  );
  const callSites = app.match(/refreshAccount\(\);/g) ?? [];
  assert.equal(
    callSites.length,
    1,
    `expected exactly one call site (on mount), found ${callSites.length}: ${callSites.length} calls means polling`,
  );
});

test("a failed session check does not clear a signed-in account", () => {
  const app = read("src/App.tsx");
  // Only `not_signed_in` means signed out. `unreachable`, `server` and
  // `rate_limited` must leave whatever was already known alone, or a flaky
  // network silently discards a good session and its cached licence with it.
  assert.match(
    app,
    /if \(state\.error\.kind === "not_signed_in"\) setAuth\(\{ status: "anonymous" \}\)/,
    "the sign-out must be gated on the server having said so",
  );
});

test("the account state has a loading phase, so launch cannot flash signed-out", () => {
  assert.match(read("src/types.ts"), /\|\s*\{\s*status: "loading"\s*\}/, "AuthState needs a loading variant");
  assert.match(
    read("src/App.tsx"),
    /useState<AuthState>\(\{ status: "loading" \}\)/,
    "the app must start in loading, not in a guessed state",
  );
});

test("the Tweaky Driver promo is gone, and nothing points at it", () => {
  assert.equal(
    readOptional("src/components/tweaky-driver-promo.tsx"),
    null,
    "the card links to AurelioAvila/Tweaky-Driver-Releases and must not exist in Wafi X",
  );
  const found = [];
  for (const needle of ["tweaky-driver-promo", "AurelioAvila/Tweaky", "tweakyDriverPromo"]) {
    found.push(...scanSrc(needle));
  }
  for (const relative of sourceFiles()) {
    if (code(relative).identifiers.has("TweakyDriverPromo")) found.push(`${relative}: TweakyDriverPromo`);
  }
  assert.deepEqual(found, [], `dangling references:\n${found.join("\n")}`);
});

test("the account screen asks for three fields, and no name or date of birth", () => {
  const relative = "src/components/account.tsx";
  for (const forbidden of [
    "firstName",
    "lastName",
    "dateOfBirth",
    "forgotPassword",
    "resendVerification",
    "rememberMe",
  ]) {
    assert.deepEqual(
      codeHits(relative, forbidden),
      [],
      `${forbidden} in ${relative}: accounts has no column for it, and 1.0.0 has no mail to send`,
    );
  }
  assert.ok(
    code(relative).identifiers.has("confirmPassword"),
    "registration must ask for a confirmation",
  );
});

test("the fake API still matches the real contract", () => {
  // Guards the fake against drifting from `wafx-api`. If the route changes
  // shape, this fails here rather than as a mysterious behavioural failure.
  const route = read("wafx-api/src/routes/account-auth.ts");
  assert.match(route, /"Invalid email or password"/, "the generic sign-in message changed");
  assert.match(route, /last_login_at: account\.last_login_at === null \? null/, "/me still reports last sign-in");
  assert.match(route, /expires_in_seconds: session\.expiresInSeconds/, "/me still reports remaining TTL");
  assert.match(route, /BAD_CREDENTIALS\.code, BAD_CREDENTIALS\.message/, "sign-in still refuses with that error");
  assert.match(read("src-tauri/src/account.rs"), /params\.iterations/, "Rust still derives the verifier");
});

test("the licence route still exists, and is still behind the account session", () => {
  // The fake above models `GET /api/license`. If the route were renamed, deleted
  // or moved out from under the session guard, the licence tests above would keep
  // passing against a fiction.
  const route = read("wafx-api/src/routes/license.ts");
  assert.match(route, /licenseRoutes\.get\("\/license"/, "GET /api/license is the entitlement route");
  assert.match(route, /signEntitlement\(c\.env, \{/, "it signs, rather than assembling an answer itself");

  const index = read("wafx-api/src/index.ts");
  assert.match(
    index,
    /app\.route\("\/api", mount\(licenseRoutes, accountOrigin, requireAccount\(\)\)\)/,
    "the licence route is mounted behind the account session, not the admin header",
  );
  assert.match(index, /GET {4}\/api\/license +signed Pro entitlement/, "and is documented as an account route");

  const signing = read("wafx-api/src/license-signing.ts");
  // The exact string that was signed, plus its signature - never a re-serialised
  // copy of it, which is the failure mode the Rust side is built to refuse.
  assert.match(signing, /payloadJson: string;/, "the reply carries the signed bytes verbatim");
  assert.match(signing, /signature: string;/, "and the signature over those bytes");
  assert.match(signing, /LICENSE_PRODUCT_ID = "wafix"/, "the signer stamps the Wafi X product id");
  assert.match(
    signing,
    /name: "Ed25519"/,
    "entitlements are signed with the runtime's own Ed25519 rather than a vendored library",
  );
});

test("the app verifies Wafi X entitlements, and not PC Tweaker ones", () => {
  const source = rustProductionCode("src-tauri/src/license.rs");
  assert.match(
    source,
    /const PRODUCT_ID: &str = "wafix";/,
    "the product a signed entitlement must name",
  );
  assert.ok(
    !source.includes("pctweaker"),
    "the shipped verifier must not contain the previous product id at all",
  );
  assert.match(
    source,
    /const PUBLIC_KEY_B64: &str = "4jUlZ5JNP319el\/bpOx9qHcS2zbhBhFFM7dSee3TPqc=";/,
    "the Wafi X licence key, and only that one",
  );
  // The legacy shape: a missing `product` was read as "assume PC Tweaker", so a
  // field an attacker could strip decided the product for them.
  assert.ok(
    !/unwrap_or\(PRODUCT_ID\)/.test(source),
    "the missing-product fallback must be gone, not merely unused",
  );
  assert.match(source, /pub product: String,/, "product is a required field");
  assert.ok(
    !/pub product: Option<String>/.test(source),
    "an Option would make an absent product parseable again",
  );
});

test("the entitlement is bound to an account, and only an account", () => {
  const source = rustProductionCode("src-tauri/src/license.rs");
  assert.match(source, /WrongAccount/, "a licence for another account is its own error");
  // The call site, not just the comparison. A helper that exists but is never
  // invoked passes every grep over this file and grants Pro to any signed-in
  // account that fetches somebody else's licence.
  assert.match(
    source,
    /if !is_for_account\(&payload, account_id\) \{\s*return Err\(VerifyError::WrongAccount\);/,
    "the product check must be followed by one that refuses a licence for another account",
  );
  assert.match(
    source,
    /fn is_for_account\(payload: &LicensePayload, account_id: &str\) -> bool \{\s*!account_id\.is_empty\(\) && payload\.user_id == account_id/,
    "and the comparison itself must be on the payload's account, with no empty-string wildcard",
  );
  assert.match(
    source,
    /load_account_id/,
    "the signed-in id is resolved from the Rust side, not taken from a caller",
  );
});

test("nothing in the entitlement path is bound to a machine", () => {
  // Pro follows the account. A hardware id would make a licence stop working on a
  // new PC, and would put a stable device identifier into a signed format - a far
  // larger decision than "check a signature".
  const source = rustProductionCode("src-tauri/src/license.rs").toLowerCase();
  for (const forbidden of [
    "hwid",
    "machineguid",
    "getcomputername",
    "machine_id",
    "machineid",
    "device_id",
    "deviceid",
    "install_id",
    "installid",
    "hostname",
    "user_agent",
    "useragent",
    "wmic",
  ]) {
    assert.ok(!source.includes(forbidden), `\`${forbidden}\` must not appear in the entitlement path`);
  }
});

test("the signed-in account id stays on the Rust side of IPC", () => {
  // It has to be readable to bind a licence, and it must not be readable by the
  // webview: an id in web storage is a stable handle onto someone's account.
  assert.deepEqual(
    codeHits("src/account-client.ts", "user_id"),
    [],
    "the frontend has no business with an account id",
  );
  assert.ok(
    !scanSrc("payload_json").length && !scanSrc("payloadJson").length,
    "no signed payload may be handed to the frontend",
  );
  // Exactly the three fields the UI needs. Enumerated rather than "must not
  // contain an id", because a fourth field is just as likely to be the leak.
  const view = /pub struct AccountView \{([^}]*)\}/.exec(rustCode("src-tauri/src/account.rs"));
  assert.ok(view, "AccountView is the type that crosses IPC");
  assert.deepEqual(
    [...view[1].matchAll(/pub (\w+):/g)].map((m) => m[1]).sort(),
    ["email", "expires_in_seconds", "last_login_at"],
    "AccountView's fields are a closed set, and none of them is an identifier",
  );

  // Rust writes a sidecar and clears it with the session, so the two cannot drift.
  const account = rustCode("src-tauri/src/account.rs");
  assert.match(account, /fn save_account_id\(/, "Rust records the signed-in account id");
  assert.match(account, /fn forget_account\(/, "and forgets it wherever the session is dropped");
  assert.match(
    account,
    /fn forget_account\([^)]*\) \{[\s\S]*?save_session\(dir, None\);[\s\S]*?save_account_id\(dir, None\);/,
    "the cookie and the id are cleared together or not at all",
  );
});

test("the webview cannot hand a licence to the verifier", () => {
  // `save_license` took a signed response *from* the renderer and cached it,
  // which put a write path in front of the one check this app has. `account_license`
  // fetches in Rust and returns only the conclusion, so there is no such path.
  for (const relative of [
    "src-tauri/src/lib.rs",
    "src-tauri/src/ipc_commands.rs",
    "src-tauri/permissions/desktop.toml",
  ]) {
    assert.deepEqual(codeHits(relative, "save_license"), [], `save_license is gone from ${relative}`);
    assert.match(read(relative), /account_license|account-license/, `account_license is registered in ${relative}`);
  }
  assert.deepEqual(codeHits("src-tauri/src/license.rs", "save_license"), [], "and is not defined any more");
  assert.deepEqual(
    scanSrc("save_license"),
    [],
    "the frontend must not even name the command, let alone call it",
  );
  // The fetch happens in Rust, from the cookie the webview cannot see.
  assert.match(
    rustProductionCode("src-tauri/src/license.rs"),
    /"\/api\/license"/,
    "Rust performs the licence fetch",
  );
  assert.deepEqual(
    scanSrc("/api/license"),
    [],
    "the frontend must not fetch the licence route itself",
  );
});
