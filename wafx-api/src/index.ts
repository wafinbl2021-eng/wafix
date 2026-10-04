/**
 * Worker entry point.
 *
 * Route map, and therefore the complete attack surface:
 *
 *   GET    /api/health                  liveness
 *   GET    /api/meta                    catalog shape, for clients
 *   GET    /api/apps                    public catalog
 *   GET    /api/apps/:id                one public application
 *   GET    /api/categories              public categories
 *   GET    /api/releases/latest         public release metadata (not the updater feed)
 *
 *   GET    /api/admin/auth/params       salt + iteration count, for the panel to derive
 *   POST   /api/admin/bootstrap         first admin only, once
 *   POST   /api/admin/login
 *   POST   /api/admin/logout
 *   GET    /api/admin/me
 *   POST   /api/admin/password
 *
 *   GET    /api/admin/categories        + POST, PATCH, DELETE
 *   GET    /api/admin/apps              + PUT /:id, GET /:id, DELETE /:id
 *   GET    /api/admin/apps/:id/versions + POST
 *   PATCH  /api/admin/versions/:id      + DELETE
 *   GET    /api/admin/releases          + POST, GET/PATCH/DELETE /:id
 *   GET    /api/admin/audit
 *
 *   GET    /api/admin/accounts          list, or exact lookup with ?email=
 *   POST   /api/admin/accounts/:id/pro  + DELETE /:id/pro
 *   POST   /api/admin/accounts/:id/disable + POST /:id/enable
 *
 *   GET    /api/account/auth/params     salt + iteration count, decoyed if unknown
 *   POST   /api/account/register        never says whether the address existed
 *   POST   /api/account/login
 *   POST   /api/account/logout          this session only
 *   GET    /api/account/me
 *
 *   GET    /api/license                signed Pro entitlement for this account
 *
 *   GET    /admin/*                     the static panel
 *
 * There is no route that executes anything, anywhere. No endpoint takes a
 * command, an argument list or a script, and no endpoint returns one. The only
 * remote value that reaches a local process is an installer URL, and the desktop
 * app decides how to launch that file from a closed enum.
 *
 * Admin routes are registered *behind* `requireAdmin()` rather than each one
 * calling it. A new admin route is therefore protected by default, and the way to
 * accidentally expose one is to mount it in the wrong block. The same is true of
 * the private account routes and `requireAccount()`.
 *
 * Three groups, three origin rules - see `mount` below for how each is assembled.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AdminEnv } from "./middleware/admin-guard.ts";
import { context, requireAdmin } from "./middleware/admin-guard.ts";
import type { AccountEnv } from "./middleware/account-guard.ts";
import { requireAccount } from "./middleware/account-guard.ts";
import { requireAccountOrigin, requireAdminMutations } from "./middleware/csrf.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { HttpError } from "./errors.ts";
import { Db } from "./db.ts";
import { publicRoutes } from "./routes/public.ts";
import { authRoutes } from "./routes/admin-auth.ts";
import { accountPrivateRoutes, accountRoutes } from "./routes/account-auth.ts";
import { licenseRoutes } from "./routes/license.ts";
import { catalogRoutes } from "./routes/admin-catalog.ts";
import { releaseRoutes } from "./routes/admin-releases.ts";
import { accountAdminRoutes } from "./routes/admin-accounts.ts";

const app = new Hono<AdminEnv>();

// Headers first, so they are on the response even when a later stage throws.
app.use("*", securityHeaders());

// Per-request singletons every route reads: config, the database wrapper and the
// client IP. Before this, `c.get("db")` is undefined and any route that touches
// the database fails.
app.use("*", context());

/**
 * Health check. Reports only whether the Worker is running and whether the
 * database answers - no version numbers, no configuration, nothing that would
 * help someone decide what to attack.
 */
