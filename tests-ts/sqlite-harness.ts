import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { Env, OrderCommand } from "../src/worker/types";

interface Statement {
  bind(...values: unknown[]): Statement;
  run(): Promise<{ meta: { changes: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

export function testEnvironment() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0002_rate_limits.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0003_users.sql", import.meta.url), "utf8"));
  const messages: OrderCommand[] = [];

  function prepare(sql: string): Statement {
    let bindings: SQLInputValue[] = [];
    return {
      bind(...values) { bindings = values as SQLInputValue[]; return this; },
      async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...bindings).changes) } }; },
      async first<T>() { return (sqlite.prepare(sql).get(...bindings) as T | undefined) ?? null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...bindings) as T[] }; }
    };
  }

  const db = {
    prepare,
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };

  const env = {
    DB: db as unknown as D1Database,
    ORDER_QUEUE: { async send(message: OrderCommand) { messages.push(message); } } as unknown as Queue<OrderCommand>,
    ASSETS: {} as Fetcher,
    ALPACA_API_KEY_ID: "test-key",
    ALPACA_API_SECRET_KEY: "test-secret",
    ALPACA_DATA_BASE_URL: "https://data.alpaca.markets",
    SESSION_PEPPER: "deterministic-test-pepper",
    APP_ENV: "test"
  } satisfies Env;

  return { sqlite, env, messages };
}
