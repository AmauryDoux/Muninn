// Pure study-streak statistics for the learning tracker.
import { addDays, cmp, diffDays, parseCivil, civilToIso, type CivilDate } from "./civil";
import { weekdayOf } from "./time";

export interface Session {
  date: string; // local YYYY-MM-DD
  minutes: number;
}

export interface StudyStats {
  /** Consecutive days with a session, ending today, or yesterday when today has none yet (the streak is still alive). */
  current: number;
  best: number;
  todayDone: boolean;
  last: string | null;
  daysSinceLast: number | null;
  weekMinutes: number; // Monday-start week
  last30Minutes: number;
  sessions30: number;
}

export function studyStats(sessions: Session[], today: CivilDate): StudyStats {
  const days = new Map<string, number>();
  for (const s of sessions) {
    const d = parseCivil(s.date);
    if (!d || cmp(d, today) > 0) continue;
    days.set(civilToIso(d), (days.get(civilToIso(d)) ?? 0) + Math.max(0, s.minutes || 0));
  }
  const sorted = [...days.keys()].sort();
  let best = 0;
  let run = 0;
  let prev: CivilDate | null = null;
  for (const k of sorted) {
    const d = parseCivil(k)!;
    run = prev && diffDays(prev, d) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  const todayDone = days.has(civilToIso(today));
  let current = 0;
  let cur = todayDone ? today : addDays(today, -1);
  while (days.has(civilToIso(cur))) {
    current++;
    cur = addDays(cur, -1);
  }
  const last = sorted.length ? sorted[sorted.length - 1] : null;
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
  let weekMinutes = 0;
  let last30Minutes = 0;
  let sessions30 = 0;
  for (const [k, m] of days) {
    const d = parseCivil(k)!;
    if (cmp(d, monday) >= 0) weekMinutes += m;
    if (diffDays(d, today) < 30) {
      last30Minutes += m;
      sessions30++;
    }
  }
  return { current, best, todayDone, last, daysSinceLast: last ? diffDays(parseCivil(last)!, today) : null, weekMinutes, last30Minutes, sessions30 };
}
