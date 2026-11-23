// Pure reminder planning. The cron feeds rows in; this decides what is due. No I/O.
import { addDays, civilOf, inQuietHours, localParts, localTimeOn, weekdayOf } from "./time";

export interface ReminderItem {
  id: string;
  status: "open" | "done" | "dropped";
  window_start: string | null;
  window_end: string | null; // exclusive
  due_at: string | null;
  snoozed_until: string | null;
  reminded_start_at: string | null;
  reminded_end_at: string | null;
}

export interface ReminderSettings {
  tz: string;
  quietStart: string; // "22:00"
  quietEnd: string; // "07:00"
  dailyCap: number; // total pushes per local day
  startHour: string; // local time for an all-day window's first reminder, "09:00"
  eveningHour: string; // "19:00", evening-before-end reminder
  briefTime: string; // "07:00"
}

export const DEFAULT_REMINDER_SETTINGS: Omit<ReminderSettings, "tz"> = {
  quietStart: "22:00",
  quietEnd: "07:00",
  dailyCap: 3,
  startHour: "09:00",
  eveningHour: "19:00",
  briefTime: "07:00",
};

export type ReminderKind = "start" | "end";

/** When the "start" reminder for an item should fire, or null if it has none. */
export function startFireAt(item: ReminderItem, s: ReminderSettings): Date | null {
  let base: Date | null = null;
  if (item.due_at) base = new Date(item.due_at);
  else if (item.window_start) {
    const startLocal = civilOf(new Date(item.window_start), s.tz);
    base = localTimeOn(startLocal, s.startHour, s.tz);
  }
  if (item.snoozed_until) {
    const sn = new Date(item.snoozed_until);
    if (!base || sn > base) base = sn;
  }
  return base;
}

/** "The evening before it ends": eveningHour on the day before the window's last day. Only for multi-day windows. */
export function endFireAt(item: ReminderItem, s: ReminderSettings): Date | null {
  if (!item.window_end || !item.window_start || item.due_at) return null;
  const lastDay = addDays(civilOf(new Date(item.window_end), s.tz), -1);
  const eve = localTimeOn(addDays(lastDay, -1), s.eveningHour, s.tz);
  const start = startFireAt(item, s);
  if (!start || eve <= start) return null;
  return eve;
}

export interface DueReminder {
  itemId: string;
  kind: ReminderKind;
}

/** Everything due at `now`, ignoring quiet hours and caps (see planPush). */
export function dueReminders(items: ReminderItem[], now: Date, s: ReminderSettings): DueReminder[] {
  const out: DueReminder[] = [];
  for (const it of items) {
    if (it.status !== "open") continue;
    if (it.snoozed_until && new Date(it.snoozed_until) > now) continue;
    const st = startFireAt(it, s);
    if (st && st <= now && !it.reminded_start_at) {
      out.push({ itemId: it.id, kind: "start" });
      continue; // one reminder per item per run
    }
    const en = endFireAt(it, s);
    if (en && en <= now && !it.reminded_end_at && it.window_end && new Date(it.window_end) > now) {
      out.push({ itemId: it.id, kind: "end" });
    }
  }
  return out;
}

export interface PushPlan {
  /** Reminders to mark as sent. */
  reminders: DueReminder[];
  /** Send the morning brief push this run. */
  brief: boolean;
  /** Number of pushes this plan sends (reminders are grouped into one). */
  pushes: number;
  /** Why nothing was sent, for logs. */
  held?: "quiet_hours" | "daily_cap";
}

/**
 * Decide what to push this run. Reminders due at the same time are grouped into one push,
 * so a busy day costs one push, not ten. Quiet hours and the daily cap hold pushes back;
 * held reminders stay unsent and go out on the first run after quiet hours.
 */
export function planPush(args: {
  due: DueReminder[];
  now: Date;
  s: ReminderSettings;
  pushesSentToday: number;
  briefSentToday: boolean;
  briefHasContent: boolean;
}): PushPlan {
  const { due, now, s, pushesSentToday, briefSentToday, briefHasContent } = args;
  if (inQuietHours(now, s.tz, s.quietStart, s.quietEnd)) {
    return { reminders: [], brief: false, pushes: 0, held: due.length ? "quiet_hours" : undefined };
  }
  let budget = Math.max(0, s.dailyCap - pushesSentToday);
  const p = localParts(now, s.tz);
  const nowMin = p.hour * 60 + p.minute;
  const [bh, bm] = s.briefTime.split(":").map(Number);
  const briefDue = !briefSentToday && briefHasContent && nowMin >= bh * 60 + bm;

  let brief = false;
  let reminders: DueReminder[] = [];
  let pushes = 0;
  if (briefDue && budget > 0) {
    brief = true;
    budget--;
    pushes++;
    // The brief already lists today's items; fold due start reminders into it.
    reminders = due.slice();
  } else if (due.length && budget > 0) {
    reminders = due.slice();
    budget--;
    pushes++;
  }
  const held = pushes === 0 && (due.length > 0 || briefDue) ? "daily_cap" : undefined;
  return { reminders, brief, pushes, held };
}

/** Snooze presets the app offers. Returns the UTC instant to snooze until. */
export function snoozeUntil(preset: "1h" | "evening" | "tomorrow" | "next_week", now: Date, s: ReminderSettings): Date {
  const today = civilOf(now, s.tz);
  switch (preset) {
    case "1h":
      return new Date(now.getTime() + 3600_000);
    case "evening": {
      const eve = localTimeOn(today, s.eveningHour, s.tz);
      return eve > now ? eve : localTimeOn(addDays(today, 1), s.eveningHour, s.tz);
    }
    case "tomorrow":
      return localTimeOn(addDays(today, 1), s.startHour, s.tz);
    case "next_week": {
      // Next Monday (a week from today if today is Monday).
      const wd = weekdayOf(today);
      return localTimeOn(addDays(today, ((8 - wd) % 7) || 7), s.startHour, s.tz);
    }
  }
}
