/**
 * Test harness.
 *
 * The Worker runs on `D1Database`, which does not exist in Node. Rather than
 * mocking the queries - which would only prove the mock agrees with itself -
 * this backs `D1Database` with `node:sqlite`, so tests exercise the real SQL
 * against the real schema, including CHECK and FOREIGN KEY constraints.
 *
 * That matters most for the security properties: "https only" and "installer_mode
 * is a closed set" are enforced by the database, and a test using a fake driver
 * could not tell whether the constraint actually fires.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { app } from "../src/index.ts";
import { DEFAULT_ITERATIONS } from "../src/crypto.ts";
import type { Database, Statement } from "../src/db.ts";

/**
 * Synchronous SHA-256, for arranging fixtures without awaiting every call site.
 *
 * The Worker uses WebCrypto, which is async. That is right for a runtime where
 * each request has its own budget, and wrong for a test that just needs a stable
 * 64-character hex string as a stand-in for a verifier.
 */
function fastSha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

/** Applies every migration in order, as `wrangler d1 migrations apply` would. */
export function migrate(sqlite: DatabaseSync): void {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
}

type Param = string | number | null;

/** The D1 surface `src/db.ts` actually uses. */
class SqliteStatement implements Statement {
  private values: Param[] = [];

  private readonly sqlite: DatabaseSync;
  private readonly query: string;

  constructor(sqlite: DatabaseSync, query: string) {
    this.sqlite = sqlite;
    this.query = query;
  }

