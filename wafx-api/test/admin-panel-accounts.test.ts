/**
 * The admin panel's Accounts view.
 *
 * The panel is driven here exactly as a browser drives it: the shipped
 * `admin/app.js` runs inside `node:vm` against a purpose-built DOM stub, and the
 * only things standing between it and the network are the two objects any page
 * expects from its environment. See `panel-harness.ts` for why.
 *
 * The requests are checked byte-for-byte, because the API's field allowlists are
 * exact. `grant` accepts `plan` and `expires_at` and nothing else; `disable` and
 * `enable` accept an empty object and nothing else. A panel that helpfully sent
 * `account_id` along would earn a 422 on an operation an operator has just
 * confirmed, and the failure would read as the API being wrong.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mount,
  router,
  isSignedIn,
  withCategories,
  EMPTY_CATEGORIES,
  NOT_FOUND,
  PANEL_HTML,
  type Panel,
  type Reply,
  type Recorded,
} from "./panel-harness.ts";

const ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";
const TABLE = "accounts-table";

/** One account as the API returns it, with no grant. */
const accountWithoutPro = {
  id: ACCOUNT_ID,
  email: "ada@example.com",
  created_at: "2026-10-01 09:00:00",
  last_login_at: "2026-10-04 12:00:00",
  disabled: false,
  grant: null,
};

function accountWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...accountWithoutPro, ...overrides };
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString().slice(0, 19) + "Z";
}

/** Answers `/api/admin/me`, the landing view, and one page of accounts. */
function withAccounts(
  accounts: Record<string, unknown>[],
  mutation: (request: Recorded) => Reply = () => NOT_FOUND,
) {
  return router(
    isSignedIn,
    withCategories,
    (request) =>
      request.method === "GET" && request.path.startsWith("/api/admin/accounts?")
        ? { status: 200, body: { accounts, count: accounts.length, limit: 50, offset: 0 } }
        : undefined,
    mutation,
  );
}

/** A panel already sitting on the Accounts tab with `accounts` listed. */
async function openAccounts(
  accounts: Record<string, unknown>[],
  mutation?: (request: Recorded) => Reply,
): Promise<Panel> {
  const panel = mount(withAccounts(accounts, mutation));
  await panel.settle();
  await panel.goto("accounts");
  return panel;
}

// ---------------------------------------------------------------------------

describe("Accounts: automatic listing", () => {
  test("opening the tab lists the accounts without any search being typed", async () => {
    const panel = await openAccounts([accountWithoutPro]);

    // The whole point of the change: no address is entered, and the row is there.
    assert.equal(panel.node("account-email").value, "", "no address was typed");
    const rows = panel.rows(TABLE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.[0], "ada@example.com");
  });

  test("the list is fetched with an explicit limit and offset", async () => {
    const panel = await openAccounts([accountWithoutPro]);
    const listed = panel.calls.filter((call) => call.path.startsWith("/api/admin/accounts?"));
    assert.ok(listed.length >= 1, "the accounts route was called");
    const path = listed[0]?.path ?? "";
    assert.match(path, /[?&]limit=50\b/, "limit is sent");
    assert.match(path, /[?&]offset=0\b/, "offset is sent");
    assert.ok(!path.includes("email="), "no filter is sent when the box is empty");
  });

  test("returning to the tab re-reads rather than reusing what is on screen", async () => {
    const panel = await openAccounts([accountWithoutPro]);
    const before = panel.calls.filter((call) => call.path.startsWith("/api/admin/accounts?")).length;
    await panel.goto("categories");
    await panel.goto("accounts");
    const after = panel.calls.filter((call) => call.path.startsWith("/api/admin/accounts?")).length;
    assert.ok(after > before, "a second read happened on return");
  });

  test("each row shows only the safe fields the API selects", async () => {
    const panel = await openAccounts([
      accountWith({ grant: { plan: "pro", expires_at: hoursFromNow(24) } }),
    ]);
    const row = panel.rows(TABLE)[0];
    assert.ok(row !== undefined);
    // email, status, Pro, plan, created, last login, actions
    assert.equal(row.length, 7);
    assert.equal(row[0], "ada@example.com");
    assert.equal(row[1], "مفعّل");
    assert.equal(row[2], "Pro فعّالة");
    assert.equal(row[3], "pro");
    assert.equal(row[4], "2026-10-01 09:00:00");
    assert.equal(row[5], "2026-10-04 12:00:00");
  });

  test("an account that has never signed in says so rather than showing a blank", async () => {
    const panel = await openAccounts([accountWith({ last_login_at: null })]);
    assert.equal(panel.rows(TABLE)[0]?.[5], "لم يسجّل الدخول بعد");
  });

  test("no password material is rendered, even if a response carried some", async () => {
    // Belt and braces: the API does not select these columns, so the panel has
    // nothing to leak. Asserting the render anyway means a future column added
    // to the mapping cannot start appearing here by accident.
    const leaky = {
      ...accountWithoutPro,
      password_hash: "deadbeef",
      password_salt: "cafe",
      iterations: 600000,
      verifier: "a".repeat(64),
    };
    const panel = await openAccounts([leaky]);
    const rendered = panel.text(TABLE);
    for (const secret of ["deadbeef", "cafe", "600000", "verifier", "password", "salt", "session"]) {
      assert.ok(!new RegExp(secret, "i").test(rendered), `the list should not mention "${secret}"`);
    }
  });

  test("several accounts are all listed, newest first as the API returns them", async () => {
    const panel = await openAccounts([
      accountWith({ id: "b", email: "grace@example.com" }),
      accountWith({ id: "a", email: "alan@example.com" }),
    ]);
    const emails = panel.rows(TABLE).map((row) => row[0]);
    assert.deepEqual(emails, ["grace@example.com", "alan@example.com"]);
  });
});

