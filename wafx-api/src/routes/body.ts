/**
 * Shared request-body handling.
 *
 * Extracted from admin-auth because every admin route needs it and the ceiling
 * has to be applied identically in all of them.
 */

import { HttpError, badRequest } from "../errors.ts";

/**
 * Generous for this API - the largest legitimate body is a release's notes
 * field - and small enough that one request cannot exhaust the isolate's 128 MB.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Reads and parses a JSON object body.
 *
 * `Content-Length` is checked first so an oversized payload is refused without
 * ever being buffered, then the actual text is measured, because a chunked
 * request carries no declared length.
 *
 * The content type is checked before reading. Nothing here is a CSRF defence on
 * its own - a cross-origin form can set `Content-Type: text/plain` - but refusing
 * it means the only way to reach these routes is a request this API would
 * recognise as its own, which is one fewer thing to reason about.
 */
export async function readJsonObject(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new HttpError("payload_too_large", "Request body is too large");
  }

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (contentType !== "" && !contentType.startsWith("application/json")) {
    throw new HttpError("unsupported_media_type", "Expected application/json");
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new HttpError("payload_too_large", "Request body is too large");
  }
  if (text.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("Body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("Expected a JSON object");
  }
  return parsed;
}

/** Query parameter allowlist. Unknown parameters are ignored, not honoured. */
export function pick<T extends string>(
  source: Record<string, string | undefined>,
  allowed: readonly T[],
): Partial<Record<T, string>> {
  const out: Partial<Record<T, string>> = {};
  for (const key of allowed) {
    const value = source[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}
