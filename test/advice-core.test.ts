import { describe, expect, it } from "vitest";
import { clusterByCosine } from "../worker/core/cluster";
import { classifyDomain, stricterDomain } from "../worker/core/domain";
import { computePatterns, type PatternEvent } from "../worker/core/patterns";
import { parseOpenMeteo, weatherMatches, weatherSignals } from "../worker/core/seasonal";
import { studyStats } from "../worker/core/streaks";
import { parseCivil, zonedToUtc } from "../worker/core/time";

const d = (s: string) => parseCivil(s)!;

describe("studyStats", () => {
  const s = (date: string, minutes = 30) => ({ date, minutes });
  it("keeps the streak alive until the day is over", () => {
    const st = studyStats([s("2026-11-21"), s("2026-11-22"), s("2026-11-23")], d("2026-11-24"));
    expect(st).toMatchObject({ current: 3, best: 3, todayDone: false, daysSinceLast: 1 });
  });
  it("counts today, merges same-day sessions, and finds the best run", () => {
    const st = studyStats([s("2026-11-01"), s("2026-11-02"), s("2026-11-03"), s("2026-11-04"), s("2026-11-23"), s("2026-11-24", 20), s("2026-11-24", 40)], d("2026-11-24"));
    expect(st).toMatchObject({ current: 2, best: 4, todayDone: true, weekMinutes: 90 });
  });
  it("breaks after a missed day and ignores future or bad dates", () => {
    expect(studyStats([s("2026-11-20"), s("2026-11-22"), s("2027-01-01"), s("nope")], d("2026-11-24")).current).toBe(0);
    expect(studyStats([], d("2026-11-24"))).toMatchObject({ current: 0, best: 0, last: null, daysSinceLast: null });
  });
});

describe("classifyDomain", () => {
  it.each([
    ["how much ibuprofen can I take", "health"],
    ["when was my last tetanus shot", "health"],
    ["should I lend Mike more money", "finance"],
    ["can my landlord keep the deposit", "legal"],
    ["what should I get my wife for our anniversary", "none"],
    ["is the scarf in stock", "none"],
    ["all right, what's next", "none"],
  ])("%s -> %s", (q, want) => expect(classifyDomain(q)).toBe(want));
  it("stricter wins", () => {
    expect(stricterDomain("none", "legal")).toBe("legal");
    expect(stricterDomain("health", "finance")).toBe("health");
  });
});

describe("clusterByCosine", () => {
  it("groups similar vectors and keeps outliers alone", () => {
    const v = (...xs: number[]) => Float32Array.from(xs);
    const c = clusterByCosine([
      { id: "a", vec: v(1, 0, 0) },
      { id: "b", vec: v(0.95, 0.1, 0) },
      { id: "c", vec: v(0, 1, 0) },
      { id: "d", vec: v(0.9, 0.05, 0.1) },
    ]);
    expect(c).toEqual([["a", "b", "d"], ["c"]]);
  });
});

describe("weather", () => {
  const meteo = { daily: { time: ["2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"], temperature_2m_min: [2, 4, -1, 3], temperature_2m_max: [8, 9, 6, 7] } };
  it("parses Open-Meteo defensively", () => {
    expect(parseOpenMeteo(meteo)).toHaveLength(4);
    expect(parseOpenMeteo({ daily: { time: ["x"], temperature_2m_min: [1], temperature_2m_max: [2] } })).toEqual([]);
    expect(parseOpenMeteo(null)).toEqual([]);
    expect(parseOpenMeteo({ daily: { time: "2026", temperature_2m_min: [], temperature_2m_max: [] } })).toEqual([]);
  });
  it("derives cold and frost cues", () => {
    const s = weatherSignals(parseOpenMeteo(meteo))!;
    expect(s).toMatchObject({ cold: true, frost: true, warm: false, heat: false, meanMin: 2 });
    expect(weatherMatches("cold", s)).toBe(true);
    expect(weatherMatches("any", s)).toBe(false);
    expect(weatherSignals([])).toBeNull();
  });
});

describe("computePatterns", () => {
  const TZ = "Europe/Paris";
  const now = zonedToUtc(2026, 11, 24, 12, 0, TZ);
  it("needs enough data", () => {
    expect(computePatterns([{ at: now.toISOString(), type: "done", item_id: "x", payload_json: null }], () => "store", now, TZ)).toEqual([]);
  });
  it("finds the usual errand day, trips per week and completion hour", () => {
    const ev: PatternEvent[] = [];
    // Four Saturdays and two Wednesdays of errands at 10:00 local, two places on Saturdays.
    const sats = [21, 14, 7];
    for (const day of sats) {
      ev.push({ at: zonedToUtc(2026, 11, day, 10, 0, TZ).toISOString(), type: "done", item_id: "a", payload_json: null });
      ev.push({ at: zonedToUtc(2026, 11, day, 10, 30, TZ).toISOString(), type: "done", item_id: "b", payload_json: null });
    }
    for (const day of [18, 11, 4]) ev.push({ at: zonedToUtc(2026, 11, day, 10, 0, TZ).toISOString(), type: "done", item_id: "a", payload_json: null });
    ev.push({ at: zonedToUtc(2026, 11, 20, 10, 0, TZ).toISOString(), type: "done", item_id: "noplace", payload_json: null });
    const place = (id: string) => (id === "a" ? "Home goods store" : id === "b" ? "pharmacy" : null);
    const p = Object.fromEntries(computePatterns(ev, place, now, TZ).map((x) => [x.key, x]));
    expect(p.errand_day.value).toMatchObject({ weekday: 6, name: "Saturday" });
    expect(p.errand_day.sample).toBe(9);
    expect(p.done_hour.value).toMatchObject({ hour: 10 });
    expect(p.errand_trips.value).toMatchObject({ per_week: 2.25, days_per_week: 1.5 });
  });
  it("preferred snooze", () => {
    const ev = ["tomorrow", "tomorrow", "1h", "tomorrow", "evening"].map((preset, i) => ({
      at: new Date(now.getTime() - i * 3600_000).toISOString(),
      type: "snooze",
      item_id: "x",
      payload_json: JSON.stringify({ preset }),
    }));
    expect(computePatterns(ev, () => null, now, TZ)).toEqual([{ key: "snooze_preset", value: { preset: "tomorrow", share: 0.6 }, sample: 5 }]);
  });
});
