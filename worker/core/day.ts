// The daily summary headline and calendar placement: which local day each thing lands on. Pure.
import { clampDay, cmp, type CivilDate, type DateFact } from "./civil";
import type { Holiday } from "./holidays";
import { civilOf, civilToIso, weekdayOf } from "./time";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Days people wish each other a happy one, and how. Others are stated ("It's Veterans Day."). */
const GREETING: Record<string, string> = {
  "New Year's Day": "Happy New Year!",
  "Valentine's Day": "Happy Valentine's Day!",
  "St. Patrick's Day": "Happy St. Patrick's Day!",
  "Easter Sunday": "Happy Easter!",
  "Mother's Day": "Happy Mother's Day!",
  "Father's Day": "Happy Father's Day!",
  "Independence Day": "Happy Fourth of July!",
  Halloween: "Happy Halloween!",
  Thanksgiving: "Happy Thanksgiving!",
  "Christmas Eve": "It's Christmas Eve.",
  "Christmas Day": "Merry Christmas!",
  "New Year's Eve": "It's New Year's Eve.",
};

export function longDate(d: CivilDate): string {
  return `${WEEKDAYS[weekdayOf(d)]}, ${MONTHS[d.month - 1]} ${d.day}`;
}

/** What a holiday sounds like in a sentence: "Happy Thanksgiving!", "It's Veterans Day.", "Clocks go back an hour." */
export function holidayLine(h: Pick<Holiday, "name">): string {
  if (GREETING[h.name]) return GREETING[h.name];
  // The change happens at 2 AM, so by the time anyone reads the day's summary it has already happened.
  if (h.name.startsWith("Clocks go ")) return `${h.name.replace("Clocks go ", "Clocks went ")} last night.`;
  return `It's ${h.name}.`;
}

/**
 * "Today is Thursday, November 26. Happy Thanksgiving!" One holiday line at most (federal first, then the first
 * notable day); the rest are listed under it, so the headline stays one breath long.
 */
export function dayHeadline(today: CivilDate, holidays: Pick<Holiday, "name" | "kind">[]): string {
  const base = `Today is ${longDate(today)}.`;
  const lead = holidays.find((h) => h.kind === "federal" && !h.name.endsWith("(observed)")) ?? holidays.find((h) => !h.name.endsWith("(observed)")) ?? holidays[0];
  return lead ? `${base} ${holidayLine(lead)}` : base;
}

/**
 * Every day in [from, to] that a date fact falls on. Yearly facts (birthdays) repeat; one-off facts (an expiry)
 * appear once, on their date, and only when the year is known. 29 February falls on 28 February in common years.
 */
export function dateFactDays(f: DateFact, yearly: boolean, from: CivilDate, to: CivilDate): CivilDate[] {
  if (!yearly) {
    if (f.year == null) return [];
    const d = { year: f.year, month: f.month, day: f.day };
    return cmp(d, from) >= 0 && cmp(d, to) <= 0 ? [d] : [];
  }
  const out: CivilDate[] = [];
  for (let y = from.year; y <= to.year; y++) {
    if (f.year != null && y < f.year) continue; // nobody has a birthday before they were born
    const d = clampDay(y, f.month, f.day);
    if (cmp(d, from) >= 0 && cmp(d, to) <= 0) out.push(d);
  }
  return out;
}

/**
 * The local day an item belongs on in a calendar: an exact time on its day; a one-day window on that day; a longer
 * window ("this week", "by Friday") on its last day, as a deadline, so it is not repeated on every day of the range.
 * Null for items with no date.
 */
export function itemDay(
  it: { due_at: string | null; window_start: string | null; window_end: string | null },
  tz: string,
): { date: string; by: boolean } | null {
  if (it.due_at) return { date: civilToIso(civilOf(new Date(it.due_at), tz)), by: false };
  if (!it.window_start) return null;
  const first = civilToIso(civilOf(new Date(it.window_start), tz));
  if (!it.window_end) return { date: first, by: false };
  // window_end is exclusive: the last day is the one holding the instant just before it.
  const last = civilToIso(civilOf(new Date(Date.parse(it.window_end) - 1), tz));
  return last === first ? { date: first, by: false } : { date: last, by: true };
}

/** "Sam's birthday (turns 40)", "Anniversary", "Passport expires (Sam)". */
export function dateFactTitle(o: { key: string; label: string; who: string | null; age: number | null }): string {
  if (o.key === "birthday") return `${o.who ? `${o.who}'s birthday` : "Birthday"}${o.age != null && o.age > 0 ? ` (turns ${o.age})` : ""}`;
  if (o.key === "name_day" && o.who) return `${o.who}'s name day`;
  return o.who ? `${o.label} (${o.who})` : o.label;
}
