import { DEFAULT_REMINDER_SETTINGS } from "../core/reminders";
import { DEFAULT_AI_BUDGET_USD, monthSpend, transcribe } from "../ai";
import { summarize, type UsageRow } from "../core/costs";
import { groupItems } from "../core/group";
import type { ReminderSettings } from "../core/reminders";
import { addDays, civilOf, civilToIso, inQuietHours, isValidTimeZone, startOfLocalDay } from "../core/time";
import { HttpError, json, readJson, str } from "../lib/http";
import { USER_SETTING_KEYS, getSettingsMap, setSetting } from "../lib/settings";
import { ulid } from "../lib/ulid";
import { isAllowedPushEndpoint, sendPush } from "../lib/webpush";
import type { ItemRow, Repo } from "../repo";
import { briefText } from "../brief";
import { daySummary, type DaySummary, type EventSource } from "../calendar";
import { currentTips } from "../advice";

// ---- push ----

export async function subscribePush(repo: Repo, req: Request): Promise<Response> {
  const b = await readJson<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; device_label?: unknown }>(req);
  const endpoint = str(b.endpoint, "endpoint", 1000);
  if (!isAllowedPushEndpoint(endpoint)) throw new HttpError(400, "unsupported_push_service");
  const p256dh = str(b.keys?.p256dh, "p256dh", 200);
  const auth = str(b.keys?.auth, "auth", 100);
  const label = str(b.device_label, "device_label", 60, { optional: true }) || null;
  await repo.db
    .prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_label, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, device_label = excluded.device_label`,
    )
    .bind(ulid(), endpoint, p256dh, auth, label, new Date().toISOString())
    .run();
  return json({ ok: true });
}

export async function unsubscribePush(repo: Repo, req: Request): Promise<Response> {
  const b = await readJson<{ endpoint?: unknown }>(req);
  await repo.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(str(b.endpoint, "endpoint", 1000)).run();
  return json({ ok: true });
}

export async function listDevices(repo: Repo): Promise<Response> {
  const { results } = await repo.db.prepare("SELECT id, device_label, created_at, last_ok_at FROM push_subscriptions ORDER BY created_at").all();
  return json({ devices: results });
}

export async function deleteDevice(repo: Repo, id: string): Promise<Response> {
  await repo.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  /** Open items for today plus overdue, for the Home Screen icon badge. */
  badge?: number;
}

/**
 * Push to every device now. Payloads are end-to-end encrypted to the device (RFC 8291): Apple and Google relay them
 * but cannot read them. Item titles are included only when the user allows it (`push_titles`).
 */
export async function pushAll(repo: Repo, payload: PushPayload): Promise<number> {
  const env = repo.env;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn("VAPID keys not configured; push skipped");
    return 0;
  }
  const { results } = await repo.db
    .prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions")
    .all<{ id: string; endpoint: string; p256dh: string; auth: string }>();
  let ok = 0;
  for (const s of results) {
    try {
      const r = await sendPush(s, payload, { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT });
      if (r.ok) {
        ok++;
        await repo.db.prepare("UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?").bind(new Date().toISOString(), s.id).run();
      } else if (r.gone) {
        await repo.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(s.id).run();
      } else console.warn("push failed", r.status);
    } catch (e) {
      console.warn("push error", e instanceof Error ? e.message : e);
    }
  }
  return ok;
}

export async function testPush(repo: Repo): Promise<Response> {
  const n = await pushAll(repo, { title: "Muninn", body: "Reminders are on.", url: "/", tag: "test" });
  return json({ sent: n });
}

// ---- settings ----

export async function getSettings(repo: Repo): Promise<Response> {
  const m = await getSettingsMap(repo.db);
  const out: Record<string, string | null> = {};
  // Show the values in effect, defaults included, so the form never looks empty.
  const d = DEFAULT_REMINDER_SETTINGS;
  const defaults: Record<string, string> = {
    quiet_start: d.quietStart,
    quiet_end: d.quietEnd,
    daily_cap: String(d.dailyCap),
    brief_time: d.briefTime,
    start_hour: d.startHour,
    evening_hour: d.eveningHour,
    currency: "USD",
    tips_enabled: "1",
    tips_ai: "0",
    push_titles: "1",
    ai_budget_usd: String(DEFAULT_AI_BUDGET_USD),
    tz_follow: "0",
    holidays: "all",
  };
  for (const k of USER_SETTING_KEYS) out[k] = m.get(k) ?? defaults[k] ?? null;
  return json({ settings: out, vapid_public_key: repo.env.VAPID_PUBLIC_KEY || null, vectorize: !!repo.env.VECTORIZE });
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function putSettings(repo: Repo, req: Request): Promise<Response> {
  const b = await readJson<Record<string, unknown>>(req);
  for (const k of USER_SETTING_KEYS) {
    const v = b[k];
    if (v === undefined) continue;
    const s = str(v, k, 64);
    let val = s;
    if (k === "tz") {
      if (!isValidTimeZone(s)) throw new HttpError(400, "bad_tz");
    } else if (k === "daily_cap") {
      if (!/^(?:[0-9]|10)$/.test(s)) throw new HttpError(400, "bad_daily_cap");
    } else if (k === "currency") {
      val = s.toUpperCase();
      if (!/^[A-Z]{3}$/.test(val)) throw new HttpError(400, "bad_currency");
    } else if (k === "home_lat" || k === "home_lon") {
      // Rounded to 2 decimals (about 1 km): enough for a forecast, less precise than a home address.
      const n = Number(s);
      const lim = k === "home_lat" ? 90 : 180;
      if (s === "" || !Number.isFinite(n) || Math.abs(n) > lim) throw new HttpError(400, `bad_${k}`);
      val = n.toFixed(2);
    } else if (k === "ai_budget_usd") {
      const n = Number(s);
      if (!/^\d+(\.\d{1,2})?$/.test(s) || n < 0.1 || n > 100) throw new HttpError(400, "bad_ai_budget_usd", "Use an amount from 0.10 to 100.");
    } else if (k === "holidays") {
      if (s !== "all" && s !== "federal" && s !== "off") throw new HttpError(400, "bad_holidays");
    } else if (k === "tips_enabled" || k === "tips_ai" || k === "push_titles" || k === "tz_follow") {
      if (s !== "0" && s !== "1") throw new HttpError(400, `bad_${k}`);
    } else if (!HHMM.test(s)) throw new HttpError(400, `bad_${k}`);
    await setSetting(repo.db, k, val);
  }
  return getSettings(repo);
}

// ---- voice ----

const MAX_AUDIO = 4 * 1024 * 1024;

export async function transcribeAudio(repo: Repo, req: Request): Promise<Response> {
  const ct = req.headers.get("Content-Type") ?? "";
  if (!/^audio\/(webm|mp4|mpeg|ogg|wav|x-m4a|aac)/.test(ct)) throw new HttpError(415, "audio_required");
  const len = Number(req.headers.get("Content-Length") ?? "0");
  if (len > MAX_AUDIO) throw new HttpError(413, "too_large");
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_AUDIO) throw new HttpError(413, "too_large");
  if (!buf.byteLength) throw new HttpError(400, "empty");
  const text = await transcribe(repo.env, buf);
  return json({ text: text.slice(0, 2000) });
}

// ---- brief ----

export async function getBrief(repo: Repo, rs: ReminderSettings, events?: EventSource): Promise<Response> {
  const now = new Date();
  const today = civilOf(now, rs.tz);
  const dayStart = startOfLocalDay(today, rs.tz);
  const dayEnd = startOfLocalDay(addDays(today, 1), rs.tz);
  const { results } = await repo.db.prepare("SELECT * FROM items WHERE status = 'open' LIMIT 500").all<ItemRow>();
  const views = await repo.itemViews(results);
  const g = groupItems(views, now, dayStart, dayEnd);
  const stale = await repo.db
    .prepare("SELECT id, subject_type, subject_id, key FROM facts WHERE active = 1 AND review_after IS NOT NULL AND review_after < ? LIMIT 1")
    .bind(now.toISOString())
    .first<{ id: string; subject_type: string; subject_id: string | null; key: string }>();
  const text = await briefText(repo, civilToIso(today), g.today, g.overdue, rs.tz);
  let day: DaySummary | null = null;
  try {
    day = await daySummary(repo, now, rs.tz, events);
  } catch (e) {
    console.warn("day summary failed", e instanceof Error ? e.message : e);
  }
  let tips: Awaited<ReturnType<typeof currentTips>> = [];
  try {
    tips = await currentTips(repo, now, rs.tz);
  } catch (e) {
    console.warn("tips failed", e instanceof Error ? e.message : e);
  }
  return json({
    date: civilToIso(today),
    summary: text,
    day,
    tips,
    today: g.today,
    overdue: g.overdue,
    stale_fact: stale,
    quiet_now: inQuietHours(now, rs.tz, rs.quietStart, rs.quietEnd),
  });
}

// ---- AI usage and cost ----

/** Usage for one calendar month (UTC), with an estimated dollar cost per feature. */
export async function getUsage(repo: Repo, url: URL): Promise<Response> {
  const month = url.searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "bad_month");
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const end = new Date(Date.UTC(y, m, 1)).toISOString();
  const { results } = await repo.db
    .prepare("SELECT payload_json FROM events WHERE type = 'model_usage' AND at >= ? AND at < ?")
    .bind(start, end)
    .all<{ payload_json: string }>();
  const rows = results.map((r) => JSON.parse(r.payload_json) as UsageRow);
  // Latest AI failure and the latest success, so the phone can show whether the AI works right now.
  const lastErr = await repo.db
    .prepare("SELECT at, payload_json FROM events WHERE type = 'model_error' ORDER BY at DESC LIMIT 1")
    .first<{ at: string; payload_json: string }>();
  const lastOk = await repo.db.prepare("SELECT at FROM events WHERE type = 'model_usage' ORDER BY at DESC LIMIT 1").first<{ at: string }>();
  const err = lastErr ? (JSON.parse(lastErr.payload_json) as { job: string; status: number | null; message: string }) : null;
  return json({
    month,
    ...summarize(rows),
    last_error: err ? { at: lastErr!.at, job: err.job, status: err.status, message: err.message } : null,
    last_success_at: lastOk?.at ?? null,
  });
}

// ---- health ----

/**
 * What the phone needs to tell whether Muninn is working without `wrangler tail`: the cron's last run, push delivery,
 * AI spend against the budget, search coverage and the last backup.
 */
export async function getHealth(repo: Repo): Promise<Response> {
  const db = repo.db;
  const m = await getSettingsMap(db);
  const week = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [lastPush, pushFailed, aiErrors, devices, missingVectors] = await Promise.all([
    db.prepare("SELECT MAX(last_ok_at) AS at FROM push_subscriptions").first<{ at: string | null }>(),
    db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'push_failed' AND at >= ?").bind(week).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'model_error' AND at >= ?").bind(week).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM items i WHERE NOT EXISTS (SELECT 1 FROM capture_vectors v WHERE v.item_id = i.id)").first<{ n: number }>(),
  ]);
  return json({
    cron_last_run: m.get("cron_last_run") ?? null,
    push: {
      configured: !!(repo.env.VAPID_PUBLIC_KEY && repo.env.VAPID_PRIVATE_KEY),
      devices: devices?.n ?? 0,
      last_delivered_at: lastPush?.at ?? null,
      failed_7d: pushFailed?.n ?? 0,
    },
    ai: {
      spent_month_usd: await monthSpend(db),
      budget_usd: Number(m.get("ai_budget_usd") ?? DEFAULT_AI_BUDGET_USD),
      errors_7d: aiErrors?.n ?? 0,
    },
    search: { vectorize: !!repo.env.VECTORIZE, items_without_vector: missingVectors?.n ?? 0 },
    backup: { configured: !!repo.env.BACKUPS, last_at: m.get("backup_last") ?? null },
  });
}

// ---- export ----

export async function exportAll(repo: Repo): Promise<Response> {
  const data = await buildExport(repo);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="muninn-export-${data.exported_at.slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function buildExport(repo: Repo) {
  const c = repo.cipher;
  const db = repo.db;
  const { results: captures } = await db.prepare("SELECT * FROM captures ORDER BY created_at").all<Record<string, string | null>>();
  const { results: items } = await db.prepare("SELECT * FROM items ORDER BY created_at").all<ItemRow>();
  const { results: facts } = await db.prepare("SELECT * FROM facts ORDER BY created_at").all<Record<string, string | number | null>>();
  const { results: patterns } = await db.prepare("SELECT * FROM patterns").all();
  const { results: links } = await db.prepare("SELECT * FROM links").all();
  const { results: triggerRows } = await db.prepare("SELECT * FROM triggers").all<Record<string, string | number | null>>();
  const triggers = await Promise.all(
    triggerRows.map(async ({ payload_enc, ...t }) => ({ ...t, payload: payload_enc ? JSON.parse(await c.decrypt(String(payload_enc), `triggers:${t.id}:payload`)) : null })),
  );
  const { results: tipRows } = await db.prepare("SELECT * FROM tips").all<Record<string, string | number | null>>();
  const tips = await Promise.all(
    tipRows.map(async ({ content_enc, wording_enc, ...t }) => ({
      ...t,
      content: JSON.parse(await c.decrypt(String(content_enc), `tips:${t.id}:content`)),
      wording: wording_enc ? await c.decrypt(String(wording_enc), `tips:${t.id}:wording`) : null,
    })),
  );
  const decNamed = async (table: string, rows: Record<string, string | null>[]) =>
    Promise.all(
      rows.map(async ({ name_enc, attrs_enc, ...rest }) => ({
        ...rest,
        name: await c.decrypt(name_enc!, `${table}:${rest.id}:name`),
        attrs: attrs_enc ? JSON.parse(await c.decrypt(attrs_enc, `${table}:${rest.id}:attrs`)) : null,
      })),
    );
  const things = await decNamed("things", (await db.prepare("SELECT * FROM things").all<Record<string, string | null>>()).results);
  const places = await decNamed("places", (await db.prepare("SELECT * FROM places").all<Record<string, string | null>>()).results);
  const { results: events } = await db.prepare("SELECT id, at, type, item_id, nudge_type, payload_json FROM events ORDER BY at").all();
  const settings = await getSettingsMap(db);
  return {
    format: "muninn-export",
    version: 2,
    exported_at: new Date().toISOString(),
    settings: Object.fromEntries(USER_SETTING_KEYS.map((k) => [k, settings.get(k) ?? null])),
    people: await repo.people(),
    captures: await Promise.all(
      captures.map(async (r) => ({
        id: r.id,
        created_at: r.created_at,
        source: r.source,
        raw_text: await c.decrypt(r.raw_text_enc!, `captures:${r.id}:raw_text`),
        parse: r.parse_enc ? JSON.parse(await c.decrypt(r.parse_enc, `captures:${r.id}:parse`)) : null,
        parser_version: r.parser_version,
        model: r.model,
      })),
    ),
    items: await Promise.all(
      items.map(async (r) => {
        const { title_enc, details_enc, attrs_enc, ...rest } = r;
        return {
          ...rest,
          title: await c.decrypt(title_enc, `items:${r.id}:title`),
          details: await c.decryptNullable(details_enc, `items:${r.id}:details`),
          attrs: attrs_enc ? JSON.parse(await c.decrypt(attrs_enc, `items:${r.id}:attrs`)) : null,
        };
      }),
    ),
    facts: await Promise.all(
      facts.map(async (f) => {
        const { value_enc, ...rest } = f;
        return { ...rest, value: await c.decrypt(String(value_enc), `facts:${f.id}:value`) };
      }),
    ),
    things,
    places,
    links,
    triggers,
    tips,
    patterns,
    events,
  };
}
