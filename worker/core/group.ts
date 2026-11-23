// Pure grouping of open items for the Today screen and the morning brief. Shared by Worker and app.

export interface Groupable {
  status: string;
  window_start: string | null;
  window_end: string | null; // exclusive
  due_at: string | null;
  snoozed_until: string | null;
}

export type Bucket = "overdue" | "today" | "upcoming" | "anytime" | "snoozed";

/** dayStart/dayEnd: UTC instants of the user's local midnight today and tomorrow. */
export function bucketOf(it: Groupable, now: Date, dayStart: Date, dayEnd: Date): Bucket {
  if (it.snoozed_until && new Date(it.snoozed_until) > now) return "snoozed";
  if (it.due_at) {
    const due = new Date(it.due_at);
    if (due < dayStart) return "overdue";
    if (due < dayEnd) return due < now ? "overdue" : "today";
    return "upcoming";
  }
  if (it.window_start) {
    const s = new Date(it.window_start);
    const e = it.window_end ? new Date(it.window_end) : null;
    if (e && e <= dayStart) return "overdue";
    if (s < dayEnd) return "today";
    return "upcoming";
  }
  return "anytime";
}

export function groupItems<T extends Groupable>(items: T[], now: Date, dayStart: Date, dayEnd: Date): Record<Bucket, T[]> {
  const out: Record<Bucket, T[]> = { overdue: [], today: [], upcoming: [], anytime: [], snoozed: [] };
  for (const it of items) if (it.status === "open") out[bucketOf(it, now, dayStart, dayEnd)].push(it);
  const key = (x: Groupable) => x.due_at ?? x.window_start ?? "9999";
  for (const b of Object.keys(out) as Bucket[]) out[b].sort((a, c) => key(a).localeCompare(key(c)));
  return out;
}
