// Pure RRULE subset (RFC 5545) for recurring items: meds, seasonal chores, service intervals.
// Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY (weekly only, no ordinals),
// BYMONTH, BYMONTHDAY (1..31 or -1 for the last day), UNTIL=YYYYMMDD.
// Deliberate deviation from RFC 5545: a day that does not exist in a month (31st, 29 Feb) is clamped
// to the month's last day instead of skipped, because a reminder should never silently vanish.
import { addDays, addMonths, clampDay, cmp, daysInMonth, diffDays, type CivilDate } from "./civil";
import { weekdayOf } from "./time";

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface Rule {
  freq: Freq;
  interval: number;
  byDay: number[] | null; // 0 = Sunday ... 6 = Saturday
  byMonth: number[] | null; // 1..12
  byMonthDay: number | null; // 1..31 or -1
  until: CivilDate | null;
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MAX_PERIODS = 5000;

export function parseRule(s: string | null | undefined): Rule | null {
  if (!s || s.length > 200) return null;
  const parts = new Map<string, string>();
  for (const p of s.trim().toUpperCase().replace(/^RRULE:/, "").split(";")) {
    if (!p) continue;
    const [k, v] = p.split("=");
    if (!k || v === undefined || parts.has(k)) return null;
    parts.set(k, v);
  }
  const freq = parts.get("FREQ") as Freq | undefined;
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  for (const k of parts.keys()) if (!["FREQ", "INTERVAL", "BYDAY", "BYMONTH", "BYMONTHDAY", "UNTIL"].includes(k)) return null;
  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) return null;

  let byDay: number[] | null = null;
  if (parts.has("BYDAY")) {
    if (freq !== "WEEKLY") return null;
    byDay = [];
    for (const d of parts.get("BYDAY")!.split(",")) {
      const i = DAYS.indexOf(d);
      if (i < 0) return null;
      if (!byDay.includes(i)) byDay.push(i);
    }
    byDay.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday-first order
  }
  let byMonth: number[] | null = null;
  if (parts.has("BYMONTH")) {
    if (freq !== "MONTHLY" && freq !== "YEARLY") return null;
    byMonth = [];
    for (const m of parts.get("BYMONTH")!.split(",")) {
      const n = Number(m);
      if (!Number.isInteger(n) || n < 1 || n > 12) return null;
      if (!byMonth.includes(n)) byMonth.push(n);
    }
    byMonth.sort((a, b) => a - b);
  }
  let byMonthDay: number | null = null;
  if (parts.has("BYMONTHDAY")) {
    if (freq !== "MONTHLY" && freq !== "YEARLY") return null;
    const n = Number(parts.get("BYMONTHDAY"));
    if (!Number.isInteger(n) || n === 0 || n < -1 || n > 31) return null;
    byMonthDay = n;
  }
  let until: CivilDate | null = null;
  if (parts.has("UNTIL")) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(parts.get("UNTIL")!);
    if (!m) return null;
    const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > daysInMonth(d.year, d.month)) return null;
    until = d;
  }
  return { freq, interval, byDay, byMonth, byMonthDay, until };
}

export function formatRule(r: Rule): string {
  const out = [`FREQ=${r.freq}`];
  if (r.interval !== 1) out.push(`INTERVAL=${r.interval}`);
  if (r.byDay) out.push(`BYDAY=${r.byDay.map((d) => DAYS[d]).join(",")}`);
  if (r.byMonth) out.push(`BYMONTH=${r.byMonth.join(",")}`);
  if (r.byMonthDay != null) out.push(`BYMONTHDAY=${r.byMonthDay}`);
  if (r.until) out.push(`UNTIL=${r.until.year}${String(r.until.month).padStart(2, "0")}${String(r.until.day).padStart(2, "0")}`);
  return out.join(";");
}

function dayIn(year: number, month: number, byMonthDay: number | null, fallback: number): CivilDate {
  if (byMonthDay === -1) return { year, month, day: daysInMonth(year, month) };
  return clampDay(year, month, byMonthDay ?? fallback);
}

