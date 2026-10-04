/**
 * CSRF defence.
 *
 * TWO CHECKS, FOR TWO SURFACES
 * ============================
 *
 * This file used to hold one check, applied to every mutating request in the
 * Worker. That was wrong in a way only visible once accounts existed, so it is
 * now split:
 *
 *   - `requireAdminMutations` guards admin routes. It wants an Origin that is
 *     ours *and* the `X-WAFI-Admin: 1` header.
 *
 *   - `requireAccountOrigin` guards account routes. It wants an Origin that is
 *     on the account allowlist, and nothing else.
 *
 * The reason account routes must not carry `X-WAFI-Admin` is that for them the
 * header is not a CSRF signal, it is a falsehood. Its entire purpose is to
 * prove a request came from the admin panel's own JavaScript, and the account API
 * is called by the desktop app - Rust, not a page. Requiring that client to send
 * `x-wafi-admin` on an account login asserts something untrue about who is
 * calling, to buy a guarantee it does not need.
 *
 * Underneath both is the layer that does most of the work, and it is not in this
 * file: every route that reads a body demands `Content-Type: application/json`
 * (see routes/body.ts), and this Worker never answers a CORS preflight. An HTML
 * form cannot set that content type at all, and a cross-origin `fetch` that tries
 * is stopped before it reaches the network. A page on another origin cannot
 * construct a request these routes will even read.
 *
 * Origin is the second layer and `SameSite=Strict` on the cookie is the third.
 * SameSite is a browser feature rather than one this code can rely on alone.
 *
 * Note that `c.req.header()` answers `string | undefined` and never `null`.
 * Comparing against `null` here would make "no Origin header" look like a
 * mismatch, which rejects every legitimate request that omits it and makes the
 * Referer fallback unreachable.
 */

import type { Env } from "hono";
import type { MiddlewareHandler } from "hono";

import type { Config } from "../env.ts";
import { HttpError } from "../errors.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const ADMIN_HEADER = "x-wafi-admin";

const WRONG_ORIGIN = "Request came from an unexpected origin";

/**
 * The origin of a `Referer` header, or undefined when it is absent or unparseable.
 *
 * A referer that will not parse is treated as absent rather than as a match, so a
 * garbage value cannot slip past the check below.
 */
function refererOrigin(referer: string | undefined): string | undefined {
  if (referer === undefined) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/**
 * Admin routes.
 *
 * `Origin` (or `Referer` when `Origin` is absent) must equal PUBLIC_ORIGIN. A
 * cross-site form POST or fetch sends the victim's origin, not ours, so this
 * rejects the request outright.
 *
 * `X-WAFI-Admin: 1` must also be present. A cross-origin request cannot set a
 * custom header without first passing a CORS preflight, and this Worker never
 * answers a preflight with permissive CORS headers, so the browser never sends the
 * request at all. This is also what makes the Origin check safe to skip when
 * neither header is present: `scripts/seed-admin.ts` and `curl` send no Origin and
 * no Referer, and neither can be driven from a page on another site.
 */
export function requireAdminMutations<E extends Env = Env>(
  config: Config,
): MiddlewareHandler<E> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== config.publicOrigin) {
      throw new HttpError("forbidden", WRONG_ORIGIN);
    }

    // Origin is omitted by some same-origin requests depending on the method and
    // the browser, so fall back to Referer before giving up.
    if (origin === undefined) {
      const referer = refererOrigin(c.req.header("referer"));
      if (referer !== undefined && referer !== config.publicOrigin) {
        throw new HttpError("forbidden", WRONG_ORIGIN);
      }
    }

    if (c.req.header(ADMIN_HEADER) !== "1") {
      throw new HttpError(
        "forbidden",
        `Missing ${ADMIN_HEADER} header. Requests that change data must be made from the admin panel.`,
      );
    }

    await next();
  };
}

/**
 * Account routes.
 *
 * `Origin` must be *present* and on the allowlist. Absent is refused rather than
 * waved through, which is the opposite of the admin rule and is deliberate. An
 * admin request with no Origin is `curl` or `seed-admin.ts`, a caller that is
 * telling the truth about itself. A cookie-authenticated account mutation with no
 * Origin is a request whose calling browser the server cannot identify, and
 * "no Origin" is exactly the shape a cross-site form POST can be made to take in
 * some clients.
 *
 * The consequence is that the account client has to send `Origin` on purpose. The
 * desktop app's Rust HTTP client and the web app's `fetch` both already set a
 * User-Agent, so this is one more line in code that was writing headers anyway -
 * and it is the price of not inheriting a header that claims to be the admin
 * panel.
 *
 * No `X-WAFI-Admin` here, and no Referer fallback: a Referer is a URL, not a
 * statement of intent, and a client that can send one can send an Origin.
 */
export function requireAccountOrigin<E extends Env = Env>(
  config: Config,
): MiddlewareHandler<E> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    const origin = c.req.header("origin");
    if (origin === undefined) {
      throw new HttpError("forbidden", "Requests that change data must state their origin");
    }
    if (!config.accountOrigins.includes(origin)) {
      throw new HttpError("forbidden", WRONG_ORIGIN);
    }

    await next();
  };
}
