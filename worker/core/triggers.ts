// Pure scheduling of date-relative triggers: "14 days before Emma's birthday", "30 days before the
// warranty ends", "every month while Mike still owes you". No I/O; the cron feeds rows in.
import { addDays, cmp, type CivilDate } from "./civil";
import { nextOccurrence, type Rule } from "./rrule";

export interface TriggerSpec {
  /** First occurrence of the anchor (the birthday in its first year, the warranty end date, ...). */
  anchor: CivilDate;
  /** Repeat of the anchor itself (FREQ=YEARLY for birthdays). Null for a one-off date. */
  repeat: Rule | null;
  /** Days from the occurrence to the reminder; negative = before. */
  offsetDays: number;
}

export interface NextFire {
  /** The anchor occurrence this fire belongs to (the birthday it prepares for). */
  occurrence: CivilDate;
  /** Local date to fire on. Never before `today`. */
  fireOn: CivilDate;
  /** True when the ideal date had already passed and this is a catch-up. */
  late: boolean;
}

/**
 * The next fire for a trigger, or null when it is finished.
 *
 * - `lastOccurrence`: the occurrence it last fired for; the next fire is for a later one.
 * - A reminder *before* an occurrence (offset <= 0) is pointless once the occurrence has passed, so a
 *   trigger created 5 days before a birthday with a 14-day lead fires today (late) for this year's birthday,
 *   but one created the day after fires for next year's.
 * - A reminder *after* an occurrence (offset > 0, e.g. a debt nudge) still fires late, once.
 */
export function nextFire(spec: TriggerSpec, today: CivilDate, lastOccurrence: CivilDate | null = null): NextFire | null {
  const { anchor, repeat, offsetDays } = spec;
  let occ: CivilDate | null;
  if (!repeat) {
    if (lastOccurrence) return null;
    occ = anchor;
    if (offsetDays <= 0 && cmp(occ, today) < 0) return null;
  } else {
    // Earliest occurrence still worth a reminder.
    let from = offsetDays > 0 ? addDays(today, -offsetDays) : today;
    if (lastOccurrence && cmp(addDays(lastOccurrence, 1), from) > 0) from = addDays(lastOccurrence, 1);
    occ = nextOccurrence(repeat, anchor, from);
    if (!occ) return null;
  }
  const ideal = addDays(occ, offsetDays);
  const late = cmp(ideal, today) < 0;
  return { occurrence: occ, fireOn: late ? today : ideal, late };
}

/** Days until a date (negative when past). */
export function daysUntil(d: CivilDate, today: CivilDate): number {
  return Math.round((Date.UTC(d.year, d.month - 1, d.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000);
}