app.get("/api/health", async (c) => {
  const started = Date.now();
  try {
    const row = await new Db(c.env.DB).first<{ n: number }>("SELECT count(*) AS n FROM apps");
    return c.json({
      ok: true,
      database: "reachable",
      apps: Number(row?.n ?? 0),
      latency_ms: Date.now() - started,
    });
  } catch {
    // A 200 here would let a monitor report healthy while the database is down.
    return c.json({ ok: false, database: "unreachable" }, 503);
  }
});

/**
 * Re-registers a router's routes on a wrapper, with `layers` in front of each.
 *
 * The middleware is applied per route rather than as a `use("*")` on the parent
 * app. A `*` guard would also stand in front of *every other* `/api/*` route, so
 * an unknown path would answer 401 instead of 404 and a public route added later
 * would silently inherit a login requirement. Per-route registration means a
 * guard's reach is exactly the set of routes in `router` - adding a route there
 * is still enough to protect it, and nothing else is affected.
 *
 * `context()` is re-applied ahead of the caller's middleware because every
 * middleware here needs `c.get("config")` and `c.get("db")` to exist *before* it
 * runs. Every route in this codebase already calls it, and `c.set` is idempotent,
 * so putting it first is both necessary and free.
 *
 * The two casts inside are the same fact stated as narrowly as possible:
 * `AccountEnv` is `AdminEnv` plus the `account` variable, so a handler written for
 * `AdminEnv` is valid for a wider environment. Hono's generics cannot express
 * that relationship, and it is true at runtime, so it is asserted here rather than
 * pushed onto every call site.
 */
function mount<Src extends AdminEnv>(
  router: Hono<Src>,
  ...layers: MiddlewareHandler<Src>[]
): Hono<AdminEnv> {
  const wrapper = new Hono<Src>();
  for (const route of router.routes) {
    wrapper.on(
      route.method,
      route.path,
      context() as unknown as MiddlewareHandler<Src>,
      ...layers,
      route.handler as MiddlewareHandler<Src>,
    );
  }
  return wrapper as unknown as Hono<AdminEnv>;
}

/**
 * The middleware a request faces, in the order it faces it.
 *
 *   public   security headers, context. No origin check, because every route in
 *            `publicRoutes` is a GET and a GET changes nothing. A mutating public
 *            route would need one of the two checks below added by hand, and
 *            `test/accounts.test.ts` asserts that no public route is mutating so
 *            the gap cannot open quietly.
 *
 *   admin    security headers, context, origin check, then `requireAdmin()` where
 *            a session is required. Both apply to the auth routes as well as the
 *            guarded catalogue, because login and bootstrap are exactly the
 *            requests an attacker forges. This replaces an `app.use("*")` that put
 *            the same check in front of everything, account routes included.
 *
 *   account  security headers, context, origin check on the *account* allowlist,
 *            and no `X-WAFI-Admin` anywhere. The desktop app's Rust client is not
 *            the admin panel and must not have to claim to be one; see
 *            middleware/csrf.ts for why requiring that header here would be a
 *            false statement rather than a defence.
 */
const adminOrigin: MiddlewareHandler<AdminEnv> = async (c, next) => {
  await requireAdminMutations<AdminEnv>(c.get("config"))(c, next);
};
const accountOrigin: MiddlewareHandler<AccountEnv> = async (c, next) => {
  await requireAccountOrigin<AccountEnv>(c.get("config"))(c, next);
};

app.route("/api", publicRoutes);

// Admin auth routes are mounted without `requireAdmin()` on purpose: login,
// bootstrap, logout, /me and /password are the endpoints that cannot themselves
// require a session. They are still behind the origin check.
app.route("/api", mount(authRoutes, adminOrigin));
app.route("/api", mount(catalogRoutes, adminOrigin, requireAdmin()));
app.route("/api", mount(releaseRoutes, adminOrigin, requireAdmin()));

