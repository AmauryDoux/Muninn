// A backup is only real once it has been restored: build a snapshot, seal it like the cron, unseal it with the
// restore script, apply the SQL to an empty database, and read the data back with the same key.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import type { Env } from "../worker/env";
import { Cipher } from "../worker/lib/crypto";
import { setSetting } from "../worker/lib/settings";
import { Repo } from "../worker/repo";
import { buildSnapshot } from "../worker/core/snapshot";
import { utf8 } from "../worker/lib/b64";
import { makeD1 } from "./d1-shim";
// @ts-expect-error plain .mjs script without types
import { snapshotToSql, unseal } from "../scripts/restore.mjs";

const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

describe("backup and restore", () => {
  it("round-trips people, items, facts and sign-in through a sealed snapshot", async () => {
    const env = { DB: makeD1(), DATA_KEY: KEY } as unknown as Env;
    const cipher = await Cipher.fromSecret(KEY);
    const repo = new Repo(env, cipher, "UTC");
    await setSetting(env.DB, "setup_done", "1");
    await setSetting(env.DB, "password_verifier", "verifier");
    await setSetting(env.DB, "challenge:abc", "{}");
    const emma = await repo.createPerson("Emma O'Neil", "daughter", ["daughter"]);
    await repo.db
      .prepare("INSERT INTO captures (id, created_at, source, raw_text_enc, parser_version) VALUES ('C1', '2026-11-01T00:00:00Z', 'text', ?, 1)")
      .bind(await cipher.encrypt("buy sheets", "captures:C1:raw_text"))
      .run();
    await repo.db
      .prepare("INSERT INTO items (id, capture_id, kind, title_enc, for_person_id, status, created_at, updated_at) VALUES ('I1', 'C1', 'task', ?, ?, 'open', 'x', 'x')")
      .bind(await cipher.encrypt("Buy sheets", "items:I1:title"), emma.id)
      .run();
    await repo.db.prepare("INSERT INTO passkeys (id, public_key, counter, label, created_at) VALUES ('pk1', 'pub', 0, 'iPhone', 'x')").run();

    const name = "backup-2026-11-29.json.enc";
    const sealed = await cipher.sealBytes(utf8(JSON.stringify(await buildSnapshot(env.DB))), name);
    const snap = await unseal(sealed, name, KEY);
    await expect(unseal(sealed, "backup-other.json.enc", KEY)).rejects.toThrow();

    const sql: string = snapshotToSql(snap);
    expect(sql).not.toContain("challenge:abc");
    const fresh = new DatabaseSync(":memory:");
    fresh.exec("PRAGMA foreign_keys = ON");
    for (const f of readdirSync("migrations").sort()) fresh.exec(readFileSync(`migrations/${f}`, "utf8"));
    fresh.exec(sql);

    const item = fresh.prepare("SELECT title_enc, for_person_id FROM items WHERE id = 'I1'").get() as { title_enc: string; for_person_id: string };
    expect(await cipher.decrypt(item.title_enc, "items:I1:title")).toBe("Buy sheets");
    expect(item.for_person_id).toBe(emma.id);
    const person = fresh.prepare("SELECT name_enc FROM people WHERE id = ?").get(emma.id) as { name_enc: string };
    expect(await cipher.decrypt(person.name_enc, `people:${emma.id}:name`)).toBe("Emma O'Neil");
    expect(fresh.prepare("SELECT value FROM settings WHERE key = 'password_verifier'").get()).toEqual({ value: "verifier" });
    expect(fresh.prepare("SELECT COUNT(*) AS n FROM passkeys").get()).toEqual({ n: 1 });
  });

  it("refuses an old-style export and odd table names", () => {
    expect(() => snapshotToSql({ format: "muninn-export" })).toThrow(/--json/);
    expect(() => snapshotToSql({ format: "muninn-snapshot", tables: { "items; DROP TABLE x": [{ id: 1 }] } })).toThrow(/unexpected/);
  });
});
