/**
 * CSRF defence.
 *
 * Two checks on every state-changing request:
 *
 * 1. `Origin` (or `Referer` when `Origin` is absent) must equal PUBLIC_ORIGIN. A
 *    cross-site form POST or fetch sends the victim's origin, not ours, so this
 *    rejects the request outright.
 *
 * 2. `X-WAFI-Admin: 1` must be present. A cross-origin request cannot set a
 *    custom header without first passing a CORS preflight, and this Worker never
 *    answers a preflight with permissive CORS headers, so the browser never sends
 *    the request at all. This is also what makes check 1 safe to skip when neither
 *    header is present: `scripts/seed-admin.ts` and `curl` send no Origin and no
 *    Referer, and neither can be driven from a page on another site.
 *
 * `SameSite=Strict` on the cookie is a third layer, but it is a browser feature
 * and not one this code can rely on alone.
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

export function requireSameOrigin<E extends Env = Env>(config: Config): MiddlewareHandler<E> {
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
