// Display helpers. All times are shown in the user's configured time zone.
import type { Item } from "./api";

let TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
export function setTz(tz: string | null | undefined) {
  if (tz) TZ = tz;
}
export function tz() {
  return TZ;
}

const dayFmt = () => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const timeFmt = () => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const isoDayFmt = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

export function localDate(iso: string): string {
  return isoDayFmt().format(new Date(iso));
}

export function when(it: Pick<Item, "due_at" | "window_start" | "window_end">): string | null {
  if (it.due_at) return `${dayFmt().format(new Date(it.due_at))} ${timeFmt().format(new Date(it.due_at))}`;
  if (!it.window_start) return null;
  const s = new Date(it.window_start);
  const e = it.window_end ? new Date(new Date(it.window_end).getTime() - 1) : s;
  const a = dayFmt().format(s);
  const b = dayFmt().format(e);
  return a === b ? a : `${a} to ${b}`;
}

/** Local midnight today and tomorrow as UTC instants, computed in the configured zone. */
export function todayBounds(now = new Date()): { start: Date; end: Date } {
  const iso = localDate(now.toISOString());
  const start = zonedMidnight(iso);
  const [y, m, d] = iso.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start, end: zonedMidnight(next) };
}

function zonedMidnight(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(guess));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return new Date(guess - (asUtc - guess));
}

export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return dayFmt().format(new Date(iso));
}
