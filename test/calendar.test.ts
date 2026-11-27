// Daily summary and calendar: holidays, important dates and items land on the right local day.
import { describe, expect, it } from "vitest";
import type { Env } from "../worker/env";
import { Cipher } from "../worker/lib/crypto";
import { Repo } from "../worker/repo";
import { calendarEntries, daySummary, getCalendar } from "../worker/calendar";
import { dateFactDays, dateFactTitle, dayHeadline, holidayLine, itemDay, longDate } from "../worker/core/day";
import { parseCivil } from "../worker/core/time";
import { makeD1 } from "./d1-shim";

const d = (s: string) => parseCivil(s)!;
const TZ = "America/Chicago";
const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

describe("headline", () => {
  it("Thanksgiving", () => {
    expect(dayHeadline(d("2026-11-26"), [{ name: "Thanksgiving", kind: "federal" }])).toBe("Today is Thursday, November 26. Happy Thanksgiving!");
  });
  it("a plain day", () => {
    expect(dayHeadline(d("2026-11-30"), [])).toBe("Today is Monday, November 30.");
    expect(longDate(d("2027-01-01"))).toBe("Friday, January 1");
  });
  it("prefers the real federal holiday over a notable day or an observed day", () => {
    expect(dayHeadline(d("2027-12-31"), [{ name: "New Year's Day (observed)", kind: "federal" }, { name: "New Year's Eve", kind: "observance" }])).toBe(
      "Today is Friday, December 31. It's New Year's Eve.",
    );
    expect(dayHeadline(d("2026-07-03"), [{ name: "Independence Day (observed)", kind: "federal" }])).toBe("Today is Friday, July 3. It's Independence Day (observed).");
  });
  it("greetings", () => {
    expect(holidayLine({ name: "Christmas Day" })).toBe("Merry Christmas!");
    expect(holidayLine({ name: "Veterans Day" })).toBe("It's Veterans Day.");
    expect(holidayLine({ name: "Clocks go back an hour" })).toBe("Clocks went back an hour last night.");
  });
});

describe("dateFactDays", () => {
  it("a yearly date repeats, but not before the birth year", () => {
    expect(dateFactDays({ year: 1990, month: 3, day: 3 }, true, d("2026-01-01"), d("2027-12-31"))).toEqual([d("2026-03-03"), d("2027-03-03")]);
    expect(dateFactDays({ year: 2027, month: 3, day: 3 }, true, d("2026-01-01"), d("2027-12-31"))).toEqual([d("2027-03-03")]);
    expect(dateFactDays({ year: null, month: 3, day: 3 }, true, d("2026-03-04"), d("2026-04-01"))).toEqual([]);
  });
  it("29 February falls on 28 February in common years", () => {
    expect(dateFactDays({ year: null, month: 2, day: 29 }, true, d("2027-02-01"), d("2027-03-01"))).toEqual([d("2027-02-28")]);
    expect(dateFactDays({ year: null, month: 2, day: 29 }, true, d("2028-02-01"), d("2028-03-01"))).toEqual([d("2028-02-29")]);
  });
  it("a one-off date appears once, and only with a year", () => {
    expect(dateFactDays({ year: 2026, month: 12, day: 1 }, false, d("2026-11-01"), d("2026-12-31"))).toEqual([d("2026-12-01")]);
    expect(dateFactDays({ year: 2027, month: 12, day: 1 }, false, d("2026-11-01"), d("2026-12-31"))).toEqual([]);
    expect(dateFactDays({ year: null, month: 12, day: 1 }, false, d("2026-11-01"), d("2026-12-31"))).toEqual([]);
  });
  it("titles", () => {
    expect(dateFactTitle({ key: "birthday", label: "Birthday", who: "Emma", age: 7 })).toBe("Emma's birthday (turns 7)");
    expect(dateFactTitle({ key: "birthday", label: "Birthday", who: "Emma", age: null })).toBe("Emma's birthday");
    expect(dateFactTitle({ key: "birthday", label: "Birthday", who: "Emma", age: 0 })).toBe("Emma's birthday");
    expect(dateFactTitle({ key: "passport_expiry", label: "Passport expires", who: "Sam", age: null })).toBe("Passport expires (Sam)");
    expect(dateFactTitle({ key: "anniversary", label: "Anniversary", who: null, age: null })).toBe("Anniversary");
  });
});

describe("itemDay", () => {
  it("a timed item: its local day, even when UTC is already tomorrow", () => {
    // 20:00 in Chicago on 26 Nov is 02:00 UTC on 27 Nov.
    expect(itemDay({ due_at: "2026-11-27T02:00:00.000Z", window_start: "2026-11-27T02:00:00.000Z", window_end: null }, TZ)).toEqual({ date: "2026-11-26", by: false });
  });
  it("a one-day window", () => {
    expect(itemDay({ due_at: null, window_start: "2026-12-01T06:00:00.000Z", window_end: "2026-12-02T06:00:00.000Z" }, TZ)).toEqual({ date: "2026-12-01", by: false });
  });
  it("a longer window lands on its last day, as a deadline", () => {
    expect(itemDay({ due_at: null, window_start: "2026-11-30T06:00:00.000Z", window_end: "2026-12-07T06:00:00.000Z" }, TZ)).toEqual({ date: "2026-12-06", by: true });
  });
  it("no date", () => {
    expect(itemDay({ due_at: null, window_start: null, window_end: null }, TZ)).toBeNull();
  });
});

