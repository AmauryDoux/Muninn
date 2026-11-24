// Pure pattern mining over the event log. Patterns are facts Muninn *observed* (not told), always shown
// with their sample size in "What I know", and switchable off. Each needs a minimum sample, so one
// odd week does not become a habit.
import { civilOf, civilToIso, localParts } from "./time";

export interface PatternEvent {
  at: string; // ISO
  type: string; // done, snooze, dismiss, act, ...
  item_id: string | null;
  payload_json: string | null;
}

export interface PatternOut {
  key: string;
  value: Record<string, unknown>;
  sample: number;
}

const DAY_MS = 86_400_000;
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function mode(xs: number[]): { value: number; count: number } | null {
  const c = new Map<number, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  let best: { value: number; count: number } | null = null;
  for (const [value, count] of c) if (!best || count > best.count || (count === best.count && value < best.value)) best = { value, count };
  return best;
}

export function normPlace(s: string | null | undefined): string | null {
  const n = (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return n || null;
}

export function computePatterns(
  events: PatternEvent[],
  placeOf: (itemId: string) => string | null,
  now: Date,
  tz: string,
): PatternOut[] {
  const out: PatternOut[] = [];
  const since = (days: number) => now.getTime() - days * DAY_MS;

  // When the user tends to finish things (local hour), over 60 days, min 10 completions.
  const doneHours = events.filter((e) => e.type === "done" && Date.parse(e.at) >= since(60)).map((e) => localParts(new Date(e.at), tz).hour);
  const dh = mode(doneHours);
  if (dh && doneHours.length >= 10 && dh.count / doneHours.length >= 0.2) {
    out.push({ key: "done_hour", value: { hour: dh.value, share: round(dh.count / doneHours.length) }, sample: doneHours.length });
  }

  // Errands: completed items with a place, over 90 days, min 6.
  const errands = events
    .filter((e) => e.type === "done" && e.item_id && Date.parse(e.at) >= since(90))
    .map((e) => ({ at: new Date(e.at), place: normPlace(placeOf(e.item_id!)) }))
    .filter((e): e is { at: Date; place: string } => !!e.place);
  const wd = mode(errands.map((e) => localParts(e.at, tz).weekday));
  if (wd && errands.length >= 6 && wd.count / errands.length >= 0.3) {
    out.push({ key: "errand_day", value: { weekday: wd.value, name: WEEKDAYS[wd.value], share: round(wd.count / errands.length) }, sample: errands.length });
  }

  // Trips: distinct (day, place) pairs in the last 28 days. Many trips on many days = room to batch.
  const recent = errands.filter((e) => e.at.getTime() >= since(28));
  const trips = new Set(recent.map((e) => `${civilToIso(civilOf(e.at, tz))}|${e.place}`));
  const days = new Set(recent.map((e) => civilToIso(civilOf(e.at, tz))));
  if (trips.size >= 6) {
    out.push({ key: "errand_trips", value: { per_week: round(trips.size / 4), days_per_week: round(days.size / 4) }, sample: trips.size });
  }

  // Preferred snooze, min 5 snoozes in 60 days.
  const presets = events
    .filter((e) => e.type === "snooze" && Date.parse(e.at) >= since(60))
    .map((e) => {
      try {
        return (JSON.parse(e.payload_json ?? "{}") as { preset?: string }).preset ?? null;
      } catch {
        return null;
      }
    })
    .filter((p): p is string => !!p);
  if (presets.length >= 5) {
    const c = new Map<string, number>();
    for (const p of presets) c.set(p, (c.get(p) ?? 0) + 1);
    const [preset, n] = [...c].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    out.push({ key: "snooze_preset", value: { preset, share: round(n / presets.length) }, sample: presets.length });
  }
  return out;
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
