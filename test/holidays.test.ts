import { describe, expect, it } from "vitest";
import { clockChanges, easter, holidayMode, holidaysBetween, lastWeekday, notableDays, nthWeekday, taxDay } from "../worker/core/holidays";
import { parseCivil } from "../worker/core/time";

const d = (s: string) => parseCivil(s)!;
const names = (from: string, to: string, mode: "all" | "federal" = "all") => holidaysBetween(d(from), d(to), mode).map((h) => `${h.date} ${h.name}`);

describe("weekday helpers", () => {
  it("nth weekday", () => {
    expect(nthWeekday(2026, 11, 4, 4)).toEqual(d("2026-11-26")); // Thanksgiving 2026
    expect(nthWeekday(2026, 9, 1, 1)).toEqual(d("2026-09-07")); // Labor Day
    expect(nthWeekday(2024, 11, 4, 4)).toEqual(d("2024-11-28"));
  });
  it("last weekday", () => {
    expect(lastWeekday(2026, 5, 1)).toEqual(d("2026-05-25")); // Memorial Day
    expect(lastWeekday(2027, 5, 1)).toEqual(d("2027-05-31"));
    expect(lastWeekday(2026, 12, 4)).toEqual(d("2026-12-31"));
  });
});

describe("easter", () => {
  // Published dates.
  it.each([
    [2024, "2024-03-31"],
    [2025, "2025-04-20"],
    [2026, "2026-04-05"],
    [2027, "2027-03-28"],
    [2038, "2038-04-25"],
    [2285, "2285-03-22"],
  ])("%i", (y, want) => expect(easter(y)).toEqual(d(want)));
});

describe("tax day", () => {
  it("moves off weekends and Emancipation Day", () => {
    expect(taxDay(2026)).toEqual(d("2026-04-15")); // Wednesday
    expect(taxDay(2027)).toEqual(d("2027-04-15")); // Thursday; 16 Apr is Friday, not in the way
    expect(taxDay(2028)).toEqual(d("2028-04-18")); // 15 Sat, Emancipation Day Sun 16 observed Mon 17: Tue 18
    expect(taxDay(2022)).toEqual(d("2022-04-18")); // Friday 15 Apr was Emancipation Day observed: IRS deadline was 18 Apr
    expect(taxDay(2023)).toEqual(d("2023-04-18")); // 15 Sat, Emancipation observed Mon 17: deadline Tue 18
  });
});

describe("holidaysBetween", () => {
  it("Thanksgiving 2026 is today, and Black Friday follows", () => {
    expect(names("2026-11-26", "2026-11-27")).toEqual(["2026-11-26 Thanksgiving", "2026-11-27 Black Friday"]);
  });

  it("the whole federal year 2026, with observed days", () => {
    expect(names("2026-01-01", "2026-12-31", "federal")).toEqual([
      "2026-01-01 New Year's Day",
      "2026-01-19 Martin Luther King Jr. Day",
      "2026-02-16 Presidents' Day",
      "2026-05-25 Memorial Day",
      "2026-06-19 Juneteenth",
      "2026-07-03 Independence Day (observed)",
      "2026-07-04 Independence Day",
      "2026-09-07 Labor Day",
      "2026-10-12 Columbus Day / Indigenous Peoples' Day",
      "2026-11-11 Veterans Day",
      "2026-11-26 Thanksgiving",
      "2026-12-25 Christmas Day",
    ]);
  });

  it("New Year's Day on a Saturday is observed on 31 December of the year before", () => {
    // 1 Jan 2028 is a Saturday.
    expect(names("2027-12-31", "2027-12-31", "federal")).toEqual(["2027-12-31 New Year's Day (observed)"]);
    const all = holidaysBetween(d("2027-12-31"), d("2027-12-31"));
    expect(all.map((h) => h.name)).toEqual(["New Year's Day (observed)", "New Year's Eve"]); // federal first
    expect(all[0].off).toBe(true);
  });

  it("Sunday holiday: the day off is Monday", () => {
    // Christmas 2022 was a Sunday.
    const h = holidaysBetween(d("2022-12-25"), d("2022-12-26"), "federal");
    expect(h).toEqual([
      { date: "2022-12-25", name: "Christmas Day", kind: "federal", off: false },
      { date: "2022-12-26", name: "Christmas Day (observed)", kind: "federal", off: true },
    ]);
  });

  it("Juneteenth only from 2021", () => {
    expect(names("2020-06-19", "2020-06-19", "federal")).toEqual([]);
    expect(names("2021-06-19", "2021-06-19", "federal")).toEqual(["2021-06-19 Juneteenth"]);
  });

  it("Election Day in even years only", () => {
    expect(names("2026-11-03", "2026-11-03")).toEqual(["2026-11-03 Election Day"]);
    expect(names("2027-11-02", "2027-11-02")).toEqual([]);
  });

  it("Mother's and Father's Day, Mardi Gras", () => {
    expect(names("2026-05-10", "2026-05-10")).toEqual(["2026-05-10 Mother's Day"]);
    expect(names("2026-06-21", "2026-06-21")).toEqual(["2026-06-21 Father's Day"]);
    expect(names("2026-02-17", "2026-02-17")).toEqual(["2026-02-17 Mardi Gras"]);
  });

  it("modes", () => {
    expect(holidaysBetween(d("2026-11-26"), d("2026-11-27"), "off")).toEqual([]);
    expect(names("2026-11-26", "2026-11-27", "federal")).toEqual(["2026-11-26 Thanksgiving"]);
    expect(holidayMode("federal")).toBe("federal");
    expect(holidayMode(null)).toBe("all");
    expect(holidayMode("junk")).toBe("all");
  });

  it("an empty or reversed range", () => {
    expect(holidaysBetween(d("2026-11-27"), d("2026-11-26"))).toEqual([]);
  });

  it("a range across years", () => {
    expect(names("2026-12-24", "2027-01-01")).toEqual(["2026-12-24 Christmas Eve", "2026-12-25 Christmas Day", "2026-12-31 New Year's Eve", "2027-01-01 New Year's Day"]);
  });
});

describe("clock changes", () => {
  it("Chicago 2026: second Sunday of March, first Sunday of November", () => {
    expect(clockChanges(d("2026-01-01"), d("2026-12-31"), "America/Chicago")).toEqual([
      { date: "2026-03-08", name: "Clocks go forward an hour", kind: "observance", off: false },
      { date: "2026-11-01", name: "Clocks go back an hour", kind: "observance", off: false },
    ]);
  });
  it("Phoenix and UTC never change", () => {
    expect(clockChanges(d("2026-01-01"), d("2026-12-31"), "America/Phoenix")).toEqual([]);
    expect(clockChanges(d("2026-01-01"), d("2026-12-31"), "UTC")).toEqual([]);
  });
  it("Paris follows the EU dates", () => {
    expect(clockChanges(d("2026-01-01"), d("2026-12-31"), "Europe/Paris").map((h) => h.date)).toEqual(["2026-03-29", "2026-10-25"]);
  });
  it("notableDays adds them only in 'all' mode", () => {
    expect(notableDays(d("2026-11-01"), d("2026-11-01"), "America/Chicago", "all").map((h) => h.name)).toEqual(["Clocks go back an hour"]);
    expect(notableDays(d("2026-11-01"), d("2026-11-01"), "America/Chicago", "federal")).toEqual([]);
  });
});
