/**
 * Account authentication guard.
 *
 * The account twin of `admin-guard.ts`, and deliberately not a shared
 * abstraction with it. `requireAccount` reads `__Host-wafx_account` and nothing
 * else: no `X-WAFI-Admin`, no `PUBLIC_ORIGIN`, no admin session fallback. An
 * account route that somehow accepted an admin cookie would be a privilege
 * confusion with a very short fuse, so there is no code path that could.
 *
 * Like the admin guard, it is applied by wrapping a router rather than by each
 * route calling it, so a new private account route is protected by default:
 * forgetting to add the check would leave a hole, and forgetting to add the route
 * cannot.
 */

import type { MiddlewareHandler } from "hono";

import type { AdminEnv } from "./admin-guard.ts";
import { HttpError } from "../errors.ts";
import { readAccountToken, resolve, type AccountSession } from "../account-session.ts";

export interface AccountEnv extends AdminEnv {
  Variables: AdminEnv["Variables"] & {
    account: AccountSession;
  };
}

export function requireAccount(): MiddlewareHandler<AccountEnv> {
  return async (c, next) => {
    const token = readAccountToken(c.req.header("cookie"));
    if (token === null) {
      throw new HttpError("unauthorized", "Sign in to continue");
    }
    const session = await resolve(c.get("db"), token, c.get("config"));
    if (session === null) {
      throw new HttpError("unauthorized", "Session expired, sign in again");
    }
    c.set("account", session);
    await next();
  };
}