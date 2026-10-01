/**
 * Error type and response shape.
 *
 * Every failure leaves the Worker as `{ error: { code, message } }`. Messages
 * are written for the person reading the admin panel, so they may say what is
 * wrong, but never what the server was doing: no SQL, no stack traces, no
 * binding names. Anything unexpected becomes `internal` with a generic
 * message, and the detail goes to the console where only the operator sees it.
 */

export type ErrorCode =
  | "bad_request"
  | "payload_too_large"
  | "unsupported_media_type"
  | "validation_failed"
  | "not_found"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "conflict"
  | "bootstrap_unavailable"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  // 413 and 415 rather than a generic 400, so a client can tell "you sent
  // something I will never accept" from "you sent something malformed".
  payload_too_large: 413,
  unsupported_media_type: 415,
  validation_failed: 422,
  not_found: 404,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  conflict: 409,
  bootstrap_unavailable: 409,
  internal: 500,
};

/** Per-field messages, so a form can mark the offending input. */
export type FieldErrors = Record<string, string>;

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly fields: FieldErrors | undefined;
  /** Extra response headers, used for things like Retry-After. */
  readonly headers: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { fields?: FieldErrors; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.fields = options.fields;
    this.headers = options.headers ?? {};
  }

  get status(): number {
    return STATUS[this.code];
  }

  toBody(): { error: { code: ErrorCode; message: string; fields?: FieldErrors } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {}),
      },
    };
  }
}

export const badRequest = (message: string) => new HttpError("bad_request", message);
export const notFound = (what: string) => new HttpError("not_found", `${what} not found`);
export const unauthorized = (message = "Sign in to continue") =>
  new HttpError("unauthorized", message);
export const forbidden = (message = "Not allowed") => new HttpError("forbidden", message);
export const conflict = (message: string) => new HttpError("conflict", message);
export const validationFailed = (message: string, fields?: FieldErrors) =>
  new HttpError("validation_failed", message, { fields });
