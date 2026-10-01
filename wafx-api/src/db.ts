/**
 * D1 access helpers.
 *
 * Thin on purpose. The schema in migrations/0001_init.sql is the thing that
 * decides what is storable; these helpers exist so call sites read as SQL and
 * so a driver-level failure surfaces as a 500 rather than an unhandled throw.
 */

import type { Config } from "./env.ts";
import { HttpError } from "./errors.ts";

/** One row as D1 returns it: every column nullable, numbers may be bigint. */
export type Row = Record<string, unknown>;

export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Row>(): Promise<T | null>;
  all<T = Row>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export interface Database {
  prepare(query: string): Statement;
  batch<T = Row>(statements: Statement[]): Promise<{ results: T[] }[]>;
}

/**
 * D1 has no transactions across statements, and no UPSERT-with-RETURNING that
 * behaves the same everywhere. Where a write must be conditional on a read,
 * `batch` runs the statements in order inside one implicit transaction, which
 * is the closest equivalent available.
 */
export class Db {
  // An explicit field rather than a `constructor(private readonly raw: Database)`
  // parameter property: Node runs this code by stripping types, and parameter
  // properties need a real transform. `erasableSyntaxOnly` enforces that here.
  private readonly raw: Database;

  constructor(raw: Database) {
    this.raw = raw;
  }

  prepare(query: string): Statement {
    return this.raw.prepare(query);
  }

  async first<T = Row>(query: string, ...values: unknown[]): Promise<T | null> {
    try {
      return await this.raw.prepare(query).bind(...values).first<T>();
    } catch (error) {
      throw dbFailure("first", query, error);
    }
  }

  async all<T = Row>(query: string, ...values: unknown[]): Promise<T[]> {
    try {
      const result = await this.raw.prepare(query).bind(...values).all<T>();
      // D1's types say `results` is always an array; the runtime has shipped
      // drivers that omit it for a statement returning nothing. The fallback is
      // unreachable per the types and kept anyway, because "no rows" and "no
      // result set" must look the same to every caller.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      return result.results ?? [];
    } catch (error) {
      throw dbFailure("all", query, error);
    }
  }

  async run(query: string, ...values: unknown[]): Promise<{ changes: number }> {
    try {
      const result = await this.raw.prepare(query).bind(...values).run();
      return { changes: result.meta.changes ?? 0 };
    } catch (error) {
      throw dbFailure("run", query, error);
    }
  }

  async batch(statements: Statement[]): Promise<void> {
    try {
      await this.raw.batch(statements);
    } catch (error) {
      // The statements' SQL is not included: it can contain a bound value.
      throw dbFailure("batch", "<multiple statements>", error);
    }
  }
}

/**
 * Turns a driver error into a 500 and logs the detail. The SQL reaches the
 * console but never the response, because a failing query can embed whatever
 * the caller submitted.
 */
function dbFailure(operation: string, query: string, error: unknown): HttpError {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`db ${operation} failed: ${detail}\n  sql: ${query}`);
  return new HttpError("internal", "The request could not be completed");
}

/** D1 returns booleans as 0/1; the panel sends real booleans. */
export const bool = (value: boolean): number => (value ? 1 : 0);

/** Timestamps are ISO-8601 UTC strings everywhere, generated in SQL or here. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Used by the session and rate-limit helpers. Sliding expiry is what makes a
 * 12-hour cookie mean "12 hours of use" rather than "12 hours from login",
 * which matters for an operator who leaves the panel open all day.
 */
export function isoInHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function sessionExpiry(config: Config): string {
  return isoInHours(config.sessionTtlHours);
}