/** Occurrences in the k-th period after dtstart's period (k >= 0), in order. */
function period(r: Rule, start: CivilDate, k: number): CivilDate[] {
  const step = k * r.interval;
  switch (r.freq) {
    case "DAILY":
      return [addDays(start, step)];
    case "WEEKLY": {
      if (!r.byDay) return [addDays(start, 7 * step)];
      const monday = addDays(start, -((weekdayOf(start) + 6) % 7) + 7 * step);
      return r.byDay.map((d) => addDays(monday, (d + 6) % 7));
    }
    case "MONTHLY": {
      const m = addMonths({ ...start, day: 1 }, step);
      if (r.byMonth && !r.byMonth.includes(m.month)) return [];
      return [dayIn(m.year, m.month, r.byMonthDay, start.day)];
    }
    case "YEARLY": {
      const y = start.year + step;
      return (r.byMonth ?? [start.month]).map((mo) => dayIn(y, mo, r.byMonthDay, start.day));
    }
  }
}

/** Rough number of periods between start and d, used to jump close before scanning. */
function periodsBetween(r: Rule, start: CivilDate, d: CivilDate): number {
  const days = diffDays(start, d);
  const per = r.freq === "DAILY" ? 1 : r.freq === "WEEKLY" ? 7 : r.freq === "MONTHLY" ? 28 : 365;
  return Math.floor(days / per / r.interval);
}

/**
 * First occurrence on or after `from` (dtstart itself is the first occurrence, as in RFC 5545 when it matches).
 * Returns null when UNTIL has passed or nothing matches.
 */
export function nextOccurrence(r: Rule, dtstart: CivilDate, from: CivilDate): CivilDate | null {
  const target = cmp(from, dtstart) > 0 ? from : dtstart;
  const k0 = Math.max(0, periodsBetween(r, dtstart, target) - 2);
  for (let k = k0; k < k0 + MAX_PERIODS; k++) {
    for (const o of period(r, dtstart, k)) {
      if (cmp(o, dtstart) < 0 || cmp(o, target) < 0) continue;
      if (r.until && cmp(o, r.until) > 0) return null;
      return o;
    }
    if (r.until) {
      const ps = period(r, dtstart, k);
      if (ps.length && cmp(ps[0], r.until) > 0) return null;
    }
  }
  return null;
}

/** First occurrence strictly after `after`. */
export function occurrenceAfter(r: Rule, dtstart: CivilDate, after: CivilDate): CivilDate | null {
  return nextOccurrence(r, dtstart, addDays(after, 1));
}

/** Human wording for the app: "every day", "every 2 weeks on Mon, Thu", "every year in Oct". */
export function describeRule(r: Rule): string {
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[r.freq];
  let s = r.interval === 1 ? `every ${unit}` : `every ${r.interval} ${unit}s`;
  const DN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (r.byDay) s += ` on ${r.byDay.map((d) => DN[d]).join(", ")}`;
  if (r.byMonth) s += ` in ${r.byMonth.map((m) => MN[m - 1]).join(", ")}`;
  if (r.byMonthDay === -1) s += " on the last day";
  else if (r.byMonthDay != null) s += ` on day ${r.byMonthDay}`;
  return s;
}

/** The parser's structured recurrence, turned into a validated RRULE string (or null). */
export interface RecurrenceRef {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number | null;
  by_month?: number[] | null;
  by_weekday?: number[] | null;
}

export function recurrenceToRule(r: RecurrenceRef | null | undefined): string | null {
  if (!r) return null;
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval && r.interval > 1) parts.push(`INTERVAL=${Math.trunc(r.interval)}`);
  if (r.freq === "weekly" && r.by_weekday?.length) {
    const ds = [...new Set(r.by_weekday)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (ds.length) parts.push(`BYDAY=${ds.map((d) => DAYS[d]).join(",")}`);
  }
  if ((r.freq === "yearly" || r.freq === "monthly") && r.by_month?.length) {
    const ms = [...new Set(r.by_month)].filter((m) => Number.isInteger(m) && m >= 1 && m <= 12);
    if (ms.length) parts.push(`BYMONTH=${ms.join(",")}`);
  }
  const rule = parseRule(parts.join(";"));
  return rule ? formatRule(rule) : null;
}
