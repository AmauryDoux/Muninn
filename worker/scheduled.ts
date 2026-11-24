// The one cron (every 5 minutes): reminders, morning brief, housekeeping, weekly backup.
import type { Env } from "./env";
import { groupItems } from "./core/group";
import { dueReminders, planPush, type ReminderItem } from "./core/reminders";
import { addDays, civilOf, localParts, startOfLocalDay } from "./core/time";
import { Cipher } from "./lib/crypto";
import { getSettingsMap, reminderSettings } from "./lib/settings";
import { utf8 } from "./lib/b64";
import { Repo } from "./repo";
import { pushAll } from "./routes/misc";
import { buildSnapshot } from "./core/snapshot";
import { maintainVectors } from "./vectors";
import { embed } from "./ai";
import { refreshPatterns, refreshTips, refreshWeather } from "./advice";
import { fireTriggers } from "./engine";
import { inQuietHours } from "./core/time";
import { briefNotice, reminderNotice } from "./core/notify";
import { getSetting, setSetting } from "./lib/settings";

export async function runScheduled(env: Env, now = new Date()): Promise<void> {
  const settings = await getSettingsMap(env.DB);
  if (settings.get("setup_done") !== "1") return;
  const rs = reminderSettings(settings);
  const repo = new Repo(env, await Cipher.fromSecret(env.DATA_KEY), rs.tz);
  const p = localParts(now, rs.tz);
  // Each job is isolated: one failing must not stop reminders.
  const job = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      console.error(`${name} failed`, e instanceof Error ? e.stack : e);
    }
  };

  // Triggers first, so a task they create is reminded in this same run.
  await job("triggers", () => fireTriggers(repo, now, rs.tz));
  await job("reminders", () => reminders(repo, rs, now));

  const at = (h: number) => p.hour === h && p.minute < 5;
  if (at(3)) await job("patterns", () => refreshPatterns(repo, now, rs.tz));
  if (at(5)) await job("weather", () => refreshWeather(repo));
  if (at(6)) await job("tips", () => refreshTips(repo, now, rs.tz, true));
  if (p.weekday === 0 && at(18)) await job("digest", () => ideasDigestPush(repo, rs, now));
  if (p.minute < 5) await housekeeping(env, now);
  if (env.BACKUPS && p.weekday === 0 && p.hour === 3 && p.minute < 5) await job("backup", () => backup(repo, now));
  await job("vectors", () => maintainVectors(env, repo.cipher, (t) => embed(env, t)));
  // Heartbeat for the health view: a cron that stopped is otherwise invisible until a reminder is missed.
  await job("heartbeat", () => setSetting(env.DB, "cron_last_run", now.toISOString()));
}

async function reminders(repo: Repo, rs: ReturnType<typeof reminderSettings>, now: Date) {
  const db = repo.db;
  // No push set up yet (no VAPID keys or no device): nothing can be delivered, so mark nothing as reminded.
  // Otherwise every reminder would count as sent and be lost once push is turned on.
  if (!repo.env.VAPID_PUBLIC_KEY || !repo.env.VAPID_PRIVATE_KEY) return;
  if (!(await db.prepare("SELECT 1 FROM push_subscriptions LIMIT 1").first())) return;
  // No decryption needed: the cron only looks at times and ids.
  const { results } = await db
    .prepare(
      `SELECT id, status, window_start, window_end, due_at, snoozed_until, reminded_start_at, reminded_end_at
       FROM items WHERE status = 'open' AND (window_start IS NOT NULL OR snoozed_until IS NOT NULL) LIMIT 1000`,
    )
    .all<ReminderItem>();
  const today = civilOf(now, rs.tz);
  const dayStart = startOfLocalDay(today, rs.tz);
  const dayEnd = startOfLocalDay(addDays(today, 1), rs.tz);
  const sent = await db
    .prepare("SELECT nudge_type FROM events WHERE type = 'push_sent' AND at >= ?")
    .bind(dayStart.toISOString())
    .all<{ nudge_type: string }>();
  const g = groupItems(results, now, dayStart, dayEnd);
  const due = dueReminders(results, now, rs);
  const plan = planPush({
    due,
    now,
    s: rs,
    pushesSentToday: sent.results.length,
    briefSentToday: sent.results.some((r) => r.nudge_type === "brief"),
    briefHasContent: g.today.length + g.overdue.length > 0,
  });
  if (!plan.pushes) {
    if (plan.held) console.log("push held", plan.held, due.length);
    return;
  }

  // Titles are decrypted only for the push itself, and only when the user allows them.
  const showTitles = (await getSetting(db, "push_titles")) !== "0";
  const titlesOf = async (ids: string[]): Promise<string[] | null> => {
    if (!showTitles || !ids.length) return null;
    try {
      const rows = (await Promise.all(ids.slice(0, 10).map((id) => repo.getItemRow(id)))).filter((r) => r !== null);
      return (await repo.itemViews(rows)).map((v) => v.title);
    } catch (e) {
      // A title that won't decrypt must not stop the reminder: fall back to counts.
      console.warn("push titles unavailable", e instanceof Error ? e.message : e);
      return null;
    }
  };
  const badge = g.today.length + g.overdue.length;
  const payload = plan.brief
    ? briefNotice({ today: g.today.length, overdue: g.overdue.length, titles: await titlesOf([...g.overdue, ...g.today].map((i) => i.id)) })
    : reminderNotice({
        ids: [...new Set(plan.reminders.map((r) => r.itemId))],
        titles: await titlesOf([...new Set(plan.reminders.map((r) => r.itemId))]),
        ending: plan.reminders.every((r) => r.kind === "end"),
        badge,
      });
  const delivered = await pushAll(repo, payload);
  const iso = now.toISOString();
  if (delivered === 0) {
    // Nothing reached a device: leave the reminders unmarked so the next run tries again, and record the failure
    // (it does not count toward the daily cap).
    console.warn("push not delivered; will retry", plan.reminders.length);
    await recordPushFailure(db, iso, plan.brief ? "brief" : "reminder");
    return;
  }
  const stmts = plan.reminders.map((r) =>
    db.prepare(`UPDATE items SET ${r.kind === "start" ? "reminded_start_at" : "reminded_end_at"} = ? WHERE id = ?`).bind(iso, r.itemId),
  );
  await db.batch([
    ...stmts,
    db
      .prepare("INSERT INTO events (id, at, type, nudge_type, payload_json) VALUES (?, ?, 'push_sent', ?, ?)")
      .bind(crypto.randomUUID(), iso, plan.brief ? "brief" : "reminder", JSON.stringify({ items: plan.reminders.length, devices: delivered })),
  ]);
}

