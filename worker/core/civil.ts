// Pure calendar-date arithmetic on zone-less dates. No I/O.
import { addDays, civilToIso, parseCivil, type CivilDate } from "./time";

export type { CivilDate };

export function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** Day number since the epoch, for exact differences. */
export function dayNumber(d: CivilDate): number {
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000);
}

/** b - a in whole days. */
export function diffDays(a: CivilDate, b: CivilDate): number {
  return dayNumber(b) - dayNumber(a);
}

export function cmp(a: CivilDate, b: CivilDate): number {
  return dayNumber(a) - dayNumber(b);
}

/** A date in month (year, month) with the day clamped to the month's length (31 Jan + 1 month = 28/29 Feb). */
export function clampDay(year: number, month: number, day: number): CivilDate {
  return { year, month, day: Math.min(Math.max(1, day), daysInMonth(year, month)) };
}

/** Add calendar months, clamping the day (31 Mar - 1 month = 28/29 Feb). */
export function addMonths(d: CivilDate, n: number): CivilDate {
  const idx = d.year * 12 + (d.month - 1) + n;
  const y = Math.floor(idx / 12);
  const m = idx - y * 12 + 1;
  return clampDay(y, m, d.day);
}

/** Whole months from a to b (floor), e.g. 2026-01-31 to 2026-02-28 is 0. */
export function diffMonths(a: CivilDate, b: CivilDate): number {
  let n = (b.year - a.year) * 12 + (b.month - a.month);
  if (n > 0 && cmp(addMonths(a, n), b) > 0) n--;
  if (n < 0 && cmp(addMonths(a, n), b) < 0) n++;
  return n;
}

export { addDays, civilToIso, parseCivil };

/**
 * A date fact as stored: "2019-03-03" (full) or "--03-03" (month and day, year unknown).
 * Returns null for anything else, so a bad value never schedules a reminder.
 */
export interface DateFact {
  year: number | null;
  month: number;
  day: number;
}

export function parseDateFact(v: string): DateFact | null {
  const s = v.trim();
  const full = parseCivil(s);
  if (full) return { year: full.year, month: full.month, day: full.day };
  const md = /^--(\d{2})-(\d{2})$/.exec(s);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(2000, month)) return null; // 2000 is leap: allows 29 Feb
    return { year: null, month, day };
  }
  return null;
}

export function formatDateFact(f: DateFact): string {
  const md = `${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")}`;
  return f.year == null ? `--${md}` : `${f.year}-${md}`;
}

/**
 * Next yearly occurrence of a month/day on or after `from`. 29 February falls on 28 February in
 * common years (the usual convention for birthdays and anniversaries).
 */
export function nextAnniversary(f: Pick<DateFact, "month" | "day">, from: CivilDate): CivilDate {
  const thisYear = clampDay(from.year, f.month, f.day);
  return cmp(thisYear, from) >= 0 ? thisYear : clampDay(from.year + 1, f.month, f.day);
}

/** Age (whole years) someone born on `birth` reaches on `on`. */
export function ageOn(birth: CivilDate, on: CivilDate): number {
  let a = on.year - birth.year;
  const bday = clampDay(on.year, birth.month, birth.day);
  if (cmp(on, bday) < 0) a--;
  return a;
}