// Account management, including the only route in this Worker that discloses an
// `accounts.id`. Same mount as the rest of the panel - `adminOrigin` for the
// mutating requests and `requireAdmin()` for all of them - so granting Pro is
// gated exactly as strictly as unpublishing an installer is.
app.route("/api", mount(accountAdminRoutes, adminOrigin, requireAdmin()));

// `accountRoutes` needs no session - params, register, login and logout are how a
// session comes into being, and `/account/logout` works without one so a stale
// cookie can always be cleared.
app.route("/api", mount(accountRoutes, accountOrigin));

// `accountPrivateRoutes` is mounted through `requireAccount()`, so a new private
// account route cannot be added unauthenticated.
app.route("/api", mount(accountPrivateRoutes, accountOrigin, requireAccount()));

// The Pro entitlement route goes through the same two layers, for the same
// reason and with the same reach: it reads one account's grant and signs it, so
// an unauthenticated or wrong-origin request has nothing legitimate to make.
app.route("/api", mount(licenseRoutes, accountOrigin, requireAccount()));

/**
 * The panel's static files, with an SPA fallback to panel.html.
 *
 * `ASSETS` is only bound when `[assets]` is configured in wrangler.toml. Without
 * it the Worker returns a plain message rather than a stack trace, so a
 * misconfigured deploy is obvious without leaking anything.
 *
 * The mount point the browser sees is /admin, but `directory = "./admin"` puts
 * the assets at the root, so the file behind /admin/styles.css is /styles.css.
 * The two disagree by exactly one segment, and the translation is done here
 * rather than at each call site so that no asset can be served under a prefix
 * it does not have - which is exactly what broke this once, with every panel
 * URL 404ing and no test noticing, because the one test that covered it
 * asserted the wrong path rather than the served one.
 *
 * The shell is panel.html, not index.html, on purpose. The assets router serves
 * index.html at / before the Worker is consulted, so naming it index.html
 * would publish the panel shell at the site root - a second, unlinked way in
 * that the /admin mount point is supposed to be the only one of.
 */
app.get("/admin", (c) => servePanel(c, "/admin"));
app.get("/admin/*", (c) => servePanel(c, new URL(c.req.url).pathname));

async function servePanel(c: Context<AdminEnv>, mount: string): Promise<Response> {
  const assets = c.env.ASSETS;
  if (assets === undefined) {
    return c.json({ error: { code: "not_found", message: "Admin panel is not deployed" } }, 404);
  }
  // /admin itself and /admin/ both land on the shell.
  const path = mount.slice("/admin".length) || "/panel.html";
  // A path whose last segment contains a dot is a request for a file. Serving
  // the shell for those would make a missing script look like a blank page
  // with no 404 to explain it.
  const last = path.slice(path.lastIndexOf("/") + 1);
  const asset = last.includes(".") ? path : "/panel.html";
  const response = await assets.fetch(new Request(new URL(asset, c.req.url)));
  // The assets binding hands back a response with an immutable header guard, so
  // the security-headers middleware cannot stamp it and throws "Can't modify
  // immutable headers" instead, turning every panel file into a 500. Rebuilding
  // the response gives the middleware headers it may write to. The body stream
  // is passed straight through, not buffered, so nothing is copied in memory.
  return new Response(response.body, response);
}

app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

/**
 * Single error handler.
 *
 * `HttpError` carries a message that was written to be read by the operator, so
 * it is returned as-is. Anything else is logged in full and reported as a
 * generic 500: an unexpected error's message can contain a SQL fragment, a
 * column name or a bound value.
 */
app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json(
      error.toBody(),
      error.status as ContentfulStatusCode,
      error.headers,
    );
  }
  console.error(
    `unhandled error on ${c.req.method} ${new URL(c.req.url).pathname}: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }`,
  );
  return c.json({ error: { code: "internal", message: "Something went wrong" } }, 500);
});

export default app;

// Named for the tests, which import { app } rather than the default export.
export { app };
