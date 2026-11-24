import { describe, expect, it } from "vitest";
import { describeRule, formatRule, nextOccurrence, occurrenceAfter, parseRule } from "../worker/core/rrule";
import { civilToIso, parseCivil } from "../worker/core/time";

const d = (s: string) => parseCivil(s)!;
const next = (rule: string, start: string, from: string) => {
  const r = parseRule(rule);
  if (!r) throw new Error(`bad rule ${rule}`);
  const o = nextOccurrence(r, d(start), d(from));
  return o ? civilToIso(o) : null;
};

describe("parseRule", () => {
  it("accepts the supported subset and round-trips", () => {
    for (const s of ["FREQ=DAILY", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH", "FREQ=MONTHLY;BYMONTHDAY=-1", "FREQ=YEARLY;BYMONTH=4,11", "FREQ=MONTHLY;INTERVAL=3;UNTIL=20271231"]) {
      expect(formatRule(parseRule(s)!)).toBe(s);
    }
    expect(parseRule("RRULE:freq=daily")?.freq).toBe("DAILY");
  });

  it.each([
    "", "FREQ=HOURLY", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;INTERVAL=1.5", "FREQ=DAILY;BYDAY=MO", "FREQ=WEEKLY;BYDAY=XX",
    "FREQ=YEARLY;BYMONTH=13", "FREQ=MONTHLY;BYMONTHDAY=0", "FREQ=MONTHLY;BYMONTHDAY=-2", "FREQ=DAILY;COUNT=3",
    "FREQ=DAILY;FREQ=WEEKLY", "FREQ=DAILY;UNTIL=20270230", "INTERVAL=2",
  ])("rejects %s", (s) => expect(parseRule(s)).toBeNull());
});

describe("nextOccurrence", () => {
  it("daily and every 3 days", () => {
    expect(next("FREQ=DAILY", "2026-11-24", "2026-11-24")).toBe("2026-11-24");
    expect(next("FREQ=DAILY;INTERVAL=3", "2026-11-24", "2026-11-25")).toBe("2026-11-27");
  });

  it("weekly on chosen days, every other week", () => {
    // 2026-11-24 is a Tuesday. Mon+Thu every 2 weeks: Thu 26 Nov, then Mon 7 Dec, Thu 10 Dec.
    expect(next("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH", "2026-11-24", "2026-11-24")).toBe("2026-11-26");
    expect(next("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH", "2026-11-24", "2026-11-27")).toBe("2026-12-07");
    expect(next("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH", "2026-11-24", "2026-12-08")).toBe("2026-12-10");
  });

  it("monthly on the 31st clamps to the month's end instead of skipping", () => {
    expect(next("FREQ=MONTHLY", "2026-01-31", "2026-02-01")).toBe("2026-02-28");
    expect(next("FREQ=MONTHLY", "2026-01-31", "2026-03-01")).toBe("2026-03-31");
    expect(next("FREQ=MONTHLY", "2028-01-31", "2028-02-01")).toBe("2028-02-29");
  });

  it("last day of the month", () => {
    expect(next("FREQ=MONTHLY;BYMONTHDAY=-1", "2026-01-15", "2026-04-01")).toBe("2026-04-30");
  });

  it("every 3 months", () => {
    expect(next("FREQ=MONTHLY;INTERVAL=3", "2026-01-10", "2026-01-11")).toBe("2026-04-10");
    expect(next("FREQ=MONTHLY;INTERVAL=3", "2026-01-10", "2030-05-01")).toBe("2030-07-10");
  });

  it("yearly birthdays on 29 Feb fall on 28 Feb in common years", () => {
    expect(next("FREQ=YEARLY", "2000-02-29", "2026-01-01")).toBe("2026-02-28");
    expect(next("FREQ=YEARLY", "2000-02-29", "2028-01-01")).toBe("2028-02-29");
    expect(next("FREQ=YEARLY", "2000-02-29", "2026-03-01")).toBe("2027-02-28");
  });

  it("yearly in several months (gutters in April and November)", () => {
    expect(next("FREQ=YEARLY;BYMONTH=4,11", "2026-04-01", "2026-05-01")).toBe("2026-11-01");
    expect(next("FREQ=YEARLY;BYMONTH=4,11", "2026-04-01", "2026-11-02")).toBe("2027-04-01");
  });

  it("monthly limited to some months", () => {
    expect(next("FREQ=MONTHLY;BYMONTH=6,7,8", "2026-01-05", "2026-02-01")).toBe("2026-06-05");
  });

  it("stops at UNTIL", () => {
    expect(next("FREQ=MONTHLY;UNTIL=20270115", "2026-11-10", "2027-01-11")).toBeNull();
    expect(next("FREQ=MONTHLY;UNTIL=20270115", "2026-11-10", "2027-01-01")).toBe("2027-01-10");
  });

  it("never returns a date before dtstart, and occurrenceAfter is strict", () => {
    expect(next("FREQ=WEEKLY;BYDAY=MO", "2026-11-24", "2026-01-01")).toBe("2026-11-30");
    expect(civilToIso(occurrenceAfter(parseRule("FREQ=DAILY")!, d("2026-11-24"), d("2026-11-24"))!)).toBe("2026-11-25");
  });

  it("is fast far into the future", () => {
    const t = performance.now();
    expect(next("FREQ=DAILY", "2000-01-01", "2090-06-15")).toBe("2090-06-15");
    expect(performance.now() - t).toBeLessThan(50);
  });

  it("describes rules in plain words", () => {
    expect(describeRule(parseRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH")!)).toBe("every 2 weeks on Mon, Thu");
    expect(describeRule(parseRule("FREQ=YEARLY;BYMONTH=10")!)).toBe("every year in Oct");
  });
});