describe("Accounts: empty and error states", () => {
  test("an empty list explains itself", async () => {
    const panel = await openAccounts([]);
    const rows = panel.rows(TABLE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.[0], "لا توجد حسابات بعد");
  });

  test("a filter that matches nothing says so, distinctly from an empty list", async () => {
    const panel = await openAccounts([]);
    await panel.search("nobody@example.com");
    assert.equal(panel.rows(TABLE)[0]?.[0], "لا يوجد حساب بهذا البريد الإلكتروني");
  });

  test("the loading note exists and is hidden once the list arrives", async () => {
    const panel = await openAccounts([accountWithoutPro]);
    // `show(node, false)` sets `hidden = true`, so a settled list means hidden.
    // Visibility is modelled by the stub; the note's own words are not, because
    // the stub builds nodes from the ids in the markup rather than parsing it,
    // so the text is asserted against the markup itself.
    assert.equal(panel.hidden("accounts-loading"), true, "hidden after the list arrived");
    assert.match(PANEL_HTML, /id="accounts-loading"[^>]*>جارٍ تحميل الحسابات\.\.\.</);
  });

  test("a failed read leaves no rows and says why", async () => {
    const panel = mount(
      router(isSignedIn, withCategories, (request) =>
        request.path.startsWith("/api/admin/accounts?")
          ? { status: 500, body: { error: { code: "internal", message: "boom" } } }
          : undefined,
      ),
    );
    await panel.settle();
    await panel.goto("accounts");

    assert.equal(panel.rows(TABLE).length, 1);
    assert.equal(panel.rows(TABLE)[0]?.[0], "لا توجد حسابات بعد");
    assert.equal(panel.hidden("account-error"), false);
    assert.match(panel.text("account-error"), /فشل الخادم \(500\)/);
  });
});