async function setup() {
  const env = { DB: makeD1(), PARSE_MODEL: "claude-haiku-5-5", ANTHROPIC_API_KEY: "" } as unknown as Env;
  const cipher = await Cipher.fromSecret(KEY);
  const repo = new Repo(env, cipher, TZ);
  const item = async (id: string, status: string, due: string | null, start: string | null, end: string | null) =>
    env.DB.prepare("INSERT INTO items (id, kind, title_enc, status, due_at, window_start, window_end, created_at, updated_at) VALUES (?, 'task', ?, ?, ?, ?, ?, 'x', 'x')")
      .bind(id, await cipher.encrypt(`Item ${id}`, `items:${id}:title`), status, due, start, end)
      .run();
  const emma = await repo.createPerson("Emma", "daughter", []);
  const fid = await repo.addFact({ subjectType: "person", subjectId: emma.id, key: "birthday", value: "2019-11-28", source: "told" });
  await env.DB.prepare("UPDATE facts SET value_type = 'date' WHERE id = ?").bind(fid).run();
  await item("T1", "open", "2026-11-26T22:00:00.000Z", "2026-11-26T22:00:00.000Z", null); // 16:00 today
  await item("D1", "done", null, "2026-11-26T06:00:00.000Z", "2026-11-27T06:00:00.000Z"); // done today
  await item("W1", "open", null, "2026-11-30T06:00:00.000Z", "2026-12-07T06:00:00.000Z"); // next week, by Sun 6 Dec
  await item("X1", "dropped", "2026-11-26T18:00:00.000Z", null, null); // dropped: never shown
  await item("A1", "open", null, null, null); // anytime: not on a calendar
  return { env, repo, emma };
}

describe("calendar entries", () => {
  it("holidays, birthdays, events and items, in day order", async () => {
    const { repo, emma } = await setup();
    const events = async () => [{ kind: "event" as const, date: "2026-11-26", title: "Dinner at Mom's", id: "g1", at: "2026-11-26T23:00:00.000Z", end: null, all_day: false, calendar: "Family", color: null, location: null }];
    const e = await calendarEntries(repo, d("2026-11-26"), d("2026-12-06"), TZ, events);
    expect(e.map((x) => `${x.date} ${x.kind} ${x.title}`)).toEqual([
      "2026-11-26 holiday Thanksgiving",
      "2026-11-26 event Dinner at Mom's",
      "2026-11-26 item Item D1",
      "2026-11-26 item Item T1",
      "2026-11-27 holiday Black Friday",
      "2026-11-28 date Emma's birthday (turns 7)",
      "2026-12-06 item Item W1",
    ]);
    expect(e.find((x) => x.kind === "date")).toMatchObject({ person_id: emma.id, key: "birthday" });
    expect(e.find((x) => x.kind === "item" && x.id === "W1")).toMatchObject({ by: true, done: false });
    expect(e.find((x) => x.kind === "item" && x.id === "D1")).toMatchObject({ done: true });
  });

  it("respects the holidays setting", async () => {
    const { repo, env } = await setup();
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('holidays', 'federal')").run();
    const e = await calendarEntries(repo, d("2026-11-26"), d("2026-11-27"), TZ);
    expect(e.filter((x) => x.kind === "holiday").map((x) => x.title)).toEqual(["Thanksgiving"]);
    await env.DB.prepare("UPDATE settings SET value = 'off' WHERE key = 'holidays'").run();
    expect((await calendarEntries(repo, d("2026-11-26"), d("2026-11-27"), TZ)).filter((x) => x.kind === "holiday")).toEqual([]);
  });

  it("a failing event source does not take the calendar down", async () => {
    const { repo } = await setup();
    const warn = console.warn;
    console.warn = () => {};
    try {
      const e = await calendarEntries(repo, d("2026-11-26"), d("2026-11-26"), TZ, async () => {
        throw new Error("google down");
      });
      expect(e.some((x) => x.kind === "holiday")).toBe(true);
    } finally {
      console.warn = warn;
    }
  });

  it("GET /api/calendar validates the range", async () => {
    const { repo } = await setup();
    const call = (q: string) => getCalendar(repo, new URL(`https://m.test/api/calendar?${q}`), TZ);
    await expect(call("from=2026-11-01&to=2026-10-01")).rejects.toMatchObject({ status: 400 });
    await expect(call("from=2026-01-01&to=2026-12-31")).rejects.toMatchObject({ status: 400 });
    await expect(call("from=2026-02-30&to=2026-03-01")).rejects.toMatchObject({ status: 400 });
    await expect(call("from=x")).rejects.toMatchObject({ status: 400 });
    const r = (await (await call("from=2026-10-26&to=2026-12-06")).json()) as { entries: { title: string }[] };
    expect(r.entries.map((x) => x.title)).toContain("Thanksgiving");
    expect(r.entries.map((x) => x.title)).toContain("Halloween");
    expect(r.entries.map((x) => x.title)).toContain("Clocks go back an hour");
  });
});

describe("day summary", () => {
  it("Thanksgiving morning in Chicago", async () => {
    const { repo } = await setup();
    const s = await daySummary(repo, new Date("2026-11-26T14:00:00Z"), TZ);
    expect(s.date).toBe("2026-11-26");
    expect(s.headline).toBe("Today is Thursday, November 26. Happy Thanksgiving!");
    expect(s.today.map((x) => x.title)).toEqual(["Thanksgiving"]); // items are listed on Today already
    expect(s.soon.map((x) => `${x.date} ${x.title}`)).toEqual(["2026-11-27 Black Friday", "2026-11-28 Emma's birthday (turns 7)"]);
  });
  it("late evening in Chicago is still the same local day", async () => {
    const { repo } = await setup();
    const s = await daySummary(repo, new Date("2026-11-27T05:30:00Z"), TZ); // 23:30 on the 26th
    expect(s.date).toBe("2026-11-26");
  });
});
