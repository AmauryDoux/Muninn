// The one cron (every 5 minutes): reminders, morning brief, housekeeping, weekly backup.
import type { Env } from "./env";
import { groupItems } from "./core/group";
import { dueReminders, planPush, type ReminderItem } from "./core/reminders";
import { addDays, civilOf, localParts, startOfLocalDay } from "./core/time";
import { Cipher } from "./lib/crypto";
import { getSettingsMap, reminderSettings } from "./lib/settings";
import { utf8 } from "./lib/b64";
import { Repo } from "./repo";
import { buildExport, pushAll } from "./routes/misc";

export async function runScheduled(env: Env, now = new Date()): Promise<void> {
  const settings = await getSettingsMap(env.DB);
  if (settings.get("setup_done") !== "1") return;
  const rs = reminderSettings(settings);
  const repo = new Repo(env, await Cipher.fromSecret(env.DATA_KEY));

  await reminders(repo, rs, now);

  const p = localParts(now, rs.tz);
  if (p.minute < 5) await housekeeping(env, now);
  if (env.BACKUPS && p.weekday === 0 && p.hour === 3 && p.minute < 5) await backup(repo, now);
}

async function reminders(repo: Repo, rs: ReturnType<typeof reminderSettings>, now: Date) {
  const db = repo.db;
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

  let payload;
  if (plan.brief) {
    const parts = [`${g.today.length} for today`];
    if (g.overdue.length) parts.push(`${g.overdue.length} overdue`);
    payload = { title: "Morning brief", body: parts.join(", "), url: "/?view=brief", tag: "brief" };
  } else {
    const n = plan.reminders.length;
    const ending = plan.reminders.every((r) => r.kind === "end");
    payload = {
      title: "Muninn",
      body: ending ? `${n} item${n > 1 ? "s" : ""} ending soon` : `Reminder: ${n} item${n > 1 ? "s" : ""} due`,
      url: "/?view=today",
      tag: "reminder",
    };
  }
  const delivered = await pushAll(repo, payload);
  const iso = now.toISOString();
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
    db.prepare("DELETE FROM settings WHERE key LIKE 'brief:%' AND key < ?").bind(`brief:${new Date(now.getTime() - 3 * 86400_000).toISOString().slice(0, 10)}`),
    ...expired.map((r) => db.prepare("DELETE FROM settings WHERE key = ?").bind(r.key)),
  ]);
}

/** Weekly encrypted export to R2, kept 8 weeks. Same format as the in-app export, sealed with DATA_KEY. */
async function backup(repo: Repo, now: Date) {
  const bucket = repo.env.BACKUPS!;
  const name = `backup-${now.toISOString().slice(0, 10)}.json.enc`;
  if (await bucket.head(name)) return;
  const data = utf8(JSON.stringify(await buildExport(repo)));
  await bucket.put(name, await repo.cipher.sealBytes(data, name));
  const list = await bucket.list({ prefix: "backup-" });
  const old = list.objects.map((o) => o.key).sort().slice(0, -8);
  if (old.length) await bucket.delete(old);
}
