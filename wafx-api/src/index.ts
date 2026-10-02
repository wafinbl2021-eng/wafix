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
 *   GET    /admin/*                     the static panel
 *
 * There is no route that executes anything, anywhere. No endpoint takes a
 * command, an argument list or a script, and no endpoint returns one. The only
 * remote value that reaches a local process is an installer URL, and the desktop
 * app decides how to launch that file from a closed enum.
 *
 * Admin routes are registered *inside* `requireAdmin()` rather than each one
 * calling it. A new admin route is therefore protected by default, and the way
 * to accidentally expose one is to mount it in the wrong block.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AdminEnv } from "./middleware/admin-guard.ts";
import { context, requireAdmin } from "./middleware/admin-guard.ts";
import { requireSameOrigin } from "./middleware/csrf.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { HttpError } from "./errors.ts";
import { Db } from "./db.ts";
import { publicRoutes } from "./routes/public.ts";
import { authRoutes } from "./routes/admin-auth.ts";
import { catalogRoutes } from "./routes/admin-catalog.ts";
import { releaseRoutes } from "./routes/admin-releases.ts";

const app = new Hono<AdminEnv>();

// Headers first, so they are on the response even when a later stage throws.
app.use("*", securityHeaders());

// Per-request singletons every route reads: config, the database wrapper and the
// client IP. Before this, `c.get("db")` is undefined and any route that touches
// the database fails.
app.use("*", context());

// Origin + custom-header check on every mutating request, before any handler.
// Declared as a named handler so the context it receives is the one the
// middleware expects, rather than the one inferred for a `*` path.
const sameOrigin: MiddlewareHandler<AdminEnv> = async (c, next) => {
  await requireSameOrigin<AdminEnv>(c.get("config"))(c, next);
};
app.use("*", sameOrigin);

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
 * Wraps a router so every route inside it requires a session.
 *
 * The guard is applied to `*` on a wrapper rather than per route in the wrapped
 * file. That is what makes authentication structural: adding a route to
 * `catalogRoutes` cannot accidentally expose it, because the route is not
 * reachable except through a sub-app the guard is already in front of.
 */
function guarded(router: Hono<AdminEnv>): Hono<AdminEnv> {
  const guard = requireAdmin();
  const wrapper = new Hono<AdminEnv>();

  // Each route is re-registered with the guard in front of it, rather than
  // mounting the router under a `use("*")` middleware. Mounting a `*` guard would
  // also put it in front of *every other* `/api/*` route in the app, so an
  // unknown path would answer 401 instead of 404 and a public route added later
  // would silently inherit a login requirement. Re-registering per route means
  // the guard's reach is exactly the set of routes in `router` - so adding a route
  // there is still enough to protect it, and nothing else is affected.
  for (const route of router.routes) {
    wrapper.on(route.method, route.path, guard, route.handler);
  }
  return wrapper;
}

app.route("/api", publicRoutes);

// Auth routes are mounted unwrapped on purpose: login, bootstrap, logout, /me
// and /password are the endpoints that cannot themselves require a session.
app.route("/api", authRoutes);

app.route("/api", guarded(catalogRoutes));
app.route("/api", guarded(releaseRoutes));

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