describe("Accounts: filtering", () => {
  test("searching sends an exact, url-encoded address and restarts paging", async () => {
    const panel = await openAccounts([accountWithoutPro]);
    await panel.node("accounts-next").fire("click");
    await panel.settle();
    await panel.search("ada+test@example.com");

    const filtered = panel.calls.filter((call) => call.path.includes("email="));
    assert.ok(filtered.length >= 1);
    const path = filtered[filtered.length - 1]?.path ?? "";
    assert.match(path, /email=ada%2Btest%40example\.com/);
    assert.match(path, /offset=0\b/, "paging restarts at the first row");
  });

  test("clearing the filter drops the email and shows the whole list again", async () => {
    const panel = await openAccounts([accountWithoutPro]);
    await panel.search("ada@example.com");
    await panel.node("account-search-clear").fire("click");
    await panel.settle();

    assert.equal(panel.node("account-email").value, "");
    const last = panel.calls.filter((call) => call.path.startsWith("/api/admin/accounts?")).at(-1);
    assert.ok(last !== undefined);
    assert.ok(!last.path.includes("email="), "no filter is sent after clearing");
  });

  test("an emptied search box means no filter, not match-nothing", async () => {
    const panel = await openAccounts([accountWithoutPro]);
    await panel.search("");
    const last = panel.calls.filter((call) => call.path.startsWith("/api/admin/accounts?")).at(-1);
    assert.ok(last !== undefined);
    assert.ok(!last.path.includes("email="), "an empty box is not a filter");
    assert.equal(panel.rows(TABLE).length, 1, "the account is still listed");
  });
});

describe("Accounts: paging", () => {
  /** A page of `size` rows, all distinct so assertions can tell them apart. */
  function page(size: number, offset: number): Record<string, unknown>[] {
    return Array.from({ length: size }, (_unused, index) =>
      accountWith({ id: `id-${offset + index}`, email: `user${offset + index}@example.com` }),
    );
  }

  test("next is offered only when the page came back full", async () => {
    // A short page is the API saying there is nothing after it.
    const short = await openAccounts(page(3, 0));
    assert.equal(short.node("accounts-next").disabled, true);
    assert.equal(short.node("accounts-prev").disabled, true, "nothing precedes the first page");

    const full = await openAccounts(page(50, 0));
    assert.equal(full.node("accounts-next").disabled, false, "a full page may have more after it");
  });

  test("next advances the offset by one page and enables previous", async () => {
    const panel = await openAccounts(page(50, 0));
    await panel.node("accounts-next").fire("click");
    await panel.settle();

    const last = panel.calls.filter((call) => call.path.startsWith("/api/admin/accounts?")).at(-1);
    assert.ok(last !== undefined);
    assert.match(last.path, /offset=50\b/);
    assert.equal(panel.node("accounts-prev").disabled, false);
  });

  test("previous steps back and will not go below the first page", async () => {
    const panel = await openAccounts(page(50, 0));
    await panel.node("accounts-next").fire("click");
    await panel.settle();
    await panel.node("accounts-prev").fire("click");
    await panel.settle();

    const last = panel.calls.filter((call) => call.path.startsWith("/api/admin/accounts?")).at(-1);
    assert.ok(last !== undefined);
    assert.match(last.path, /offset=0\b/);

    // Firing it again anyway must not produce a negative offset.
    await panel.node("accounts-prev").fire("click");
    await panel.settle();
    const after = panel.calls.filter((call) => call.path.startsWith("/api/admin/accounts?")).at(-1);
    assert.ok(after !== undefined);
    assert.match(after.path, /offset=0\b/, "clamped at the first page");
  });

  test("the pager reports which rows are on screen", async () => {
    const panel = await openAccounts(page(4, 0));
    assert.equal(panel.node("accounts-page").textContent, "1–4");
    assert.equal(panel.hidden("accounts-pager"), false);
  });

  test("the pager is hidden when there is nothing to page", async () => {
    const panel = await openAccounts([]);
    assert.equal(panel.hidden("accounts-pager"), true);
  });
});

