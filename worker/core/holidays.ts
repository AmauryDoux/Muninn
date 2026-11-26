// US public holidays and notable days, computed (no list to keep up to date, no network). Pure.
//
// Federal holidays follow 5 U.S.C. 6103: when one falls on a Saturday the day off is the Friday before, on a
// Sunday the Monday after. The holiday itself stays on its real date; the day off is a separate "observed" entry,
// so "Independence Day" is still 4 July and "Independence Day (observed)" is Friday 3 July 2026.
import { addDays, cmp, type CivilDate } from "./civil";
import { localParts, weekdayOf, zonedToUtc } from "./time";

export type HolidayKind = "federal" | "observance";

export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
  kind: HolidayKind;
  /** Federal offices, banks and most employers are closed on this date. */
  off: boolean;
}

/** "all" shows federal holidays and notable days, "federal" only the federal ones, "off" none. */
export type HolidayMode = "all" | "federal" | "off";

export function holidayMode(v: string | null | undefined): HolidayMode {
  return v === "federal" || v === "off" ? v : "all";
}

const iso = (d: CivilDate) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/** The n-th (1-based) weekday (0 = Sunday) of a month. */
export function nthWeekday(year: number, month: number, weekday: number, n: number): CivilDate {
  const first = { year, month, day: 1 };
  const shift = (weekday - weekdayOf(first) + 7) % 7;
  return { year, month, day: 1 + shift + (n - 1) * 7 };
}

/** The last given weekday of a month. */
export function lastWeekday(year: number, month: number, weekday: number): CivilDate {
  const next = month === 12 ? { year: year + 1, month: 1, day: 1 } : { year, month: month + 1, day: 1 };
  const last = addDays(next, -1);
  return addDays(last, -((weekdayOf(last) - weekday + 7) % 7));
}

/** Western (Gregorian) Easter Sunday: the anonymous Gregorian algorithm (Meeus/Jones/Butcher). */
export function easter(year: number): CivilDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

/** Saturday moves to Friday, Sunday to Monday. Other days: null (no separate day off). */
export function observedDay(d: CivilDate): CivilDate | null {
  const wd = weekdayOf(d);
  return wd === 6 ? addDays(d, -1) : wd === 0 ? addDays(d, 1) : null;
}

/**
 * The IRS filing deadline: 15 April, moved to the next business day when it falls on a weekend or on
 * Emancipation Day (16 April, a DC holiday that is itself observed on the Friday before / Monday after).
 */
export function taxDay(year: number): CivilDate {
  const emancipation = { year, month: 4, day: 16 };
  const emancipationOff = observedDay(emancipation) ?? emancipation;
  let d: CivilDate = { year, month: 4, day: 15 };
  while (weekdayOf(d) === 0 || weekdayOf(d) === 6 || cmp(d, emancipationOff) === 0) d = addDays(d, 1);
  return d;
}

function federal(year: number): { date: CivilDate; name: string }[] {
  const fixed = (month: number, day: number) => ({ year, month, day });
  return [
    { date: fixed(1, 1), name: "New Year's Day" },
    { date: nthWeekday(year, 1, 1, 3), name: "Martin Luther King Jr. Day" },
    { date: nthWeekday(year, 2, 1, 3), name: "Presidents' Day" },
    { date: lastWeekday(year, 5, 1), name: "Memorial Day" },
    // Juneteenth became a federal holiday in 2021.
    ...(year >= 2021 ? [{ date: fixed(6, 19), name: "Juneteenth" }] : []),
    { date: fixed(7, 4), name: "Independence Day" },
    { date: nthWeekday(year, 9, 1, 1), name: "Labor Day" },
    { date: nthWeekday(year, 10, 1, 2), name: "Columbus Day / Indigenous Peoples' Day" },
    { date: fixed(11, 11), name: "Veterans Day" },
    { date: nthWeekday(year, 11, 4, 4), name: "Thanksgiving" },
    { date: fixed(12, 25), name: "Christmas Day" },
  ];
}

