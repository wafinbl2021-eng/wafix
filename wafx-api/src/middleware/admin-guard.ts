/**
 * Admin authentication guard.
 *
 * Resolves the session cookie into `c.get('admin')` and refuses anything
 * without one. Routes are registered under this guard rather than each one
 * calling it, so a new admin route is protected by default: forgetting to add a
 * check would leave a hole, and forgetting to add a route cannot.
 */

import type { MiddlewareHandler } from "hono";

import type { Config, Env } from "../env.ts";
import { readConfig } from "../env.ts";
import { Db } from "../db.ts";
import { HttpError } from "../errors.ts";
import { readSessionToken, resolve, type AdminSession } from "../session.ts";

export interface AdminEnv {
  Bindings: Env;
  Variables: {
    admin: AdminSession;
    config: Config;
    db: Db;
    /** Client IP, from Cloudflare's header. Used for audit and rate limiting. */
    ip: string;
  };
}

/**
 * D1's `results` are all-nullable and numbers arrive as numbers or bigints
 * depending on driver version, so anything read out of the database is coerced
 * at the boundary rather than trusted to have the right type downstream.
 *
 * Anything that is not a primitive reads as absent rather than being stringified.
 * `String({})` is `"[object Object]"`, which would put that literal into a
 * response or an audit row if a driver ever handed back a non-scalar; an empty
 * string is the safe answer and no real column is ever affected.
 */
export function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** D1 booleans are 0/1 integers. */
export function flag(value: unknown): boolean {
  return num(value) === 1;
}

export function isPlainText(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Cloudflare sets CF-Connecting-IP and overwrites any client-supplied value.
 * When it is absent (local `wrangler dev`) the socket address is used, which is
 * the only thing available.
 */
export function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/** Per-request singletons, so routes do not each rebuild them. */
export function context(): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    c.set("config", readConfig(c.env));
    c.set("db", new Db(c.env.DB));
    c.set("ip", clientIp(c));
    await next();
  };
}

export function requireAdmin(): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const token = readSessionToken(c.req.header("cookie"));
    if (token === null) {
      throw new HttpError("unauthorized", "Sign in to continue");
    }
    const session = await resolve(c.get("db"), token, c.get("config"));
    if (session === null) {
      throw new HttpError("unauthorized", "Session expired, sign in again");
    }
    c.set("admin", session);
    await next();
  };
}