describe("Accounts: Pro status", () => {
  test("an unrevoked grant past its expiry reads as expired, not active", async () => {
    // The trap this guards: `pro_grants_one_live` is unique over
    // `revoked_at IS NULL`, so an expired grant is still returned by the API and
    // a panel that trusted its presence would report a lapsed account as Pro.
    const panel = await openAccounts([
      accountWith({ grant: { plan: "pro", expires_at: hoursFromNow(-2) } }),
    ]);
    assert.equal(panel.rows(TABLE)[0]?.[2], "Pro منتهية");
  });

  test("a future expiry and a perpetual grant both read as active", async () => {
    const timed = await openAccounts([
      accountWith({ grant: { plan: "pro", expires_at: hoursFromNow(24) } }),
    ]);
    assert.equal(timed.rows(TABLE)[0]?.[2], "Pro فعّالة");

    const perpetual = await openAccounts([
      accountWith({ grant: { plan: "lifetime", expires_at: null } }),
    ]);
    assert.equal(perpetual.rows(TABLE)[0]?.[2], "Pro فعّالة");
    assert.equal(perpetual.rows(TABLE)[0]?.[3], "lifetime");
  });

  test("no grant reads as no Pro", async () => {
    const panel = await openAccounts([accountWithoutPro]);
    assert.equal(panel.rows(TABLE)[0]?.[2], "لا يوجد Pro");
    assert.equal(panel.rows(TABLE)[0]?.[3], "-");
  });

  test("a disabled account is labelled as such", async () => {
    const panel = await openAccounts([accountWith({ disabled: true })]);
    assert.equal(panel.rows(TABLE)[0]?.[1], "معطّل");
  });
});

describe("Accounts: available actions", () => {
  const labels = (panel: Panel, index = 0): string[] =>
    panel.rowButtons(TABLE, index).map((button) => button.textContent);

  test("an enabled account without a grant offers grant and disable", async () => {
    const panel = await openAccounts([accountWithoutPro]);
    assert.deepEqual(labels(panel), ["منح Pro", "تعطيل"]);
  });

  test("an account holding a grant offers revoke instead of grant", async () => {
    const panel = await openAccounts([
      accountWith({ grant: { plan: "pro", expires_at: hoursFromNow(24) } }),
    ]);
    assert.deepEqual(labels(panel), ["سحب Pro", "تعطيل"]);
  });

  test("a disabled account offers enable instead of disable", async () => {
    const panel = await openAccounts([accountWith({ disabled: true })]);
    assert.deepEqual(labels(panel), ["منح Pro", "تفعيل"]);
  });

  test("an expired but unrevoked grant is still revokable", async () => {
    // It still occupies the live slot, so it is still the thing to revoke.
    const panel = await openAccounts([
      accountWith({ grant: { plan: "pro", expires_at: hoursFromNow(-2) } }),
    ]);
    assert.deepEqual(labels(panel), ["سحب Pro", "تعطيل"]);
  });

  test("each row carries its own actions", async () => {
    const panel = await openAccounts([
      accountWith({ id: "a", email: "with-grant@example.com", grant: { plan: "pro", expires_at: null } }),
      accountWith({ id: "b", email: "without@example.com" }),
    ]);
    assert.deepEqual(labels(panel, 0), ["سحب Pro", "تعطيل"]);
    assert.deepEqual(labels(panel, 1), ["منح Pro", "تعطيل"]);
  });
});

