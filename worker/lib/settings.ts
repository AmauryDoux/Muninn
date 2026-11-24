import { DEFAULT_REMINDER_SETTINGS, type ReminderSettings } from "../core/reminders";

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export async function getSettingsMap(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return new Map(results.map((r) => [r.key, r.value]));
}

/** Keys the app may change from the settings screen. Auth keys are never in this list. */
export const USER_SETTING_KEYS = [
  "tz",
  "quiet_start",
  "quiet_end",
  "daily_cap",
  "brief_time",
  "start_hour",
  "evening_hour",
  "currency",
  "home_lat",
  "home_lon",
  "tips_enabled",
  "tips_ai",
  "push_titles",
  "ai_budget_usd",
] as const;

export function reminderSettings(m: Map<string, string>): ReminderSettings {
  const d = DEFAULT_REMINDER_SETTINGS;
  return {
    tz: m.get("tz") ?? "UTC",
    quietStart: m.get("quiet_start") ?? d.quietStart,
    quietEnd: m.get("quiet_end") ?? d.quietEnd,
    dailyCap: Number(m.get("daily_cap") ?? d.dailyCap),
    startHour: m.get("start_hour") ?? d.startHour,
    eveningHour: m.get("evening_hour") ?? d.eveningHour,
    briefTime: m.get("brief_time") ?? d.briefTime,
  };
}
