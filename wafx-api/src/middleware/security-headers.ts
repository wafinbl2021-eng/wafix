/**
 * Security response headers.
 *
 * The Worker serves both the JSON API and the admin panel's static files, so
 * these are set centrally rather than per route.
 *
 * The CSP is deliberately strict. `connect-src 'self'` means the panel can only
 * talk to its own origin, which is also what stops a compromised dependency in
 * the panel from posting the session cookie somewhere else. `frame-ancestors
 * 'none'` blocks clickjacking of the panel, where a single convincing click
 * could publish a release.
 *
 * There is no `unsafe-inline` for scripts. The panel ships one stylesheet and
 * one module, both external files, so nothing needs it.
 */

import type { MiddlewareHandler } from "hono";

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    const headers = c.res.headers;
    headers.set("Content-Security-Policy", CSP);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    headers.set(
      "Permissions-Policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
    );
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");

    // An API response is per-user state; it must never sit in a shared cache.
    if (c.req.path.startsWith("/api/")) {
      headers.set("Cache-Control", "no-store");
      headers.set("Vary", "Cookie, Origin");
    }
  };
}