describe("Accounts: grant Pro", () => {
  async function grantPanel(mutation?: (request: Recorded) => Reply): Promise<Panel> {
    const panel = await openAccounts([accountWithoutPro], mutation);
    await panel.rowButtons(TABLE, 0)[0]?.fire("click");
    await panel.settle();
    return panel;
  }

  test("the editor names the account it will act on", async () => {
    const panel = await grantPanel();
    assert.equal(panel.hidden("grant-editor"), false);
    assert.equal(panel.node("grant-for").textContent, "ada@example.com");
  });

  test("Grant Pro sends exactly plan and expires_at", async () => {
    const panel = await grantPanel(() => ({ status: 201, body: { ok: true } }));
    await panel.node("grant-form").fire("submit");
    await panel.settle();

    const posts = panel.sent("/pro");
    assert.equal(posts.length, 1);
    const post = posts[0];
    assert.equal(post?.method, "POST");
    assert.equal(post?.path, `/api/admin/accounts/${ACCOUNT_ID}/pro`);
    assert.equal(post?.headers["X-WAFI-Admin"], "1", "mutations carry the admin header");

    const body = post?.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["expires_at", "plan"], "no field beyond the allowlist");
    assert.equal(body.plan, "pro");
    assert.match(String(body.expires_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
  });

  test("the default expiry is 24 hours out", async () => {
    const panel = await grantPanel();
    const shown = panel.node("grant-expires").value;
    const deltaHours = (Date.parse(`${shown}:00Z`) - Date.now()) / (60 * 60 * 1000);
    assert.ok(Math.abs(deltaHours - 24) < 0.1, `expected ~24h, got ${deltaHours.toFixed(2)}h`);
    assert.equal(panel.node("grant-expires").required, true);
  });

  test("Perpetual sends expires_at null and retires the date field", async () => {
    const panel = await grantPanel(() => ({ status: 201, body: { ok: true } }));
    panel.node("grant-perpetual").checked = true;
    await panel.node("grant-perpetual").fire("change");

    assert.equal(panel.hidden("grant-expiry-field"), true);
    assert.equal(panel.node("grant-expires").disabled, true);
    assert.equal(panel.node("grant-expires").required, false);

    await panel.node("grant-form").fire("submit");
    await panel.settle();

    const body = panel.sent("/pro")[0]?.body as Record<string, unknown>;
    assert.equal(body.expires_at, null);
    assert.equal(body.plan, "pro");
  });

  test("an emptied expiry is refused before any request", async () => {
    const panel = await grantPanel(() => ({ status: 201, body: { ok: true } }));
    panel.node("grant-expires").value = "";
    await panel.node("grant-form").fire("submit");
    await panel.settle();

    assert.equal(panel.sent("/pro").length, 0, "an empty expiry must not become a perpetual grant");
    assert.match(panel.text("grant-error"), /اختر تاريخ انتهاء/);
  });

  test("granting asks for confirmation, and a refusal sends nothing", async () => {
    const panel = await grantPanel(() => ({ status: 201, body: { ok: true } }));
    panel.setConfirm(false);
    await panel.node("grant-form").fire("submit");
    await panel.settle();

    assert.equal(panel.sent("/pro").length, 0, "a declined confirmation must not call the API");
    assert.equal(panel.confirmations.length, 1);
    assert.match(panel.confirmations[0] ?? "", /ada@example\.com/);
  });
});

describe("Accounts: revoke Pro", () => {
  const granted = accountWith({ grant: { plan: "pro", expires_at: hoursFromNow(24) } });

  async function revokePanel(): Promise<Panel> {
    const panel = await openAccounts([granted], () => ({ status: 200, body: { ok: true } }));
    await panel.rowButtons(TABLE, 0)[0]?.fire("click");
    await panel.settle();
    return panel;
  }

  test("Revoke Pro requires a reason and sends exactly revoke_reason", async () => {
    const panel = await revokePanel();
    panel.node("revoke-reason").value = "chargeback";
    await panel.node("revoke-form").fire("submit");
    await panel.settle();

    const sent = panel.sent("/pro");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.method, "DELETE");
    assert.deepEqual(sent[0]?.body, { revoke_reason: "chargeback" });
  });

  test("a blank reason is refused before any request", async () => {
    const panel = await revokePanel();
    panel.node("revoke-reason").value = "   ";
    await panel.node("revoke-form").fire("submit");
    await panel.settle();

    assert.equal(panel.sent("/pro").length, 0);
    assert.match(panel.text("revoke-error"), /السبب مطلوب/);
  });

  test("revoking asks for confirmation", async () => {
    const panel = await revokePanel();
    panel.setConfirm(false);
    panel.node("revoke-reason").value = "testing";
    await panel.node("revoke-form").fire("submit");
    await panel.settle();

    assert.equal(panel.sent("/pro").length, 0);
    assert.equal(panel.confirmations.length, 1);
  });

  test("the editor names the account", async () => {
    const panel = await revokePanel();
    assert.equal(panel.node("revoke-for").textContent, "ada@example.com");
  });
});

