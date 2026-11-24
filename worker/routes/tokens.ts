// Capture-only tokens for iOS Shortcuts. The Shortcut sends `Authorization: Bearer mnn_...` and a note; the token can
// add a note and nothing else. No cookie is read on this path, so the Origin check that guards cookie requests does
// not apply (Shortcuts send no Origin), and a stolen token cannot read anything back.
import type { Env } from "../env";
import { randomToken, sha256b64url, type Cipher } from "../lib/crypto";
import { HttpError, json, readJson, str } from "../lib/http";
import { getSettingsMap, reminderSettings } from "../lib/settings";
import { ulid } from "../lib/ulid";
import { Repo } from "../repo";
import { handleCapture } from "./capture";
import { buildIcs, type IcsItem } from "../core/ics";
import { civilOf, civilToIso } from "../core/time";

const PREFIX = "mnn_";
const MAX_TOKENS = 5;
const CAPTURES_PER_HOUR = 60;

export async function listTokens(repo: Repo): Promise<Response> {
  const { results } = await repo.db.prepare("SELECT id, label, scope, created_at, last_used_at FROM api_tokens ORDER BY created_at").all();
  return json({ tokens: results });
}

export async function createToken(repo: Repo, req: Request): Promise<Response> {
  const b = await readJson<{ label?: unknown; scope?: unknown }>(req);
  const scope = b.scope === "calendar" ? "calendar" : "capture";
  const label = str(b.label, "label", 60, { optional: true }).trim() || (scope === "calendar" ? "Calendar" : "Shortcut");
  const n = await repo.db.prepare("SELECT COUNT(*) AS n FROM api_tokens").first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_TOKENS) throw new HttpError(409, "too_many_tokens", `At most ${MAX_TOKENS} tokens. Revoke one first.`);
  const token = PREFIX + randomToken(32);
  const id = ulid();
  await repo.db
    .prepare("INSERT INTO api_tokens (id, label, token_hash, scope, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, label, await sha256b64url(token), scope, new Date().toISOString())
    .run();
  // The only time the token is ever returned.
  return json({ id, label, scope, token });
}

export async function deleteToken(repo: Repo, id: string): Promise<Response> {
  await repo.db.prepare("DELETE FROM api_tokens WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

/** POST /api/shortcut/capture. Answers with one line the Shortcut can show or speak. */
export async function shortcutCapture(env: Env, req: Request, cipher: Cipher): Promise<Response> {
  const auth = req.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer (mnn_[A-Za-z0-9_-]{20,80})$/);
  if (!m) throw new HttpError(401, "bad_token");
  const row = await env.DB.prepare("SELECT id, scope FROM api_tokens WHERE token_hash = ?")
    .bind(await sha256b64url(m[1]))
    .first<{ id: string; scope: string }>();
  if (!row || row.scope !== "capture") throw new HttpError(401, "bad_token");

  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'token_capture' AND item_id = ? AND at >= ?")
    .bind(row.id, hourAgo)
    .first<{ n: number }>();
  if ((used?.n ?? 0) >= CAPTURES_PER_HOUR) throw new HttpError(429, "too_many_captures", "Too many notes this hour.");
  await env.DB.batch([
    env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(now.toISOString(), row.id),
    // item_id holds the token id here: events has no token column, and this keeps the count to one indexed query.
    env.DB.prepare("INSERT INTO events (id, at, type, item_id) VALUES (?, ?, 'token_capture', ?)").bind(crypto.randomUUID(), now.toISOString(), row.id),
  ]);

  // Accept JSON {"text": "..."} or plain text (simpler to build in Shortcuts).
  const ct = req.headers.get("Content-Type") ?? "";
  let text: string;
  if (ct.startsWith("application/json")) text = str((await readJson<{ text?: unknown }>(req)).text, "text", 2000);
  else {
    const raw = await req.text();
    if (raw.length > 2000) throw new HttpError(413, "too_large");
    text = raw;
  }
  if (!text.trim()) throw new HttpError(400, "empty", "Nothing to save.");

  const rs = reminderSettings(await getSettingsMap(env.DB));
  const repo = new Repo(env, cipher, rs.tz);
  const inner = new Request(req.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, source: "shortcut" }) });
  const res = (await (await handleCapture(repo, inner, rs.tz, { captureOnly: true })).json()) as { item?: { title: string } };
  // Only the title of what was just saved comes back, never anything else Muninn holds.
  return json({ ok: true, say: res.item ? `Saved: ${res.item.title}` : "Saved." });
}

const CAL_PAST_DAYS = 30;
const CAL_AHEAD_DAYS = 400;

/**
 * GET /api/calendar/<token>.ics: open dated items for a calendar subscription. Read-only, titles only, no notes,
 * people or details. The token is in the URL (calendars can't send headers), so treat the link like a password.
 */
export async function calendarFeed(env: Env, req: Request, cipher: Cipher, token: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT id, scope FROM api_tokens WHERE token_hash = ?").bind(await sha256b64url(token)).first<{ id: string; scope: string }>();
  if (!row || row.scope !== "calendar") throw new HttpError(404, "not_found");
  const now = new Date();
  await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(now.toISOString(), row.id).run();
  const rs = reminderSettings(await getSettingsMap(env.DB));
  const { results } = await env.DB.prepare(
    `SELECT id, title_enc, due_at, window_start, window_end, updated_at FROM items
     WHERE status = 'open' AND window_start IS NOT NULL AND window_start >= ? AND window_start < ? ORDER BY window_start LIMIT 500`,
  )
    .bind(new Date(now.getTime() - CAL_PAST_DAYS * 86400_000).toISOString(), new Date(now.getTime() + CAL_AHEAD_DAYS * 86400_000).toISOString())
    .all<{ id: string; title_enc: string; due_at: string | null; window_start: string; window_end: string | null; updated_at: string }>();
  const local = (iso: string) => civilToIso(civilOf(new Date(iso), rs.tz));
  const items: IcsItem[] = [];
  for (const r of results) {
    let title: string;
    try {
      title = await cipher.decrypt(r.title_enc, `items:${r.id}:title`);
    } catch {
      continue;
    }
    items.push({
      id: r.id,
      title,
      dueAt: r.due_at,
      startDate: local(r.window_start),
      // window_end is the exclusive end instant; its local date is the exclusive end date of an all-day event.
      endDate: r.window_end ? local(r.window_end) : local(r.window_start),
      updatedAt: r.updated_at,
    });
  }
  const host = new URL(req.url).host;
  return new Response(buildIcs(items, host, now), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
