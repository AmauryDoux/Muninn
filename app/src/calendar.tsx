// Calendar: the daily summary on Today, and the month view (holidays, important dates, items, linked calendars).
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { errText } from "./auth";
import { tz } from "./fmt";
import { Icon } from "./icons";

export type CalEntry =
  | { kind: "holiday"; date: string; title: string; off: boolean; federal: boolean }
  | { kind: "date"; date: string; title: string; key: string; fact_id: string; person_id: string | null }
  | { kind: "item"; date: string; title: string; id: string; at: string | null; by: boolean; done: boolean }
  | { kind: "event"; date: string; title: string; id: string; at: string | null; end: string | null; all_day: boolean; calendar: string; color: string | null; location: string | null };

export interface DaySummary {
  date: string;
  headline: string;
  today: CalEntry[];
  soon: CalEntry[];
}

const WD = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Date-only arithmetic on YYYY-MM-DD strings, in UTC so no zone can shift a day.
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (s: string, n: number) => toIso(new Date(toDate(s).getTime() + n * 86_400_000));

function timeOf(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz(), hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function shortDay(s: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(toDate(s));
}

const ICON: Record<CalEntry["kind"], string> = { holiday: "flag", date: "calendarHeart", item: "check", event: "calendar" };

export function EntryRow({ e }: { e: CalEntry }) {
  const href = e.kind === "item" ? `#/item/${e.id}` : undefined;
  const time = e.kind === "event" ? (e.all_day ? "All day" : e.at ? timeOf(e.at) : "") : e.kind === "item" ? (e.by ? "By today" : e.at ? timeOf(e.at) : "") : "";
  const sub = e.kind === "event" ? [e.calendar, e.location].filter(Boolean).join(" · ") : e.kind === "holiday" && e.off ? "Day off" : "";
  const body = (
    <>
      <span className={`cal-ic k-${e.kind}`} style={e.kind === "event" && e.color ? { color: e.color } : undefined}>
        <Icon name={ICON[e.kind]} size={18} />
      </span>
      <span className="grow">
        <span className={e.kind === "item" && e.done ? "cal-title done" : "cal-title"}>{e.title}</span>
        {sub && <span className="cal-sub">{sub}</span>}
      </span>
      {time && <span className="cal-time">{time}</span>}
    </>
  );
  return href ? (
    <a className="cal-row" href={href}>
      {body}
    </a>
  ) : (
    <div className="cal-row">{body}</div>
  );
}

/** The top of Today: the date and holiday (computed, always right), what's on today, the AI line, and what's soon. */
export function DayCard({ day, summary, counts }: { day: DaySummary | null; summary: string; counts: { today: number; overdue: number } }) {
  return (
    <section className="card">
      {day && <p className="day-headline">{day.headline}</p>}
      {day && day.today.length > 0 && (
        <div className="cal-list">
          {day.today.map((e, i) => (
            <EntryRow key={i} e={e} />
          ))}
        </div>
      )}
      <p className="brief">{summary}</p>
      <div className="brief-meta">
        <span>
          <b>{counts.today}</b> today
        </span>
        {counts.overdue > 0 && (
          <span className="tone-bad">
            <b>{counts.overdue}</b> overdue
          </span>
        )}
      </div>
      {day && day.soon.length > 0 && (
        <div className="day-soon">
          <span className="day-soon-h">Coming up</span>
          {day.soon.slice(0, 4).map((e, i) => (
            <span key={i} className="day-soon-row">
              <span className="muted">{shortDay(e.date)}</span> {e.title}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/** Six weeks starting on the Sunday on or before the 1st: always the same grid height. */
export function monthGrid(year: number, month: number): string[] {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const start = plusDays(first, -toDate(first).getUTCDay());
  return Array.from({ length: 42 }, (_, i) => plusDays(start, i));
}

export function MonthView() {
  const [today, setToday] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: tz() }).format(new Date()));
  const [ym, setYm] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) }));
  const [sel, setSel] = useState(today);
  const [entries, setEntries] = useState<CalEntry[] | null>(null);
  const [err, setErr] = useState("");
  const days = useMemo(() => monthGrid(ym.y, ym.m), [ym]);

  const load = useCallback(() => {
    setErr("");
    api<{ entries: CalEntry[]; today: string }>(`/api/calendar?from=${days[0]}&to=${days[41]}`)
      .then((r) => {
        setEntries(r.entries);
        setToday(r.today);
      })
      .catch((e) => setErr(errText(e)));
  }, [days]);
  useEffect(load, [load]);

  const byDay = useMemo(() => {
    const m = new Map<string, CalEntry[]>();
    for (const e of entries ?? []) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return m;
  }, [entries]);

  const move = (n: number) => {
    const idx = ym.y * 12 + ym.m - 1 + n;
    const y = Math.floor(idx / 12);
    const m = idx - y * 12 + 1;
    setYm({ y, m });
    setSel(`${y}-${String(m).padStart(2, "0")}-01`);
  };
  const monthKey = `${ym.y}-${String(ym.m).padStart(2, "0")}`;
  const selected = byDay.get(sel) ?? [];

  return (
    <>
      <div className="cal-nav">
        <button className="roundbtn" aria-label="Previous month" onClick={() => move(-1)}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <span className="cal-month">
          {MONTHS[ym.m - 1]} {ym.y}
        </span>
        {monthKey !== today.slice(0, 7) && (
          <button
            className="btn ghost small"
            onClick={() => {
              setYm({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) });
              setSel(today);
            }}
          >
            Today
          </button>
        )}
        <button className="roundbtn" aria-label="Next month" onClick={() => move(1)}>
          <Icon name="chevronRight" size={20} />
        </button>
      </div>
      <section className="card cal-grid" aria-busy={entries === null}>
        {WD.map((w, i) => (
          <span key={i} className="cal-wd">
            {w}
          </span>
        ))}
        {days.map((d) => {
          const es = byDay.get(d) ?? [];
          const kinds = [...new Set(es.map((e) => e.kind))];
          const cls = ["cal-day", d.slice(0, 7) !== monthKey && "out", d === today && "today", d === sel && "sel", es.some((e) => e.kind === "holiday" && e.off) && "off"].filter(Boolean).join(" ");
          return (
            <button key={d} className={cls} onClick={() => setSel(d)} aria-label={`${shortDay(d)}, ${es.length} entries`} aria-pressed={d === sel}>
              <span className="n">{Number(d.slice(8))}</span>
              <span className="dots">
                {kinds.slice(0, 4).map((k) => (
                  <i key={k} className={`k-${k}`} />
                ))}
              </span>
            </button>
          );
        })}
      </section>
      {err && <p className="error">{err}</p>}
      <div className="section-h">
        <span>{sel === today ? "Today" : shortDay(sel)}</span>
      </div>
      <section className="card tight">
        {selected.length ? selected.map((e, i) => <EntryRow key={i} e={e} />) : <p className="muted small cal-empty">Nothing on this day.</p>}
      </section>
    </>
  );
}