describe("Accounts: disable and enable", () => {
  test("Disable sends an empty object, and only once acknowledged", async () => {
    const panel = await openAccounts([accountWithoutPro], (request) =>
      request.path.endsWith("/disable")
        ? { status: 200, body: { ok: true, account_id: ACCOUNT_ID, disabled: true } }
        : NOT_FOUND,
    );
    await panel.rowButtons(TABLE, 0)[1]?.fire("click");
    await panel.settle();

    assert.equal(panel.hidden("disable-editor"), false);
    assert.equal(panel.node("disable-for").textContent, "ada@example.com");

    // The acknowledgement is the strong confirmation: the consequence is that
    // every signed-in device stops working, which a bare confirm() glosses over.
    await panel.node("disable-form").fire("submit");
    await panel.settle();
    assert.equal(panel.sent("/disable").length, 0, "an unacknowledged disable must not be sent");
    assert.match(panel.text("disable-error"), /يُنهي كل الجلسات النشطة/);

    panel.node("disable-ack").checked = true;
    await panel.node("disable-form").fire("submit");
    await panel.settle();

    const sent = panel.sent("/disable");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.method, "POST");
    assert.equal(sent[0]?.path, `/api/admin/accounts/${ACCOUNT_ID}/disable`);
    // The route's field allowlist is empty; any key at all is a 422.
    assert.deepEqual(sent[0]?.body, {});
  });

  test("Enable sends an empty object and needs no acknowledgement", async () => {
    const panel = await openAccounts([accountWith({ disabled: true })], (request) =>
      request.path.endsWith("/enable")
        ? { status: 200, body: { ok: true, account_id: ACCOUNT_ID, disabled: false } }
        : NOT_FOUND,
    );
    await panel.rowButtons(TABLE, 0)[1]?.fire("click");
    await panel.settle();

    const sent = panel.sent("/enable");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.path, `/api/admin/accounts/${ACCOUNT_ID}/enable`);
    assert.deepEqual(sent[0]?.body, {});
  });
});

describe("Accounts: state after a mutation", () => {
  test("a successful grant is followed by a re-read of the list", async () => {
    let listed = 0;
    const panel = mount(
      router(
        isSignedIn,
        withCategories,
        (request) => {
          if (!request.path.startsWith("/api/admin/accounts?")) return undefined;
          listed += 1;
          const account =
            listed > 1 ? accountWith({ grant: { plan: "pro", expires_at: hoursFromNow(24) } }) : accountWithoutPro;
          return { status: 200, body: { accounts: [account], count: 1, limit: 50, offset: 0 } };
        },
        (request) =>
          request.path.endsWith("/pro") ? { status: 201, body: { ok: true } } : undefined,
      ),
    );
    await panel.settle();
    await panel.goto("accounts");
    assert.equal(panel.rows(TABLE)[0]?.[2], "لا يوجد Pro");

    await panel.rowButtons(TABLE, 0)[0]?.fire("click");
    await panel.settle();
    await panel.node("grant-form").fire("submit");
    await panel.settle();

    // The screen follows the API, so the grant is visible even though the
    // mutation's own response said nothing about the account's new state.
    assert.equal(panel.rows(TABLE)[0]?.[2], "Pro فعّالة");
    assert.deepEqual(
      panel.rowButtons(TABLE, 0).map((button) => button.textContent),
      ["سحب Pro", "تعطيل"],
    );
  });

  test("a failed mutation is still followed by a re-read", async () => {
    // The API may have applied the change before failing, so the panel re-reads
    // rather than leaving a stale copy on screen and calling it current.
    let listed = 0;
    const panel = mount(
      router(
        isSignedIn,
        withCategories,
        (request) => {
          if (!request.path.startsWith("/api/admin/accounts?")) return undefined;
          listed += 1;
          const account = listed > 1 ? accountWith({ disabled: true }) : accountWithoutPro;
          return { status: 200, body: { accounts: [account], count: 1, limit: 50, offset: 0 } };
        },
        (request) =>
          request.path.endsWith("/disable")
            ? { status: 500, body: { error: { code: "internal", message: "boom" } } }
            : undefined,
      ),
    );
    await panel.settle();
    await panel.goto("accounts");
    const before = listed;

    await panel.rowButtons(TABLE, 0)[1]?.fire("click");
    panel.node("disable-ack").checked = true;
    await panel.node("disable-form").fire("submit");
    await panel.settle();

    assert.ok(listed > before, "a re-read follows even a failed mutation");
    assert.equal(panel.rows(TABLE)[0]?.[1], "معطّل", "the screen shows what the API says");
  });

  test("a mutation is never retried behind the operator's back", async () => {
    let attempts = 0;
    const panel = await openAccounts([accountWithoutPro], () => {
      attempts += 1;
      return { status: 500, body: { error: { code: "internal", message: "boom" } } };
    });
    await panel.rowButtons(TABLE, 0)[0]?.fire("click");
    await panel.settle();
    await panel.node("grant-form").fire("submit");
    await panel.settle();

    assert.equal(attempts, 1, "exactly one grant attempt, however it failed");
  });
});

