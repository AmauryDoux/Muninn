// A minimal D1 stand-in over node:sqlite, so the I/O layer (engine, tips, routes) runs against the real
// migrations in tests. Only what Muninn uses: prepare/bind/first/all/run and batch.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type Val = string | number | null | Uint8Array;

class Stmt {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: Val[] = [],
  ) {}
  bind(...p: unknown[]) {
    return new Stmt(this.db, this.sql, p.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : (v as Val))));
  }
  async first<T>(): Promise<T | null> {
    return ((this.db.prepare(this.sql).get(...this.params) as T) ?? null) as T | null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })) as T[] };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes) } };
  }
  exec() {
    return this.db.prepare(this.sql).run(...this.params);
  }
}

export function makeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync("migrations").sort()) db.exec(readFileSync(`migrations/${f}`, "utf8"));
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => ({ meta: { changes: Number(s.exec().changes) } }));
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
}
