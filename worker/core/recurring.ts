// Pure: move a recurring item to its next occurrence when it is completed.
import { addDays, cmp, daysInMonth, diffDays, type CivilDate } from "./civil";
import { nextOccurrence, parseRule } from "./rrule";
import { civilOf, localParts, startOfLocalDay, zonedToUtc } from "./time";

export interface Window {
  window_start: string | null;
  window_end: string | null;
  due_at: string | null;
}

/**
 * The next window for a recurring item, or null when the rule is invalid or finished.
 * The next occurrence is the first one after both the current one and today, so finishing a
 * chore late does not leave the next one overdue. A time of day and the window's length are kept.
 */
export function rollRecurring(w: Window, rrule: string, now: Date, tz: string): Window | null {
  const rule = parseRule(rrule);
  if (!rule) return null;
  const startIso = w.due_at ?? w.window_start;
  const today = civilOf(now, tz);
  const dtstart: CivilDate = startIso ? civilOf(new Date(startIso), tz) : today;
  const lastDay = w.window_end ? addDays(civilOf(new Date(w.window_end), tz), -1) : dtstart;
  const span = Math.max(0, diffDays(dtstart, lastDay));
  const after = cmp(dtstart, today) > 0 ? dtstart : today;
  const next = nextOccurrence(rule, dtstart, addDays(after, 1));
  if (!next) return null;
  const start = startOfLocalDay(next, tz);
  const end = startOfLocalDay(addDays(next, span + 1), tz);
  let due: Date | null = null;
  if (w.due_at) {
    const p = localParts(new Date(w.due_at), tz);
    due = zonedToUtc(next.year, next.month, next.day, p.hour, p.minute, tz);
  }
  return { window_start: (due ?? start).toISOString(), window_end: end.toISOString(), due_at: due ? due.toISOString() : null };
}

/** First window for a new recurring item with no date: the next occurrence from today (inclusive). */
export function firstWindow(rrule: string, now: Date, tz: string, anchorMonthDay?: CivilDate | null): Window | null {
  const rule = parseRule(rrule);
  if (!rule) return null;
  const today = civilOf(now, tz);
  // "Every November" added on 24 November is due now (the rest of this month), not next November.
  if (rule.freq === "YEARLY" && rule.byMonth?.includes(today.month) && rule.byMonthDay == null && !anchorMonthDay) {
    const endOfMonth = { year: today.year, month: today.month, day: daysInMonth(today.year, today.month) };
    return {
      window_start: startOfLocalDay(today, tz).toISOString(),
      window_end: startOfLocalDay(addDays(endOfMonth, 1), tz).toISOString(),
      due_at: null,
    };
  }
  // "Every year in October" with no day starts on the 1st; dtstart a year back so this year's October counts.
  const dtstart = anchorMonthDay ?? (rule.byMonth ? { year: today.year - 1, month: rule.byMonth[0], day: 1 } : today);
  const first = nextOccurrence(rule, dtstart, today);
  if (!first) return null;
  return {
    window_start: startOfLocalDay(first, tz).toISOString(),
    window_end: startOfLocalDay(addDays(first, 1), tz).toISOString(),
    due_at: null,
  };
}
