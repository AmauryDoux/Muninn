// Calendar and daily summary I/O: holidays, important dates, dated items (and linked calendars' events) per local day.
import { dateFactKind } from "./core/categories";
import { ageOn, parseDateFact } from "./core/civil";
import { dateFactDays, dateFactTitle, dayHeadline, itemDay } from "./core/day";
import { holidayMode, notableDays, type HolidayMode } from "./core/holidays";
import { addDays, civilOf, civilToIso, parseCivil, startOfLocalDay, type CivilDate } from "./core/time";
import { getSetting } from "./lib/settings";
import { HttpError, json } from "./lib/http";
import type { ItemRow, Repo } from "./repo";

/** At most this many days per calendar request: a month view with the spill-over weeks fits. */
export const MAX_RANGE_DAYS = 62;

export type CalEntry =
  | { kind: "holiday"; date: string; title: string; off: boolean; federal: boolean }
  | { kind: "date"; date: string; title: string; key: string; fact_id: string; person_id: string | null }
  | { kind: "item"; date: string; title: string; id: string; at: string | null; by: boolean; done: boolean }
  | { kind: "event"; date: string; title: string; id: string; at: string | null; end: string | null; all_day: boolean; calendar: string; color: string | null; location: string | null };

const ORDER: Record<CalEntry["kind"], number> = { holiday: 0, date: 1, event: 2, item: 3 };

export function sortEntries(e: CalEntry[]): CalEntry[] {
  const at = (x: CalEntry) => ("at" in x && x.at ? x.at : "");
  return e.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : ORDER[a.kind] - ORDER[b.kind] || at(a).localeCompare(at(b))));
}

export async function holidaySetting(repo: Repo): Promise<HolidayMode> {
  return holidayMode(await getSetting(repo.db, "holidays"));
}

async function dateEntries(repo: Repo, from: CivilDate, to: CivilDate): Promise<CalEntry[]> {
  const people = new Map((await repo.people()).map((p) => [p.id, p.name]));
  const { results } = await repo.db
    .prepare("SELECT id, subject_type, subject_id, key, value_enc FROM facts WHERE active = 1 AND value_type = 'date' LIMIT 500")
    .all<{ id: string; subject_type: string; subject_id: string | null; key: string; value_enc: string }>();
  const out: CalEntry[] = [];
  for (const f of results) {
    const k = dateFactKind(f.key);
    if (!k) continue;
    let df;
    try {
      df = parseDateFact(await repo.cipher.decrypt(f.value_enc, `facts:${f.id}:value`));
    } catch {
      continue; // one unreadable fact must not take the calendar down
    }
    if (!df) continue;
    const who = f.subject_type === "person" && f.subject_id ? (people.get(f.subject_id) ?? null) : null;
    for (const on of dateFactDays(df, k.yearly, from, to)) {
      const age = f.key === "birthday" && df.year != null ? ageOn({ year: df.year, month: df.month, day: df.day }, on) : null;
      out.push({
        kind: "date",
        date: civilToIso(on),
        title: dateFactTitle({ key: f.key, label: k.label, who, age }),
        key: f.key,
        fact_id: f.id,
        person_id: f.subject_type === "person" ? f.subject_id : null,
      });
    }
  }
  return out;
}

async function itemEntries(repo: Repo, from: CivilDate, to: CivilDate, tz: string): Promise<CalEntry[]> {
  const start = startOfLocalDay(from, tz).toISOString();
  const end = startOfLocalDay(addDays(to, 1), tz).toISOString();
  // Anything whose time or window touches the range; itemDay then decides the one day it is shown on.
  const { results } = await repo.db
    .prepare(
      `SELECT * FROM items WHERE status IN ('open', 'done') AND (
         (due_at IS NOT NULL AND due_at >= ? AND due_at < ?)
         OR (due_at IS NULL AND window_start IS NOT NULL AND window_start < ? AND COALESCE(window_end, window_start) >= ?)
       ) LIMIT 1000`,
    )
    .bind(start, end, end, start)
    .all<ItemRow>();
  const a = civilToIso(from);
  const b = civilToIso(to);
  const out: CalEntry[] = [];
  for (const v of await repo.itemViews(results)) {
    const d = itemDay(v, tz);
    if (!d || d.date < a || d.date > b) continue;
    out.push({ kind: "item", date: d.date, title: v.title, id: v.id, at: v.due_at, by: d.by, done: v.status === "done" });
  }
  return out;
}

/** Events from linked calendars. Filled in by the calendar sync; empty until one is linked. */
export type EventSource = (from: CivilDate, to: CivilDate, tz: string) => Promise<CalEntry[]>;

export async function calendarEntries(repo: Repo, from: CivilDate, to: CivilDate, tz: string, events?: EventSource): Promise<CalEntry[]> {
  const mode = await holidaySetting(repo);
  const holidays: CalEntry[] = notableDays(from, to, tz, mode).map((h) => ({ kind: "holiday", date: h.date, title: h.name, off: h.off, federal: h.kind === "federal" }));
  const [dates, items, evs] = await Promise.all([
    dateEntries(repo, from, to),
    itemEntries(repo, from, to, tz),
    events ? events(from, to, tz).catch((e) => (console.warn("calendar events failed", e instanceof Error ? e.message : e), [] as CalEntry[])) : Promise.resolve([]),
  ]);
  return sortEntries([...holidays, ...dates, ...items, ...evs]);
}

/** GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive, at most MAX_RANGE_DAYS days). */
export async function getCalendar(repo: Repo, url: URL, tz: string, events?: EventSource): Promise<Response> {
  const from = parseCivil(url.searchParams.get("from") ?? "");
  const to = parseCivil(url.searchParams.get("to") ?? "");
  if (!from || !to) throw new HttpError(400, "bad_range");
  const days = Math.round((Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / 86_400_000) + 1;
  if (days < 1 || days > MAX_RANGE_DAYS) throw new HttpError(400, "bad_range");
  return json({ from: civilToIso(from), to: civilToIso(to), today: civilToIso(civilOf(new Date(), tz)), entries: await calendarEntries(repo, from, to, tz, events) });
}

export interface DaySummary {
  date: string;
  headline: string;
  /** Holidays, important dates and calendar events today (items are already on the Today screen). */
  today: CalEntry[];
  /** Holidays and important dates in the next 7 days. */
  soon: CalEntry[];
}

/** The deterministic part of the Today card: no model call, so it is always right and costs nothing. */
export async function daySummary(repo: Repo, now: Date, tz: string, events?: EventSource): Promise<DaySummary> {
  const today = civilOf(now, tz);
  const all = await calendarEntries(repo, today, addDays(today, 7), tz, events);
  const iso = civilToIso(today);
  const todays = all.filter((e) => e.date === iso && e.kind !== "item");
  const holidaysToday = todays.flatMap((e) => (e.kind === "holiday" ? [{ name: e.title, kind: e.federal ? ("federal" as const) : ("observance" as const) }] : []));
  return {
    date: iso,
    headline: dayHeadline(today, holidaysToday),
    today: todays,
    soon: all.filter((e) => e.date > iso && (e.kind === "holiday" || e.kind === "date")),
  };
}
