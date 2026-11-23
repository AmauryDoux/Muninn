import { transcribe } from "../ai";
import { groupItems } from "../core/group";
import type { ReminderSettings } from "../core/reminders";
import { addDays, civilOf, civilToIso, inQuietHours, isValidTimeZone, startOfLocalDay } from "../core/time";
import { HttpError, json, readJson, str } from "../lib/http";
import { USER_SETTING_KEYS, getSettingsMap, setSetting } from "../lib/settings";
import { ulid } from "../lib/ulid";
import { isAllowedPushEndpoint, sendPush } from "../lib/webpush";
import type { ItemRow, Repo } from "../repo";
import { briefText } from "../brief";

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

/** Push to every device now. Payloads never carry item text (Apple and Google can see them). */
export async function pushAll(repo: Repo, payload: { title: string; body: string; url: string; tag: string }): Promise<number> {
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
  for (const k of USER_SETTING_KEYS) out[k] = m.get(k) ?? null;
  return json({ settings: out, vapid_public_key: repo.env.VAPID_PUBLIC_KEY || null, vectorize: !!repo.env.VECTORIZE });
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function putSettings(repo: Repo, req: Request): Promise<Response> {
  const b = await readJson<Record<string, unknown>>(req);
  for (const k of USER_SETTING_KEYS) {
    const v = b[k];
    if (v === undefined) continue;
    const s = str(v, k, 64);
    if (k === "tz" && !isValidTimeZone(s)) throw new HttpError(400, "bad_tz");
    if (k === "daily_cap" && !/^(?:[0-9]|10)$/.test(s)) throw new HttpError(400, "bad_daily_cap");
    if (k !== "tz" && k !== "daily_cap" && !HHMM.test(s)) throw new HttpError(400, `bad_${k}`);
    await setSetting(repo.db, k, s);
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

export async function getBrief(repo: Repo, rs: ReminderSettings): Promise<Response> {
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
  const text = await briefText(repo, civilToIso(today), g.today, g.overdue);
  return json({
    date: civilToIso(today),
    summary: text,
    today: g.today,
    overdue: g.overdue,
    stale_fact: stale,
    quiet_now: inQuietHours(now, rs.tz, rs.quietStart, rs.quietEnd),
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
  const { results: events } = await db.prepare("SELECT id, at, type, item_id, nudge_type, payload_json FROM events ORDER BY at").all();
  const settings = await getSettingsMap(db);
  return {
    format: "muninn-export",
    version: 1,
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
        const { title_enc, details_enc, ...rest } = r;
        return {
          ...rest,
          title: await c.decrypt(title_enc, `items:${r.id}:title`),
          details: await c.decryptNullable(details_enc, `items:${r.id}:details`),
        };
      }),
    ),
    facts: await Promise.all(
      facts.map(async (f) => {
        const { value_enc, ...rest } = f;
        return { ...rest, value: await c.decrypt(String(value_enc), `facts:${f.id}:value`) };
      }),
    ),
    patterns,
    events,
  };
}
