import { describe, expect, it } from "vitest";
import { inQuietHours, resolveTimeRef, zonedToUtc, type TimeRef } from "../worker/core/time";

const TZ = "Europe/Paris";
// Monday 23 November 2026, 10:00 in Paris.
const NOW = zonedToUtc(2026, 11, 23, 10, 0, TZ);
const ref = (r: Partial<TimeRef>): TimeRef => ({ type: "relative", date: null, end_date: null, unit: null, offset: null, weekday: null, time: null, ...r });

describe("resolveTimeRef", () => {
  it("next week is Monday to Sunday (spec example)", () => {
    const w = resolveTimeRef(ref({ unit: "week", offset: 1 }), NOW, TZ)!;
    expect([w.startDate, w.endDate]).toEqual(["2026-11-30", "2026-12-06"]);
    expect(w.start.toISOString()).toBe("2026-11-29T23:00:00.000Z"); // local midnight, UTC+1
    expect(w.end.toISOString()).toBe("2026-12-06T23:00:00.000Z"); // exclusive
  });

  it("two weeks ago", () => {
    const w = resolveTimeRef(ref({ unit: "week", offset: -2 }), NOW, TZ)!;
    expect([w.startDate, w.endDate]).toEqual(["2026-11-09", "2026-11-15"]);
  });

  it("tomorrow with a time sets due_at", () => {
    const w = resolveTimeRef(ref({ unit: "day", offset: 1, time: "15:30" }), NOW, TZ)!;
    expect(w.startDate).toBe("2026-11-24");
    expect(w.dueAt!.toISOString()).toBe("2026-11-24T14:30:00.000Z");
  });

  it("in 5 minutes and in 2 hours are exact moments from now", () => {
    const m = resolveTimeRef(ref({ unit: "minute", offset: 5 }), NOW, TZ)!;
    expect(m.dueAt!.toISOString()).toBe("2026-11-23T09:05:00.000Z");
    expect(m.start.toISOString()).toBe(m.dueAt!.toISOString());
    expect(m.startDate).toBe("2026-11-23");
    const h = resolveTimeRef(ref({ unit: "hour", offset: 2 }), NOW, TZ)!;
    expect(h.dueAt!.toISOString()).toBe("2026-11-23T11:00:00.000Z");
  });

  it("in 3 hours late at night lands on the next local day", () => {
    const late = zonedToUtc(2026, 11, 23, 23, 0, TZ);
    const w = resolveTimeRef(ref({ unit: "hour", offset: 3 }), late, TZ)!;
    expect(w.startDate).toBe("2026-11-24");
    expect(w.dueAt!.toISOString()).toBe("2026-11-24T01:00:00.000Z");
  });

  it("rounds up to the next minute and rejects nonsense offsets", () => {
    const w = resolveTimeRef(ref({ unit: "minute", offset: 5 }), new Date(NOW.getTime() + 20_000), TZ)!;
    expect(w.dueAt!.toISOString()).toBe("2026-11-23T09:06:00.000Z");
    expect(resolveTimeRef(ref({ unit: "minute", offset: 0 }), NOW, TZ)).toBeNull();
    expect(resolveTimeRef(ref({ unit: "hour", offset: -1 }), NOW, TZ)).toBeNull();
    expect(resolveTimeRef(ref({ unit: "hour", offset: 24 * 8 }), NOW, TZ)).toBeNull();
  });

  it("this weekend and next weekend", () => {
    expect(resolveTimeRef(ref({ unit: "weekend", offset: 0 }), NOW, TZ)!.startDate).toBe("2026-11-28");
    expect(resolveTimeRef(ref({ unit: "weekend", offset: 1 }), NOW, TZ)!.endDate).toBe("2026-12-06");
    const sunday = zonedToUtc(2026, 11, 29, 12, 0, TZ);
    expect(resolveTimeRef(ref({ unit: "weekend", offset: 0 }), sunday, TZ)!.startDate).toBe("2026-11-28");
  });

  it("next month crosses the year", () => {
    const dec = zonedToUtc(2026, 12, 10, 12, 0, TZ);
    const w = resolveTimeRef(ref({ unit: "month", offset: 1 }), dec, TZ)!;
    expect([w.startDate, w.endDate]).toEqual(["2027-01-01", "2027-01-31"]);
  });

  it("weekday: Friday is the coming one, today counts", () => {
    expect(resolveTimeRef(ref({ type: "weekday", weekday: 5, offset: 0 }), NOW, TZ)!.startDate).toBe("2026-11-27");
    expect(resolveTimeRef(ref({ type: "weekday", weekday: 1, offset: 0 }), NOW, TZ)!.startDate).toBe("2026-11-23");
    expect(resolveTimeRef(ref({ type: "weekday", weekday: 5, offset: 1 }), NOW, TZ)!.startDate).toBe("2026-12-04");
  });

  it("rejects impossible dates and nonsense", () => {
    expect(resolveTimeRef(ref({ type: "date", date: "2026-02-31" }), NOW, TZ)).toBeNull();
    expect(resolveTimeRef(ref({ type: "weekday", weekday: 9 }), NOW, TZ)).toBeNull();
    expect(resolveTimeRef(ref({ unit: "day", offset: 99999 }), NOW, TZ)).toBeNull();
    expect(resolveTimeRef(ref({ type: "none" }), NOW, TZ)).toBeNull();
  });

  it("range swaps reversed dates", () => {
    const w = resolveTimeRef(ref({ type: "range", date: "2026-12-10", end_date: "2026-12-01" }), NOW, TZ)!;
    expect([w.startDate, w.endDate]).toEqual(["2026-12-01", "2026-12-10"]);
  });

  it("handles a DST change (Paris, 29 March 2026)", () => {
    const w = resolveTimeRef(ref({ type: "date", date: "2026-03-29", time: "09:00" }), NOW, TZ)!;
    expect(w.dueAt!.toISOString()).toBe("2026-03-29T07:00:00.000Z"); // UTC+2 after the change
  });
});

describe("inQuietHours", () => {
  it("handles windows across midnight", () => {
    expect(inQuietHours(zonedToUtc(2026, 11, 23, 23, 0, TZ), TZ, "22:00", "07:00")).toBe(true);
    expect(inQuietHours(zonedToUtc(2026, 11, 23, 6, 59, TZ), TZ, "22:00", "07:00")).toBe(true);
    expect(inQuietHours(zonedToUtc(2026, 11, 23, 7, 0, TZ), TZ, "22:00", "07:00")).toBe(false);
    expect(inQuietHours(zonedToUtc(2026, 11, 23, 13, 0, TZ), TZ, "12:00", "14:00")).toBe(true);
  });
});
