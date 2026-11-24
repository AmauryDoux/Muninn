// Pure date logic. No I/O. All "local" values are in the user's IANA time zone.

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday ... 6 = Saturday
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimeZone(tz: string): boolean {
  try {
    dtf(tz);
    return true;
  } catch {
    return false;
  }
}

export function localParts(at: Date, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of dtf(tz).formatToParts(at)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WD[p.weekday],
  };
}

/** Offset of tz from UTC at instant `at`, in minutes (e.g. +60 for Paris in winter). */
function offsetMinutes(at: Date, tz: string): number {
  const p = localParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

/** The UTC instant of a local wall-clock time. Non-existent times (DST gap) move forward. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let t = guess - offsetMinutes(new Date(guess), tz) * 60000;
  // Second pass handles instants near a DST change.
  t = guess - offsetMinutes(new Date(t), tz) * 60000;
  return new Date(t);
}

/** A calendar date with no zone. */
export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export function civilOf(at: Date, tz: string): CivilDate {
  const p = localParts(at, tz);
  return { year: p.year, month: p.month, day: p.day };
}

export function addDays(d: CivilDate, n: number): CivilDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function weekdayOf(d: CivilDate): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

export function civilToIso(d: CivilDate): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

export function parseCivil(s: string): CivilDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  // Reject 2026-02-31 and friends.
  const back = addDays(d, 0);
  if (back.year !== d.year || back.month !== d.month || back.day !== d.day) return null;
  return d;
}

export function startOfLocalDay(d: CivilDate, tz: string): Date {
  return zonedToUtc(d.year, d.month, d.day, 0, 0, tz);
}

/**
 * A time reference as the parser model returns it. The model only names the reference;
 * code turns it into dates, so "next week" always means the same thing.
 */
export interface TimeRef {
  type: "none" | "date" | "range" | "relative" | "weekday";
  /** type=date: YYYY-MM-DD. type=range: start date. */
  date?: string | null;
  /** type=range: end date, inclusive. */
  end_date?: string | null;
  /** type=relative: calendar unit. */
  unit?: "day" | "week" | "weekend" | "month" | null;
  /** type=relative: 0 = this, 1 = next, -1 = last, -2 = two ago. type=weekday: 0 = the coming one (today counts), 1 = the one after. */
  offset?: number | null;
  /** type=weekday: 0 = Sunday ... 6 = Saturday. */
  weekday?: number | null;
  /** Optional local time, HH:MM 24h. */
  time?: string | null;
}

export interface ResolvedWindow {
  /** Inclusive first local date. */
  startDate: string;
  /** Inclusive last local date. */
  endDate: string;
  /** UTC instant of start (local 00:00, or the given time). */
  start: Date;
  /** UTC instant just after the last day (exclusive). */
  end: Date;
  /** Set when a time of day was given. */
  dueAt: Date | null;
}

function parseTime(t: string | null | undefined): { h: number; m: number } | null {
  if (!t) return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t);
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

/** Monday-start weeks (ISO 8601). */
function startOfWeek(d: CivilDate): CivilDate {
  const wd = weekdayOf(d);
  return addDays(d, -((wd + 6) % 7));
}

export function resolveTimeRef(ref: TimeRef | null | undefined, now: Date, tz: string): ResolvedWindow | null {
  if (!ref || ref.type === "none") return null;
  const today = civilOf(now, tz);
  let a: CivilDate | null = null;
  let b: CivilDate | null = null;
  const offset = Math.trunc(ref.offset ?? 0);
  if (Math.abs(offset) > 520) return null; // ten years of weeks; anything bigger is nonsense

  switch (ref.type) {
    case "date":
      a = b = ref.date ? parseCivil(ref.date) : null;
      break;
    case "range":
      a = ref.date ? parseCivil(ref.date) : null;
      b = ref.end_date ? parseCivil(ref.end_date) : a;
      if (a && b && civilToIso(b) < civilToIso(a)) [a, b] = [b, a];
      break;
    case "relative":
      switch (ref.unit) {
        case "day":
          a = b = addDays(today, offset);
          break;
        case "week":
          a = addDays(startOfWeek(today), 7 * offset);
          b = addDays(a, 6);
          break;
        case "weekend": {
          // The coming weekend (or the current one, on Saturday/Sunday).
          const wd = weekdayOf(today);
          const sat = wd === 0 ? addDays(today, -1) : addDays(today, (6 - wd + 7) % 7);
          a = addDays(sat, 7 * offset);
          b = addDays(a, 1);
          break;
        }
        case "month": {
          const idx = today.year * 12 + (today.month - 1) + offset;
          const y = Math.floor(idx / 12);
          const mo = (idx % 12) + 1;
          a = { year: y, month: mo, day: 1 };
          b = addDays({ year: mo === 12 ? y + 1 : y, month: mo === 12 ? 1 : mo + 1, day: 1 }, -1);
          break;
        }
        default:
          return null;
      }
      break;
    case "weekday": {
      const target = ref.weekday;
      if (target == null || target < 0 || target > 6) return null;
      const diff = (target - weekdayOf(today) + 7) % 7;
      a = b = addDays(today, diff + 7 * Math.max(0, offset));
      break;
    }
    default:
      return null;
  }
  if (!a || !b) return null;

  const time = parseTime(ref.time);
  const single = civilToIso(a) === civilToIso(b);
  const dueAt = time && single ? zonedToUtc(a.year, a.month, a.day, time.h, time.m, tz) : null;
  return {
    startDate: civilToIso(a),
    endDate: civilToIso(b),
    start: dueAt ?? startOfLocalDay(a, tz),
    end: startOfLocalDay(addDays(b, 1), tz),
    dueAt,
  };
}

/** Is local time `at` inside quiet hours [start, end) given as HH:MM? Handles windows that cross midnight. */
export function inQuietHours(at: Date, tz: string, start: string, end: string): boolean {
  const s = parseTime(start);
  const e = parseTime(end);
  if (!s || !e) return false;
  const p = localParts(at, tz);
  const cur = p.hour * 60 + p.minute;
  const sm = s.h * 60 + s.m;
  const em = e.h * 60 + e.m;
  if (sm === em) return false;
  return sm < em ? cur >= sm && cur < em : cur >= sm || cur < em;
}

export function localTimeOn(d: CivilDate, hhmm: string, tz: string): Date {
  const t = parseTime(hhmm) ?? { h: 9, m: 0 };
  return zonedToUtc(d.year, d.month, d.day, t.h, t.m, tz);
}