  bind(...values: unknown[]): SqliteStatement {
    // D1 accepts null, number and string. Refusing anything else here means a test
    // that passes a boolean fails loudly instead of storing something the real
    // driver would reject.
    this.values = values.map((value) => {
      if (value === null || value === undefined) return null;
      if (typeof value === "string" || typeof value === "number") return value;
      throw new Error(`unsupported bind type: ${typeof value}`);
    });
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.sqlite.prepare(this.query).get(...this.values);
    return (row as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.sqlite.prepare(this.query).all(...this.values) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const result = this.sqlite.prepare(this.query).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

/**
 * A `D1Database` over `node:sqlite`.
 *
 * Named `TestD1` rather than `TestDatabase` so it does not collide with the
 * global `D1Database` from the Workers types, which are also in scope here.
 */
export class TestD1 implements Database {
  readonly sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite;
  }

  static create(): TestD1 {
    const sqlite = new DatabaseSync(":memory:");
    // Off by default in SQLite, which would let a dangling reference through and
    // hide a missing ON DELETE clause.
    sqlite.exec("PRAGMA foreign_keys = ON");
    migrate(sqlite);
    return new TestD1(sqlite);
  }

  prepare(query: string): Statement {
    return new SqliteStatement(this.sqlite, query);
  }

  async batch<T = Record<string, unknown>>(statements: Statement[]): Promise<{ results: T[] }[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results: { results: T[] }[] = [];
      for (const statement of statements) {
        results.push(await statement.all<T>());
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  /** Direct SQL for arranging fixtures and asserting on storage. */
  query(sql: string, ...params: Param[]): unknown[] {
    return this.sqlite.prepare(sql).all(...params);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
    return this.sqlite.prepare(sql).get(...params) as T | undefined;
  }

  exec(sql: string): void {
    this.sqlite.exec(sql);
  }
}

export const TEST_ORIGIN = "https://wafx-api.test";

export interface HarnessOptions {
  readonly publicOrigin?: string;
  readonly bootstrapToken?: string;
  readonly sessionTtlHours?: string;
  readonly loginMaxAttempts?: string;
  readonly loginWindowMinutes?: string;
}

export interface RequestOptions extends RequestInit {
  /** Attach the CSRF header a browser panel sends. */
  admin?: boolean;
  /** Set false to omit the Origin header, to test the CSRF check itself. */
  csrf?: boolean;
}

export interface Harness {
  readonly db: TestD1;
  readonly env: Record<string, unknown>;
  /** True once a session cookie has been issued by a login or bootstrap. */
  readonly signedIn: boolean;
  /** The current raw session token, for assertions on cookie handling. */
  sessionToken(): string | null;
  request(path: string, init?: RequestOptions): Promise<Response>;
  json<T = Record<string, unknown>>(
    path: string,
    init?: RequestOptions,
  ): Promise<{ status: number; body: T }>;
  close(): void;
}

/**
 * A Worker plus its bindings, reachable through `app.fetch`.
 *
 * The returned harness remembers a session cookie issued by any request, so most
 * tests can just call `h.json("/api/admin/apps")` after signing in. Tests that
 * care about CSRF or about an unauthenticated request pass headers explicitly;
 * `admin: false` does not suppress an existing cookie, so such a test should use
 * a fresh harness.
 */
export function harness(options: HarnessOptions = {}): Harness {
  const db = TestD1.create();
  const env: Record<string, unknown> = {
    DB: db,
    PUBLIC_ORIGIN: options.publicOrigin ?? TEST_ORIGIN,
    SESSION_TTL_HOURS: options.sessionTtlHours ?? "12",
    LOGIN_MAX_ATTEMPTS: options.loginMaxAttempts ?? "10",
    LOGIN_WINDOW_MINUTES: options.loginWindowMinutes ?? "15",
  };
  if (options.bootstrapToken !== undefined) env.BOOTSTRAP_TOKEN = options.bootstrapToken;

  let cookie: string | null = null;

  const request = async (path: string, init: RequestOptions = {}): Promise<Response> => {
    const { admin, csrf, headers, ...rest } = init;
    const merged = new Headers(headers);
    // The remembered cookie is a default, not an override: a test that supplies
    // its own `cookie` header is testing an unauthenticated request and must not
    // have the live session silently reattached.
    if (cookie !== null && !merged.has("cookie")) merged.set("cookie", cookie);

    const mutating = rest.method !== undefined && rest.method.toUpperCase() !== "GET";
    if (admin === true && mutating) merged.set("X-WAFI-Admin", "1");
    if (rest.body !== undefined && !merged.has("content-type")) {
      merged.set("content-type", "application/json");
    }
    // A browser panel sends Origin on mutating same-origin requests. Tests about
    // the CSRF check pass `csrf: false` or their own Origin.
    if (mutating && csrf !== false && !merged.has("origin")) merged.set("origin", TEST_ORIGIN);

    const response = await app.fetch(
      new Request(`https://wafx-api.test${path}`, { ...rest, headers: merged }),
      env,
    );

    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) {
      const parsed = /^([^=]+)=([^;]*)/.exec(setCookie);
      // A Max-Age=0 clear empties the value, which is how a logout is detected.
      cookie = parsed && parsed[2] !== "" ? `${parsed[1]}=${parsed[2]}` : null;
    }
    return response;
  };

  return {
    db,
    env,
    get signedIn(): boolean {
      return cookie !== null;
    },
    sessionToken: () => (cookie === null ? null : (cookie.split("=")[1] ?? null)),
    request,
    json: async <T,>(path: string, init?: RequestOptions) => {
      const response = await request(path, init);
      const text = await response.text();
      let body: unknown;
      try {
        body = text === "" ? {} : JSON.parse(text);
      } catch {
        body = { raw: text };
      }
      return { status: response.status, body: body as T };
    },
    close: () => db.sqlite.close(),
  };
}

/**
 * Stands in for the verifier the admin panel derives with PBKDF2.
 *
 * Tests cannot run 600,000 PBKDF2 rounds per login without making the suite slow,
 * and doing so would test Node's crypto rather than the code. What matters is the
 * shape (64 lowercase hex) and that the value is stable for a given input, so a
 * test can present the right one and the wrong one.
 */
export const fakeVerifier = (seed: string): string =>
  fastSha256Hex(`verifier:${seed}:${DEFAULT_ITERATIONS}`);

/** A 32-character hex salt, the shape the panel generates. */
export const testSalt = (seed = "salt"): string => fastSha256Hex(`salt:${seed}`).slice(0, 32);
