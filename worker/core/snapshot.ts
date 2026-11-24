// Restorable backup: the tables as stored (encrypted columns stay encrypted), then the whole file is sealed with
// DATA_KEY. Restoring needs nothing but the file and DATA_KEY: `node scripts/restore.mjs` turns it into SQL for
// `wrangler d1 execute`. Unlike the JSON export (decrypted, for you to read), this brings back sign-in too.

/** In foreign-key order. Left out: sessions and login attempts (short-lived), push devices (re-subscribe after a
 * restore) and search vectors (rebuilt by the cron from the notes). */
export const SNAPSHOT_TABLES = [
  "settings",
  "people",
  "captures",
  "items",
  "facts",
  "things",
  "places",
  "links",
  "triggers",
  "patterns",
  "tips",
  "events",
  "passkeys",
  "api_tokens",
] as const;

/** Settings that are only transient state. */
const SKIP_SETTING = /^(challenge:|brief:|cron_last_run$)/;

export interface Snapshot {
  format: "muninn-snapshot";
  version: 1;
  created_at: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function buildSnapshot(db: D1Database, now = new Date()): Promise<Snapshot> {
  const tables: Snapshot["tables"] = {};
  for (const t of SNAPSHOT_TABLES) {
    const { results } = await db.prepare(`SELECT * FROM ${t}`).all<Record<string, unknown>>();
    tables[t] = t === "settings" ? results.filter((r) => !SKIP_SETTING.test(String(r.key))) : results;
  }
  return { format: "muninn-snapshot", version: 1, created_at: now.toISOString(), tables };
}
