import { describe, expect, it } from "vitest";
import { DEFAULT_REMINDER_SETTINGS, dueReminders, endFireAt, planPush, snoozeUntil, startFireAt, type ReminderItem } from "../worker/core/reminders";
import { zonedToUtc } from "../worker/core/time";

const TZ = "Europe/Paris";
const S = { ...DEFAULT_REMINDER_SETTINGS, tz: TZ };
const at = (d: number, h: number, m = 0) => zonedToUtc(2026, 11, d, h, m, TZ);
const item = (o: Partial<ReminderItem>): ReminderItem => ({
  id: "A",
  status: "open",
  window_start: null,
  window_end: null,
  due_at: null,
  snoozed_until: null,
  reminded_start_at: null,
  reminded_end_at: null,
  ...o,
});

// Next week: Mon 30 Nov .. Sun 6 Dec.
const nextWeek = item({ window_start: at(30, 0).toISOString(), window_end: zonedToUtc(2026, 12, 7, 0, 0, TZ).toISOString() });

describe("reminder times", () => {
  it("start of window at 09:00, evening before the last day at 19:00", () => {
    expect(startFireAt(nextWeek, S)!.toISOString()).toBe(at(30, 9).toISOString());
    expect(endFireAt(nextWeek, S)!.toISOString()).toBe(zonedToUtc(2026, 12, 5, 19, 0, TZ).toISOString());
  });

  it("single-day window gets no evening-before reminder", () => {
    const one = item({ window_start: at(25, 0).toISOString(), window_end: at(26, 0).toISOString() });
    expect(endFireAt(one, S)).toBeNull();
  });

  it("due_at fires at that time", () => {
    const d = item({ due_at: at(24, 15).toISOString(), window_start: at(24, 15).toISOString(), window_end: at(25, 0).toISOString() });
    expect(dueReminders([d], at(24, 14, 59), S)).toEqual([]);
    expect(dueReminders([d], at(24, 15), S)).toEqual([{ itemId: "A", kind: "start" }]);
  });

  it("snooze delays and re-arms", () => {
    const sn = item({ ...nextWeek, snoozed_until: at(30, 18).toISOString() });
    expect(dueReminders([sn], at(30, 10), S)).toEqual([]);
    expect(dueReminders([sn], at(30, 18), S)).toEqual([{ itemId: "A", kind: "start" }]);
  });

  it("does not repeat a sent reminder, and skips closed items", () => {
    expect(dueReminders([{ ...nextWeek, reminded_start_at: "x" }], at(30, 10), S)).toEqual([]);
    expect(dueReminders([{ ...nextWeek, status: "done" }], at(30, 10), S)).toEqual([]);
  });
});

describe("planPush", () => {
  const due = [{ itemId: "A", kind: "start" as const }, { itemId: "B", kind: "start" as const }];
  it("groups reminders into one push", () => {
    const p = planPush({ due, now: at(23, 12), s: S, pushesSentToday: 0, briefSentToday: true, briefHasContent: true });
    expect(p).toMatchObject({ pushes: 1, brief: false });
    expect(p.reminders).toHaveLength(2);
  });
  it("holds during quiet hours", () => {
    const p = planPush({ due, now: at(23, 23), s: S, pushesSentToday: 0, briefSentToday: true, briefHasContent: true });
    expect(p).toMatchObject({ pushes: 0, held: "quiet_hours" });
  });
  it("respects the daily cap", () => {
    const p = planPush({ due, now: at(23, 12), s: S, pushesSentToday: 3, briefSentToday: true, briefHasContent: true });
    expect(p).toMatchObject({ pushes: 0, held: "daily_cap" });
  });
  it("sends the brief at brief time and folds reminders in", () => {
    const p = planPush({ due, now: at(23, 7, 2), s: S, pushesSentToday: 0, briefSentToday: false, briefHasContent: true });
    expect(p).toMatchObject({ pushes: 1, brief: true });
    expect(p.reminders).toHaveLength(2);
  });
  it("skips an empty brief", () => {
    const p = planPush({ due: [], now: at(23, 7, 2), s: S, pushesSentToday: 0, briefSentToday: false, briefHasContent: false });
    expect(p.pushes).toBe(0);
  });
});

describe("snoozeUntil", () => {
  it("presets", () => {
    const now = at(23, 20); // Monday 20:00
    expect(snoozeUntil("evening", now, S).toISOString()).toBe(at(24, 19).toISOString());
    expect(snoozeUntil("tomorrow", now, S).toISOString()).toBe(at(24, 9).toISOString());
    expect(snoozeUntil("next_week", now, S).toISOString()).toBe(at(30, 9).toISOString());
  });
});
