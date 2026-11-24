// Turns a weekly backup from R2 into SQL you can apply to D1. Runs on your computer; nothing is uploaded.
//
//   npx wrangler r2 object get muninn-backups/backup-2026-11-29.json.enc --remote --file backup.enc
//   DATA_KEY=... node scripts/restore.mjs backup.enc backup-2026-11-29.json.enc > restore.sql
//   npx wrangler d1 execute muninn --remote --file restore.sql
//
// The second argument is the object's name in R2: it is the associated data the backup was sealed with.
// Add --json to print the decrypted snapshot instead of SQL (encrypted columns stay encrypted).
// The SQL replaces every row it contains (INSERT OR REPLACE) and deletes nothing else: restore into a fresh database
// (`wrangler d1 create`, then `npm run db:migrate:remote`) for an exact copy.
import { readFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

export async function unseal(bytes, name, dataKeyB64url) {
  const raw = Buffer.from(dataKeyB64url, "base64url");
  if (raw.length !== 32) throw new Error("DATA_KEY must be 32 bytes (base64url)");
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const aes = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("muninn/aes-gcm/v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(name) }, aes, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

const sqlValue = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replaceAll("'", "''")}'`;
};
const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unexpected name in backup: ${s}`);
  return s;
};

/** SQL statements for a snapshot, in the order the tables were saved (foreign-key order). */
export function snapshotToSql(snap) {
  if (snap?.format !== "muninn-snapshot") {
    throw new Error("Not a restorable snapshot. Backups made before this version are decrypted exports: use --json to read them.");
  }
  const out = ["PRAGMA defer_foreign_keys = ON;"];
  for (const [table, rows] of Object.entries(snap.tables)) {
    for (const row of rows) {
      const cols = Object.keys(row).map(ident);
      out.push(`INSERT OR REPLACE INTO ${ident(table)} (${cols.join(", ")}) VALUES (${cols.map((c) => sqlValue(row[c])).join(", ")});`);
    }
  }
  return out.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, name] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const asJson = process.argv.includes("--json");
  if (!file || !name || !process.env.DATA_KEY) {
    console.error("Usage: DATA_KEY=... node scripts/restore.mjs <downloaded file> <object name in R2> [--json] > restore.sql");
    process.exit(2);
  }
  const snap = await unseal(new Uint8Array(readFileSync(file)), name, process.env.DATA_KEY);
  process.stdout.write(asJson ? JSON.stringify(snap, null, 2) : snapshotToSql(snap));
}