function notable(year: number): { date: CivilDate; name: string }[] {
  const fixed = (month: number, day: number) => ({ year, month, day });
  const e = easter(year);
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  // US general elections: the Tuesday after the first Monday of November, in even years.
  const election = addDays(nthWeekday(year, 11, 1, 1), 1);
  return [
    { date: fixed(2, 2), name: "Groundhog Day" },
    { date: fixed(2, 14), name: "Valentine's Day" },
    { date: addDays(e, -47), name: "Mardi Gras" },
    { date: fixed(3, 17), name: "St. Patrick's Day" },
    { date: fixed(4, 1), name: "April Fools' Day" },
    { date: addDays(e, -2), name: "Good Friday" },
    { date: e, name: "Easter Sunday" },
    { date: taxDay(year), name: "Tax Day" },
    { date: fixed(4, 22), name: "Earth Day" },
    { date: fixed(5, 5), name: "Cinco de Mayo" },
    { date: nthWeekday(year, 5, 0, 2), name: "Mother's Day" },
    { date: nthWeekday(year, 6, 0, 3), name: "Father's Day" },
    { date: fixed(10, 31), name: "Halloween" },
    ...(year % 2 === 0 ? [{ date: election, name: "Election Day" }] : []),
    { date: addDays(thanksgiving, 1), name: "Black Friday" },
    { date: fixed(12, 24), name: "Christmas Eve" },
    { date: fixed(12, 31), name: "New Year's Eve" },
  ];
}

/** Every holiday whose date is in [from, to] (both inclusive), sorted by date, federal first on the same day. */
export function holidaysBetween(from: CivilDate, to: CivilDate, mode: HolidayMode = "all"): Holiday[] {
  if (mode === "off" || cmp(from, to) > 0) return [];
  const out: Holiday[] = [];
  // One year either side: New Year's Day on a Saturday is observed on 31 December of the year before.
  for (let y = from.year - 1; y <= to.year + 1; y++) {
    for (const h of federal(y)) {
      out.push({ date: iso(h.date), name: h.name, kind: "federal", off: observedDay(h.date) === null });
      const obs = observedDay(h.date);
      if (obs) out.push({ date: iso(obs), name: `${h.name} (observed)`, kind: "federal", off: true });
    }
    if (mode === "all") for (const h of notable(y)) out.push({ date: iso(h.date), name: h.name, kind: "observance", off: false });
  }
  const a = iso(from);
  const b = iso(to);
  return out
    .filter((h) => h.date >= a && h.date <= b)
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.kind === y.kind ? 0 : x.kind === "federal" ? -1 : 1));
}

/**
 * Days in [from, to] when the clocks change in `tz` ("Clocks go back" / "Clocks go forward"), found by comparing
 * the zone's UTC offset at local noon on consecutive days, so it is right for any zone and any year.
 */
export function clockChanges(from: CivilDate, to: CivilDate, tz: string): Holiday[] {
  const offset = (d: CivilDate) => {
    const at = zonedToUtc(d.year, d.month, d.day, 12, 0, tz);
    const p = localParts(at, tz);
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - at.getTime()) / 60000);
  };
  const out: Holiday[] = [];
  let prev = offset(addDays(from, -1));
  for (let d = from; cmp(d, to) <= 0; d = addDays(d, 1)) {
    const cur = offset(d);
    if (cur !== prev) out.push({ date: iso(d), name: cur > prev ? "Clocks go forward an hour" : "Clocks go back an hour", kind: "observance", off: false });
    prev = cur;
  }
  return out;
}

/** Holidays plus clock changes (in "all" mode), for a date range in the user's zone. */
export function notableDays(from: CivilDate, to: CivilDate, tz: string, mode: HolidayMode): Holiday[] {
  const days = holidaysBetween(from, to, mode);
  if (mode !== "all") return days;
  return [...days, ...clockChanges(from, to, tz)].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}
