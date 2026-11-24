import { describe, expect, it } from "vitest";
import { statusLine } from "../worker/core/categories";
import { firstWindow, rollRecurring } from "../worker/core/recurring";
import { recurrenceToRule } from "../worker/core/rrule";
import { matchThing } from "../worker/core/things";
import { parseCivil, zonedToUtc } from "../worker/core/time";

const TZ = "Europe/Paris";

describe("rollRecurring", () => {
  it("keeps the time of day for a daily pill, across DST", () => {
    const due = zonedToUtc(2026, 3, 28, 8, 0, TZ).toISOString();
    const w = rollRecurring({ window_start: due, window_end: zonedToUtc(2026, 3, 29, 0, 0, TZ).toISOString(), due_at: due }, "FREQ=DAILY", zonedToUtc(2026, 3, 28, 8, 5, TZ), TZ)!;
    expect(w.due_at).toBe(zonedToUtc(2026, 3, 29, 8, 0, TZ).toISOString());
    expect(new Date(w.due_at!).getUTCHours()).toBe(6); // 08:00 CEST
  });
  it("a chore finished late does not leave the next one overdue", () => {
    const start = zonedToUtc(2026, 1, 10, 0, 0, TZ).toISOString();
    const end = zonedToUtc(2026, 1, 11, 0, 0, TZ).toISOString();
    const w = rollRecurring({ window_start: start, window_end: end, due_at: null }, "FREQ=MONTHLY;INTERVAL=3", zonedToUtc(2026, 5, 20, 12, 0, TZ), TZ)!;
    expect(w.window_start).toBe(zonedToUtc(2026, 7, 10, 0, 0, TZ).toISOString());
    expect(w.window_end).toBe(zonedToUtc(2026, 7, 11, 0, 0, TZ).toISOString());
  });
  it("keeps a multi-day window's length", () => {
    const w = rollRecurring(
      { window_start: zonedToUtc(2026, 10, 1, 0, 0, TZ).toISOString(), window_end: zonedToUtc(2026, 11, 1, 0, 0, TZ).toISOString(), due_at: null },
      "FREQ=YEARLY;BYMONTH=10",
      zonedToUtc(2026, 10, 15, 12, 0, TZ),
      TZ,
    )!;
    expect(w.window_start).toBe(zonedToUtc(2027, 10, 1, 0, 0, TZ).toISOString());
    expect(w.window_end).toBe(zonedToUtc(2027, 11, 1, 0, 0, TZ).toISOString());
  });
  it("rejects bad rules", () => expect(rollRecurring({ window_start: null, window_end: null, due_at: null }, "FREQ=SOMETIMES", new Date(), TZ)).toBeNull());
});

describe("firstWindow", () => {
  const now = zonedToUtc(2026, 11, 24, 12, 0, TZ);
  it("this year's month when still ahead or current, else next year's", () => {
    expect(firstWindow("FREQ=YEARLY;BYMONTH=12", now, TZ)!.window_start).toBe(zonedToUtc(2026, 12, 1, 0, 0, TZ).toISOString());
    expect(firstWindow("FREQ=YEARLY;BYMONTH=10", now, TZ)!.window_start).toBe(zonedToUtc(2027, 10, 1, 0, 0, TZ).toISOString());
    expect(firstWindow("FREQ=DAILY", now, TZ)!.window_start).toBe(zonedToUtc(2026, 11, 24, 0, 0, TZ).toISOString());
  });
});

describe("recurrenceToRule", () => {
  it("builds valid rules and drops junk", () => {
    expect(recurrenceToRule({ freq: "weekly", interval: 2, by_weekday: [1, 4, 9] })).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH");
    expect(recurrenceToRule({ freq: "yearly", by_month: [10] })).toBe("FREQ=YEARLY;BYMONTH=10");
    expect(recurrenceToRule({ freq: "daily", by_month: [3] })).toBe("FREQ=DAILY");
    expect(recurrenceToRule(null)).toBeNull();
  });
});

describe("matchThing", () => {
  const things = [
    { id: "1", name: "Spare car key", kind: "key" },
    { id: "2", name: "TV", kind: "appliance" },
    { id: "3", name: "Car", kind: "vehicle" },
    { id: "4", name: "Dishwasher", kind: "appliance" },
  ];
  it.each([
    ["the TV", "2"],
    ["my car", "3"],
    ["spare key", "1"],
    ["spare car keys", "1"],
    ["the dishwasher", "4"],
    ["key", null],
    ["fridge", null],
  ])("%s", (m, id) => expect(matchThing(things, m)?.id ?? null).toBe(id));
});

describe("statusLine", () => {
  const today = parseCivil("2026-11-24")!;
  it("warranty, debt, cert, service", () => {
    expect(statusLine("warranty", { expires_on: "2026-12-10" }, "open", today)).toEqual({ text: "Covered until 10 Dec 2026 · 16 days", tone: "warn" });
    expect(statusLine("warranty", { expires_on: "2025-12-10" }, "open", today)?.tone).toBe("muted");
    expect(statusLine("debt", { direction: "they_owe_me", amount: { minor: 4000, cur: "USD" } }, "open", today)?.text).toBe("Owes you $40.00");
    expect(statusLine("debt", { direction: "they_owe_me", amount: { minor: 4000, cur: "USD" } }, "done", today)?.text).toBe("Settled · $40.00");
    expect(statusLine("cert", { expires_on: "2027-01-01", cpe_required: 40, cpe_done: 12 }, "open", today)).toEqual({ text: "Valid until 1 Jan 2027 · 12/40 CPE", tone: "warn" });
    expect(statusLine("service_record", { done_on: "2025-10-01", next_due_months: 12 }, "done", today)?.tone).toBe("bad");
    expect(statusLine("idea", null, "open", today)).toBeNull();
  });
});
