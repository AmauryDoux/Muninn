// Integration tests: the engine, tips and Life routes against the real schema (node:sqlite stand-in for D1).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentTips, actOnTip, refreshTips } from "../worker/advice";
import { addFactSmart, applyCategory, fireTriggers, syncItemTriggers } from "../worker/engine";
import type { Env } from "../worker/env";
import { Cipher } from "../worker/lib/crypto";
import { ulid } from "../worker/lib/ulid";
import { Repo } from "../worker/repo";
import { actOnItem } from "../worker/routes/items";
import { createLifeItem, lifeSummary, listThings, patchLifeItem } from "../worker/routes/life";
import { DEFAULT_REMINDER_SETTINGS } from "../worker/core/reminders";
import { zonedToUtc } from "../worker/core/time";
import { makeD1 } from "./d1-shim";

const TZ = "Europe/Paris";
// Fresh random 32-byte key per run: no key-shaped literal in the repo.
const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
let repo: Repo;

const req = (body: unknown) => new Request("https://m.test/api/x", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://m.test" }, body: JSON.stringify(body) });
const body = async <T>(r: Response) => (await r.json()) as T;

beforeEach(async () => {
  vi.useRealTimers();
  const env = { DB: makeD1(), PARSE_MODEL: "claude-haiku-5-5", ANTHROPIC_API_KEY: "" } as unknown as Env;
  repo = new Repo(env, await Cipher.fromSecret(KEY), TZ);
});

async function triggers() {
  return (await repo.db.prepare("SELECT kind, anchor_date, offset_days, repeat, next_fire_at, occurrence_date, active FROM triggers ORDER BY next_fire_at").all<Record<string, unknown>>()).results;
}

describe("birthdays", () => {
  it("a birthday fact schedules the gift reminder and the day-of reminder; replacing it replaces them", async () => {
    const emma = await repo.createPerson("Emma", "daughter", ["daughter"]);
    await addFactSmart(repo, { subjectType: "person", subjectId: emma.id, key: "birthday", value: "--12-20", source: "told" }, TZ);
    let t = await triggers();
    expect(t.map((x) => [x.kind, x.offset_days, x.repeat])).toEqual([
      ["birthday_0", -14, "FREQ=YEARLY"],
      ["birthday_1", 0, "FREQ=YEARLY"],
    ]);
    const fact = await repo.db.prepare("SELECT value_type FROM facts WHERE key = 'birthday' AND active = 1").first<{ value_type: string }>();
    expect(fact?.value_type).toBe("date");
    await addFactSmart(repo, { subjectType: "person", subjectId: emma.id, key: "birthday", value: "2018-12-21", source: "told" }, TZ);
    t = await triggers();
    expect(t).toHaveLength(2);
    expect(t.every((x) => x.anchor_date === "2018-12-21")).toBe(true);
  });

  it("sizes on kids get a review date", async () => {
    const emma = await repo.createPerson("Emma", "daughter", []);
    await addFactSmart(repo, { subjectType: "person", subjectId: emma.id, key: "shoe_size", value: "31", source: "told" }, TZ);
    const f = await repo.db.prepare("SELECT review_after FROM facts WHERE key = 'shoe_size'").first<{ review_after: string }>();
    expect(f?.review_after).toBeTruthy();
  });
});

describe("firing", () => {
  it("creates one task per fire, links it to the source, schedules the next, and never double-fires", async () => {
    const r = await createLifeItem(repo, req({ subtype: "warranty", title: "TV", attrs: { bought_on: "2025-01-10", warranty_months: 24 }, thing_name: "TV", thing_kind: "appliance" }), TZ);
    const { item } = await body<{ item: { id: string; status: string; thing: { name: string } | null; status_line: { text: string } } }>(r);
    expect(item.status).toBe("open");
    expect(item.thing?.name).toBe("TV");
    const t = await triggers();
    expect(t).toMatchObject([{ kind: "warranty_end", anchor_date: "2027-01-10", offset_days: -30, occurrence_date: "2027-01-10" }]);
    const fireAt = new Date(t[0].next_fire_at as string);
    expect(await fireTriggers(repo, new Date(fireAt.getTime() - 1000), TZ)).toBe(0);
    expect(await fireTriggers(repo, fireAt, TZ)).toBe(1);
    expect(await fireTriggers(repo, fireAt, TZ)).toBe(0);
    const spawned = await repo.db.prepare("SELECT * FROM items WHERE source_trigger_id IS NOT NULL").all<{ id: string; title_enc: string; window_start: string; window_end: string }>();
    expect(spawned.results).toHaveLength(1);
    const view = (await repo.itemViews(spawned.results as never))[0];
    expect(view.title).toBe("Warranty ends 10 Jan 2027: TV");
    expect(view.from_reminder).toBe(true);
    // Window: from the fire day to the warranty end.
    expect(view.window_end).toBe(zonedToUtc(2027, 1, 11, 0, 0, TZ).toISOString());
    const link = await repo.db.prepare("SELECT role, target_id FROM links WHERE item_id = ?").bind(view.id).first<{ role: string; target_id: string }>();
    expect(link).toEqual({ role: "follow_up_of", target_id: item.id });
    expect((await triggers())[0].active).toBe(0);
  });

  it("a settled debt stops its monthly nudge", async () => {
    const mike = await repo.createPerson("Mike", "friend", []);
    const { item } = await body<{ item: { id: string } }>(await createLifeItem(repo, req({ subtype: "debt", title: "Lent Mike $40", for_person_id: mike.id, attrs: { direction: "they_owe_me", amount: "$40", since: "2026-11-01" } }), TZ));
    const t = await triggers();
    expect(t[0]).toMatchObject({ kind: "debt_nudge", repeat: "FREQ=MONTHLY", occurrence_date: "2026-12-01" });
    const at = new Date(t[0].next_fire_at as string);
    await repo.db.prepare("UPDATE items SET status = 'done' WHERE id = ?").bind(item.id).run();
    expect(await fireTriggers(repo, at, TZ)).toBe(0);
    expect((await triggers())[0].active).toBe(0);
  });

  it("repeating triggers move to the next occurrence", async () => {
    const mike = await repo.createPerson("Mike", "friend", []);
    await createLifeItem(repo, req({ subtype: "debt", title: "Lent Mike", for_person_id: mike.id, attrs: { direction: "they_owe_me", amount: "40", since: "2026-11-01" } }), TZ);
    const at = new Date((await triggers())[0].next_fire_at as string);
    expect(await fireTriggers(repo, at, TZ)).toBe(1);
    expect((await triggers())[0]).toMatchObject({ occurrence_date: "2027-01-01", active: 1 });
  });

  it("changing attributes re-plans triggers", async () => {
    const { item } = await body<{ item: { id: string } }>(await createLifeItem(repo, req({ subtype: "cert", title: "OSCP", attrs: { expires_on: "2028-06-01" } }), TZ));
    expect((await triggers()).map((t) => t.kind)).toEqual(["cert_expiry_90", "cert_expiry_30"]);
    await patchLifeItem(repo, new Request("https://m.test", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ attrs: { issuer: "OffSec" } }) }), item.id, TZ);
    expect(await triggers()).toEqual([]);
  });

  it("a newer service record replaces the older 'next service' reminder for the same thing", async () => {
    await createLifeItem(repo, req({ subtype: "service_record", title: "Boiler service", thing_name: "Boiler", attrs: { done_on: "2026-01-10", next_due_months: 12 } }), TZ);
    await createLifeItem(repo, req({ subtype: "service_record", title: "Boiler repair", thing_name: "the boiler", attrs: { done_on: "2026-11-20", next_due_months: 12 } }), TZ);
    const t = await triggers();
    expect(t).toHaveLength(1);
    expect(t[0].anchor_date).toBe("2027-11-20");
    expect((await body<{ things: unknown[] }>(await listThings(repo))).things).toHaveLength(1);
  });
});

