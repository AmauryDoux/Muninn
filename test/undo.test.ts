// Undo puts an item back exactly as it was, including a recurring item that rolled forward, and only for 10 minutes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/env";
import { Cipher } from "../worker/lib/crypto";
import { Repo } from "../worker/repo";
import { DEFAULT_REMINDER_SETTINGS } from "../worker/core/reminders";
import { actOnItem } from "../worker/routes/items";
import { makeD1 } from "./d1-shim";

const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const rs = { ...DEFAULT_REMINDER_SETTINGS, tz: "UTC" };
let repo: Repo;
const ID = "01J00000000000000000000001";

const act = (action: string, preset?: string) =>
  actOnItem(repo, new Request("https://m.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, preset }) }), ID, rs);
const row = () => repo.db.prepare("SELECT status, window_start, window_end, snoozed_until FROM items WHERE id = ?").bind(ID).first<Record<string, string | null>>();

beforeEach(async () => {
  const env = { DB: makeD1() } as unknown as Env;
  const cipher = await Cipher.fromSecret(KEY);
  repo = new Repo(env, cipher, "UTC");
  await repo.db
    .prepare("INSERT INTO items (id, kind, title_enc, status, window_start, window_end, recurrence, created_at, updated_at) VALUES (?, 'task', ?, 'open', '2026-11-24T00:00:00.000Z', '2026-11-25T00:00:00.000Z', ?, 'x', 'x')")
    .bind(ID, await cipher.encrypt("Take pills", `items:${ID}:title`), null)
    .run();
});

describe("undo", () => {
  it("reopens a done item", async () => {
    await act("done");
    expect((await row())!.status).toBe("done");
    await act("undo");
    expect((await row())!.status).toBe("open");
    const types = await repo.db.prepare("SELECT type FROM events ORDER BY at").all<{ type: string }>();
    expect(types.results.map((t) => t.type)).toContain("done_undone");
  });

  it("puts a recurring item back on its old date", async () => {
    await repo.db.prepare("UPDATE items SET recurrence = 'FREQ=DAILY' WHERE id = ?").bind(ID).run();
    const before = await row();
    await act("done");
    expect((await row())!.window_start).not.toBe(before!.window_start);
    await act("undo");
    expect(await row()).toEqual(before);
  });

  it("clears a snooze", async () => {
    await act("snooze", "tomorrow");
    expect((await row())!.snoozed_until).not.toBeNull();
    await act("undo");
    expect((await row())!.snoozed_until).toBeNull();
  });

  it("refuses after 10 minutes or with nothing to undo", async () => {
    await expect(act("undo")).rejects.toMatchObject({ status: 409 });
    vi.useFakeTimers({ now: Date.now() });
    await act("done");
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await expect(act("undo")).rejects.toMatchObject({ status: 409 });
    vi.useRealTimers();
  });
});