async function housekeeping(env: Env, now: Date) {
  const db = env.DB;
  const iso = now.toISOString();
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'challenge:%'").all<{ key: string; value: string }>();
  const expired = results.filter((r) => {
    try {
      return (JSON.parse(r.value) as { exp: number }).exp < now.getTime();
    } catch {
      return true;
    }
  });
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(iso),
    db.prepare("DELETE FROM auth_attempts WHERE at < ?").bind(new Date(now.getTime() - 86400_000).toISOString()),
    db.prepare("DELETE FROM events WHERE type = 'push_failed' AND at < ?").bind(new Date(now.getTime() - 30 * 86400_000).toISOString()),
    db.prepare("DELETE FROM settings WHERE key LIKE 'brief:%' AND key < ?").bind(`brief:${new Date(now.getTime() - 3 * 86400_000).toISOString().slice(0, 10)}`),
    ...expired.map((r) => db.prepare("DELETE FROM settings WHERE key = ?").bind(r.key)),
  ]);
}

/**
 * Weekly backup to R2, kept 8 weeks: a raw snapshot of the tables (see core/snapshot.ts), sealed with DATA_KEY and
 * the object name. Restore with scripts/restore.mjs. Raw rows need no decryption here, so it stays cheap on CPU.
 */
async function backup(repo: Repo, now: Date) {
  const bucket = repo.env.BACKUPS!;
  const name = `backup-${now.toISOString().slice(0, 10)}.json.enc`;
  if (await bucket.head(name)) return;
  const data = utf8(JSON.stringify(await buildSnapshot(repo.db, now)));
  await bucket.put(name, await repo.cipher.sealBytes(data, name));
  await setSetting(repo.db, "backup_last", now.toISOString());
  const list = await bucket.list({ prefix: "backup-" });
  const old = list.objects.map((o) => o.key).sort().slice(0, -8);
  if (old.length) await bucket.delete(old);
}

/** Sunday evening: one push if ideas were captured this week. Counts toward the daily cap like any push. */
async function ideasDigestPush(repo: Repo, rs: ReturnType<typeof reminderSettings>, now: Date) {
  const db = repo.db;
  const week = await db
    .prepare("SELECT COUNT(*) AS n FROM items WHERE subtype = 'idea' AND created_at >= ?")
    .bind(new Date(now.getTime() - 7 * 86400_000).toISOString())
    .first<{ n: number }>();
  if (!week?.n || inQuietHours(now, rs.tz, rs.quietStart, rs.quietEnd)) return;
  const dayStart = startOfLocalDay(civilOf(now, rs.tz), rs.tz).toISOString();
  const sent = await db.prepare("SELECT nudge_type FROM events WHERE type = 'push_sent' AND at >= ?").bind(dayStart).all<{ nudge_type: string }>();
  if (sent.results.some((r) => r.nudge_type === "digest") || sent.results.length >= rs.dailyCap) return;
  const delivered = await pushAll(repo, { title: "Your week", body: `${week.n} new idea${week.n > 1 ? "s" : ""} to look over`, url: "/?view=digest", tag: "digest" });
  if (delivered === 0) return recordPushFailure(db, now.toISOString(), "digest");
  await db
    .prepare("INSERT INTO events (id, at, type, nudge_type, payload_json) VALUES (?, ?, 'push_sent', 'digest', ?)")
    .bind(crypto.randomUUID(), now.toISOString(), JSON.stringify({ items: week.n, devices: delivered }))
    .run();
}

/** A push that reached no device. Kept as an event (not `push_sent`) so the health view can show it. */
async function recordPushFailure(db: D1Database, iso: string, nudge: string): Promise<void> {
  await db
    .prepare("INSERT INTO events (id, at, type, nudge_type, payload_json) VALUES (?, ?, 'push_failed', ?, '{}')")
    .bind(crypto.randomUUID(), iso, nudge)
    .run();
}