describe("recurring and records", () => {
  it("records start as history; recurring tasks roll forward when done", async () => {
    const s = await body<{ item: { status: string } }>(await createLifeItem(repo, req({ subtype: "study_session", title: "HTB AD lab", attrs: { minutes: 90 } }), TZ));
    expect(s.item.status).toBe("done");
    const m = await body<{ item: { id: string; window_start: string; recurrence_text: string } }>(
      await createLifeItem(repo, req({ subtype: "medication", title: "Vitamin D", recurrence: "FREQ=DAILY", date: "2026-11-24", time: "08:00" }), TZ),
    );
    expect(m.item.recurrence_text).toBe("every day");
    const rs = { ...DEFAULT_REMINDER_SETTINGS, tz: TZ };
    vi.useFakeTimers({ now: zonedToUtc(2026, 11, 24, 8, 10, TZ), toFake: ["Date"] });
    const after = await body<{ item: { status: string; due_at: string } }>(await actOnItem(repo, req({ action: "done" }), m.item.id, rs));
    vi.useRealTimers();
    expect(after.item.status).toBe("open");
    expect(after.item.due_at).toBe(zonedToUtc(2026, 11, 25, 8, 0, TZ).toISOString());
  });

  it("rejects bad input from forms", async () => {
    await expect(createLifeItem(repo, req({ subtype: "nope", title: "x" }), TZ)).rejects.toMatchObject({ status: 400 });
    await expect(createLifeItem(repo, req({ subtype: "idea", title: "x", recurrence: "FREQ=HOURLY" }), TZ)).rejects.toMatchObject({ status: 400 });
    await expect(createLifeItem(repo, req({ subtype: "idea", title: "x", for_person_id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" }), TZ)).rejects.toMatchObject({ status: 400 });
    const w = await body<{ warnings: string[] }>(await createLifeItem(repo, req({ subtype: "debt", title: "x", attrs: { amount: "lots" } }), TZ));
    expect(w.warnings.sort()).toEqual(["amount_invalid", "direction_required"]);
  });
});

describe("summary and tips", () => {
  it("summarises balances per person", async () => {
    const mike = await repo.createPerson("Mike", "friend", []);
    await createLifeItem(repo, req({ subtype: "debt", title: "a", for_person_id: mike.id, attrs: { direction: "they_owe_me", amount: "40" } }), TZ);
    await createLifeItem(repo, req({ subtype: "debt", title: "b", for_person_id: mike.id, attrs: { direction: "i_owe_them", amount: "15" } }), TZ);
    const s = await body<{ balances: { name: string; minor: number }[]; groups: { id: string; categories: { subtype: string; open: number }[] }[] }>(await lifeSummary(repo, TZ));
    expect(s.balances).toEqual([expect.objectContaining({ name: "Mike", minor: 2500, cur: "USD" })]);
    expect(s.groups.find((g) => g.id === "money")!.categories.find((c) => c.subtype === "debt")!.open).toBe(2);
  });

  it("stores tips encrypted, respects dismiss forever, and expires tips whose cause is gone", async () => {
    const mk = async (title: string) => {
      const id = ulid();
      const iso = new Date().toISOString();
      await repo.db
        .prepare("INSERT INTO items (id, kind, title_enc, place_hint, status, created_at, updated_at) VALUES (?, 'task', ?, 'pharmacy', 'open', ?, ?)")
        .bind(id, await repo.cipher.encrypt(title, `items:${id}:title`), iso, iso)
        .run();
      return id;
    };
    const a = await mk("Buy plasters");
    await mk("Pick up prescription");
    let tips = await currentTips(repo, new Date(), TZ);
    expect(tips.map((t) => t.rule)).toEqual(["errand_group"]);
    expect(tips[0].because).toHaveLength(2);
    const raw = await repo.db.prepare("SELECT content_enc FROM tips").first<{ content_enc: string }>();
    expect(raw!.content_enc).not.toContain("plasters");
    await actOnTip(repo, tips[0].id, "dismiss", new Date());
    await refreshTips(repo, new Date(), TZ, false);
    expect(await currentTips(repo, new Date(), TZ)).toEqual([]);
    // A third pharmacy item is a new situation (new key), so a new tip may appear; closing one ends it.
    await repo.db.prepare("UPDATE items SET status = 'done' WHERE id = ?").bind(a).run();
    await refreshTips(repo, new Date(), TZ, false);
    tips = await currentTips(repo, new Date(), TZ);
    expect(tips).toEqual([]);
  });

  it("can be switched off", async () => {
    await repo.db.prepare("INSERT INTO settings (key, value) VALUES ('tips_enabled', '0')").run();
    expect(await currentTips(repo, new Date(), TZ)).toEqual([]);
  });
});

describe("applyCategory", () => {
  it("inventory details land on the thing", async () => {
    const id = ulid();
    const iso = new Date().toISOString();
    await repo.db.prepare("INSERT INTO items (id, kind, title_enc, status, created_at, updated_at) VALUES (?, 'note', ?, 'open', ?, ?)").bind(id, await repo.cipher.encrypt("Spare key", `items:${id}:title`), iso, iso).run();
    await applyCategory(repo, id, { subtype: "inventory", attrs: [{ key: "location", value: "blue drawer" }], thing: { name: "spare car key", kind: "key" } }, TZ, "USD");
    const things = (await body<{ things: { name: string; attrs: Record<string, string>; items: number }[] }>(await listThings(repo))).things;
    expect(things).toEqual([expect.objectContaining({ name: "Spare car key", attrs: { location: "blue drawer" }, items: 1 })]);
    const row = await repo.getItemRow(id);
    await syncItemTriggers(repo, row!, TZ);
    expect(await triggers()).toEqual([]);
  });
});