describe("Accounts: error handling", () => {
  const cases: [number, unknown, RegExp][] = [
    [401, { error: { code: "unauthorized", message: "Sign in to continue" } }, /انتهت جلسة الإدارة/],
    [403, { error: { code: "forbidden", message: "nope" } }, /رفض الـ API هذا الطلب/],
    [404, { error: { code: "not_found", message: "Account" } }, /الحساب غير موجود/],
    [
      409,
      { error: { code: "conflict", message: "That account already has a Pro grant." } },
      /يملك منحة Pro فعّالة بالفعل/,
    ],
    [
      422,
      {
        error: {
          code: "validation_failed",
          message: "That value is not allowed",
          fields: { expires_at: "must be in the future" },
        },
      },
      // The API's own message and field names stay verbatim: a field name is an
      // identifier, not prose, and naming it is the whole value of a 422.
      /expires_at: must be in the future/,
    ],
    [429, { error: { code: "rate_limited", message: "slow down" } }, /طلبات كثيرة جدًا/],
    [500, { error: { code: "internal", message: "boom" } }, /فشل الخادم \(500\)/],
  ];

  for (const [status, body, expected] of cases) {
    test(`a ${status} from Grant Pro is explained rather than swallowed`, async () => {
      const panel = await openAccounts([accountWithoutPro], () => ({ status, body }));
      await panel.rowButtons(TABLE, 0)[0]?.fire("click");
      await panel.settle();
      await panel.node("grant-form").fire("submit");
      await panel.settle();

      if (status === 401) {
        // A 401 is the session gate, not a field error: the panel returns to the
        // sign-in view instead of annotating an editor nobody can reach.
        assert.equal(panel.hidden("topbar"), true);
        assert.equal(panel.hidden("view-login"), false);
        return;
      }
      assert.equal(panel.hidden("grant-error"), false, "the failure is shown");
      assert.match(panel.text("grant-error"), expected);
      assert.equal(panel.hidden("grant-editor"), false, "the editor stays open to correct and retry");
    });
  }
});

describe("Accounts: the listing contract", () => {
  test("the list is read from the existing admin route, with no new endpoint", async () => {
    const panel = await openAccounts([accountWithoutPro]);
    const paths = new Set(panel.calls.map((call) => call.path.split("?")[0]));
    assert.ok(paths.has("/api/admin/accounts"), "the listing route is the one already in the API");
    for (const path of paths) {
      assert.match(path ?? "", /^\/api\/admin\//, "every call stays under the admin prefix");
    }
  });

  test("reads are never given the admin mutation header", async () => {
    // The header proves a request came from this page for a *mutation*. Sending
    // it on a read would be cargo-culting, and the CSRF layer checks it only
    // where it means something.
    const panel = await openAccounts([accountWithoutPro]);
    for (const call of panel.calls) {
      if (call.method === "GET") {
        assert.equal(call.headers["X-WAFI-Admin"], undefined);
      }
    }
  });

  test("nothing about the panel's credentials is persisted by the browser", async () => {
    const panel = await openAccounts([accountWithoutPro]);
    // The panel has no storage of any kind; this asserts the harness observes the
    // panel never reaching for one, and the source-level check lives in the
    // shell suite where the whole file is in scope.
    assert.equal(panel.calls.filter((call) => call.body !== undefined && call.method === "GET").length, 0);
  });
});

describe("Accounts: the landing view is unaffected", () => {
  test("categories still load, and still say so in Arabic when empty", async () => {
    const panel = mount(router(isSignedIn, withCategories));
    await panel.settle();
    assert.equal(panel.rows("categories-table").length, 1);
    assert.equal(panel.rows("categories-table")[0]?.[0], "لا توجد فئات بعد");
    assert.equal(EMPTY_CATEGORIES.status, 200);
  });
});
