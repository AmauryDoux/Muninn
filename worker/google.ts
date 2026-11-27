// Google Calendar, read-only: linking accounts (OAuth 2 with PKCE), syncing calendars and events into D1, and
// serving them to the calendar view. Pure parsing lives in core/gcal.ts.
//
// Security notes:
// - The session cookie is SameSite=Strict, so it is NOT sent when Google redirects back to /api/google/callback.
//   The callback is tied to the user by a single-use, 10-minute `state` that only a signed-in POST can create, and
//   the code is useless without the client secret and the PKCE verifier, both server-side.
// - Refresh and access tokens are encrypted at rest like every other secret field; scopes are read-only.
import type { CalEntry, EventSource } from "./calendar";
import {
  GCAL_API,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  SYNC_FUTURE_DAYS,
  SYNC_PAST_DAYS,
  authUrl,
  eventDates,
  hasCalendarScopes,
  idTokenClaims,
  isHolidayCalendar,
  parseCalendarList,
  parseEvent,
  parseTokenResponse,
  type GEvent,
} from "./core/gcal";
import { addDays, civilToIso, localParts, type CivilDate } from "./core/time";
import type { Env } from "./env";
import { toB64url, utf8 } from "./lib/b64";
import { randomToken, sha256b64url, type Cipher } from "./lib/crypto";
import { HttpError, json, readJson } from "./lib/http";
import { ulid } from "./lib/ulid";
import type { Repo } from "./repo";

const STATE_TTL_MS = 10 * 60_000;
/** A calendar is refetched by the cron when its copy is older than this. */
export const STALE_MS = 15 * 60_000;
/** The calendar list (new or renamed calendars) is refreshed this often. */
const LIST_STALE_MS = 12 * 3600_000;
/** Google fetches per cron run: the free plan allows 50 subrequests per invocation, shared with push and AI. */
export const CRON_FETCH_BUDGET = 8;
const MAX_PAGES = 4;

type GFetch = typeof fetch;

interface AccountRow {
  id: string;
  sub_mac: string;
  email_enc: string;
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_expires_at: string | null;
  status: "ok" | "revoked";
  last_error: string | null;
  created_at: string;
  calendars_synced_at: string | null;
}

interface CalendarRow {
  id: string;
  account_id: string;
  cal_mac: string;
  cal_id_enc: string;
  name_enc: string;
  color: string | null;
  enabled: number;
  events_hash: string | null;
  synced_at: string | null;
  last_error: string | null;
}

export function googleConfigured(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

const redirectUri = (origin: string) => `${origin}/api/google/callback`;
const stateKey = async (state: string) => `gstate:${(await sha256b64url(state)).slice(0, 32)}`;

/** POST /api/google/connect: a Google consent URL for the app to open. */
export async function startConnect(repo: Repo, req: Request): Promise<Response> {
  if (!googleConfigured(repo.env)) throw new HttpError(409, "google_not_configured", "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.");
  const origin = new URL(req.url).origin;
  const state = randomToken(32);
  const verifier = randomToken(48); // 64 characters: within PKCE's 43 to 128
  const challenge = toB64url(await crypto.subtle.digest("SHA-256", utf8(verifier)));
  const key = await stateKey(state);
  const value = await repo.cipher.encrypt(JSON.stringify({ v: verifier, exp: Date.now() + STATE_TTL_MS }), key);
  await repo.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
  return json({ url: authUrl({ clientId: repo.env.GOOGLE_CLIENT_ID!, redirectUri: redirectUri(origin), state, codeChallenge: challenge }) });
}

const back = (origin: string, result: string) =>
  new Response(null, { status: 303, headers: { Location: `${origin}/?view=settings&google=${encodeURIComponent(result)}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

/** GET /api/google/callback: Google sends the user back here. No session cookie arrives (SameSite=Strict). */
export async function finishConnect(env: Env, cipher: Cipher, url: URL, now = new Date(), f: GFetch = fetch): Promise<Response> {
  const origin = url.origin;
  const state = url.searchParams.get("state") ?? "";
  if (!state || state.length > 200) return back(origin, "bad_state");
  // Single use: the row is deleted as it is read, so a replayed callback finds nothing.
  const key = await stateKey(state);
  const row = await env.DB.prepare("DELETE FROM settings WHERE key = ? RETURNING value").bind(key).first<{ value: string }>();
  if (!row) return back(origin, "bad_state");
  let verifier: string;
  try {
    const s = JSON.parse(await cipher.decrypt(row.value, key)) as { v: string; exp: number };
    if (s.exp < now.getTime()) return back(origin, "expired");
    verifier = s.v;
  } catch {
    return back(origin, "bad_state");
  }
  if (url.searchParams.get("error")) return back(origin, "denied");
  const code = url.searchParams.get("code");
  if (!code || !googleConfigured(env)) return back(origin, "failed");

  const res = await f(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const tok = parseTokenResponse(await res.json().catch(() => null));
  if (!res.ok || !tok) {
    console.warn("google token exchange failed", res.status);
    return back(origin, "failed");
  }
  if (!tok.scope || !hasCalendarScopes(tok.scope)) return back(origin, "missing_scope");
  const who = tok.id_token ? idTokenClaims(tok.id_token) : null;
  if (!who || !tok.refresh_token) return back(origin, "failed");

  const subMac = await cipher.mac(`google-sub:${who.sub}`);
  const existing = await env.DB.prepare("SELECT id FROM google_accounts WHERE sub_mac = ?").bind(subMac).first<{ id: string }>();
  const id = existing?.id ?? ulid();
  const enc = (v: string, col: string) => cipher.encrypt(v, `google_accounts:${id}:${col}`);
  const expires = new Date(now.getTime() + tok.expires_in * 1000).toISOString();
  if (existing) {
    await env.DB.prepare(
      "UPDATE google_accounts SET email_enc = ?, refresh_token_enc = ?, access_token_enc = ?, access_expires_at = ?, status = 'ok', last_error = NULL, calendars_synced_at = NULL WHERE id = ?",
    )
      .bind(await enc(who.email, "email"), await enc(tok.refresh_token, "refresh_token"), await enc(tok.access_token, "access_token"), expires, id)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO google_accounts (id, sub_mac, email_enc, refresh_token_enc, access_token_enc, access_expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'ok', ?)",
    )
      .bind(id, subMac, await enc(who.email, "email"), await enc(tok.refresh_token, "refresh_token"), await enc(tok.access_token, "access_token"), expires, now.toISOString())
      .run();
  }
  // Fetch the calendars and a first batch of events now, so the calendar is filled when the app opens.
  try {
    await syncGoogle(env, cipher, now, { force: true, budget: CRON_FETCH_BUDGET, accountId: id }, f);
  } catch (e) {
    console.warn("first google sync failed", e instanceof Error ? e.message : e);
  }
  return back(origin, "linked");
}

class Revoked extends Error {}

async function accessToken(env: Env, cipher: Cipher, a: AccountRow, now: Date, f: GFetch): Promise<string> {
  const aadOf = (col: string) => `google_accounts:${a.id}:${col}`;
  if (a.access_token_enc && a.access_expires_at && Date.parse(a.access_expires_at) > now.getTime() + 60_000) {
    return cipher.decrypt(a.access_token_enc, aadOf("access_token"));
  }
  const res = await f(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: await cipher.decrypt(a.refresh_token_enc, aadOf("refresh_token")),
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 400 && body?.error === "invalid_grant") {
    // Revoked in the Google account, password changed, or (in Testing mode) the 7-day limit: the user must relink.
    await env.DB.prepare("UPDATE google_accounts SET status = 'revoked', last_error = 'Access was revoked or expired. Link the account again.', access_token_enc = NULL WHERE id = ?").bind(a.id).run();
    throw new Revoked();
  }
  const tok = parseTokenResponse(body);
  if (!res.ok || !tok) throw new Error(`token refresh failed: ${res.status}`);
  await env.DB.prepare("UPDATE google_accounts SET access_token_enc = ?, access_expires_at = ?, last_error = NULL WHERE id = ?")
    .bind(await cipher.encrypt(tok.access_token, aadOf("access_token")), new Date(now.getTime() + tok.expires_in * 1000).toISOString(), a.id)
    .run();
  return tok.access_token;
}

async function gget(f: GFetch, token: string, url: string): Promise<unknown> {
  const res = await f(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`google ${res.status}`);
  return res.json();
}

async function syncCalendarList(env: Env, cipher: Cipher, a: AccountRow, token: string, now: Date, f: GFetch): Promise<void> {
  const list = parseCalendarList(await gget(f, token, `${GCAL_API}/users/me/calendarList?minAccessRole=reader&maxResults=250`));
  const { results: rows } = await env.DB.prepare("SELECT * FROM google_calendars WHERE account_id = ?").bind(a.id).all<CalendarRow>();
  const byMac = new Map(rows.map((r) => [r.cal_mac, r]));
  const seen = new Set<string>();
  const stmts: D1PreparedStatement[] = [];
  for (const c of list) {
    const mac = await cipher.mac(`google-cal:${a.id}:${c.id}`);
    seen.add(mac);
    const row = byMac.get(mac);
    const id = row?.id ?? ulid();
    const name = await cipher.encrypt(c.summary, `google_calendars:${id}:name`);
    if (row) stmts.push(env.DB.prepare("UPDATE google_calendars SET name_enc = ?, color = ? WHERE id = ?").bind(name, c.backgroundColor, id));
    else
      stmts.push(
        env.DB.prepare("INSERT INTO google_calendars (id, account_id, cal_mac, cal_id_enc, name_enc, color, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
          id,
          a.id,
          mac,
          await cipher.encrypt(c.id, `google_calendars:${id}:cal_id`),
          name,
          c.backgroundColor,
          isHolidayCalendar(c.id) ? 0 : 1,
        ),
      );
  }
  // Calendars you unsubscribed from in Google disappear here too, with their events.
  for (const r of rows) {
    if (seen.has(r.cal_mac)) continue;
    stmts.push(env.DB.prepare("DELETE FROM calendar_events WHERE calendar_id = ?").bind(r.id), env.DB.prepare("DELETE FROM google_calendars WHERE id = ?").bind(r.id));
  }
  stmts.push(env.DB.prepare("UPDATE google_accounts SET calendars_synced_at = ? WHERE id = ?").bind(now.toISOString(), a.id));
  await env.DB.batch(stmts);
}

/** Fetch one calendar's events in the sync window and write only what changed. Returns the number of fetches. */
async function syncCalendarEvents(env: Env, cipher: Cipher, c: CalendarRow, token: string, now: Date, f: GFetch): Promise<number> {
  const calId = await cipher.decrypt(c.cal_id_enc, `google_calendars:${c.id}:cal_id`);
  const q = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: new Date(now.getTime() - SYNC_PAST_DAYS * 86_400_000).toISOString(),
    timeMax: new Date(now.getTime() + SYNC_FUTURE_DAYS * 86_400_000).toISOString(),
    maxResults: "2500",
    fields: "nextPageToken,items(id,etag,status,summary,location,start,end,attendees(self,responseStatus))",
  });
  const events: GEvent[] = [];
  let page: string | undefined;
  let fetches = 0;
  do {
    if (page) q.set("pageToken", page);
    const body = (await gget(f, token, `${GCAL_API}/calendars/${encodeURIComponent(calId)}/events?${q}`)) as { items?: unknown[]; nextPageToken?: string };
    fetches++;
    for (const raw of body.items ?? []) {
      const e = parseEvent(raw);
      if (e) events.push(e);
    }
    page = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
  } while (page && fetches < MAX_PAGES);

  const hash = await sha256b64url(events.map((e) => `${e.gid}:${e.etag}`).sort().join("|"));
  if (hash === c.events_hash) {
    await env.DB.prepare("UPDATE google_calendars SET synced_at = ?, last_error = NULL WHERE id = ?").bind(now.toISOString(), c.id).run();
    return fetches;
  }
  const { results: have } = await env.DB.prepare("SELECT id, etag FROM calendar_events WHERE calendar_id = ?").bind(c.id).all<{ id: string; etag: string }>();
  const old = new Map(have.map((r) => [r.id, r.etag]));
  const keep = new Set<string>();
  const stmts: D1PreparedStatement[] = [];
  for (const e of events) {
    const id = (await sha256b64url(`${c.id}:${e.gid}`)).slice(0, 32);
    if (keep.has(id)) continue;
    keep.add(id);
    if (old.get(id) === e.etag) continue;
    const title = await cipher.encrypt(e.title, `calendar_events:${id}:title`);
    const loc = await cipher.encryptNullable(e.location, `calendar_events:${id}:location`);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO calendar_events (id, calendar_id, etag, all_day, start_at, end_at, title_enc, location_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET etag = excluded.etag, all_day = excluded.all_day, start_at = excluded.start_at, end_at = excluded.end_at,
         title_enc = excluded.title_enc, location_enc = excluded.location_enc`,
      ).bind(id, c.id, e.etag, e.allDay ? 1 : 0, e.start, e.end, title, loc),
    );
  }
  for (const id of old.keys()) if (!keep.has(id)) stmts.push(env.DB.prepare("DELETE FROM calendar_events WHERE id = ?").bind(id));
  stmts.push(env.DB.prepare("UPDATE google_calendars SET events_hash = ?, synced_at = ?, last_error = NULL WHERE id = ?").bind(hash, now.toISOString(), c.id));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return fetches;
}

/**
 * Refresh what is stale, oldest first, within a budget of Google fetches. The cron calls it every 5 minutes; "Sync
 * now" and a new link call it with `force`. One failing calendar or account never stops the others.
 */
export async function syncGoogle(
  env: Env,
  cipher: Cipher,
  now: Date,
  o: { force?: boolean; budget?: number; accountId?: string } = {},
  f: GFetch = fetch,
): Promise<{ fetched: number; errors: number }> {
  if (!googleConfigured(env)) return { fetched: 0, errors: 0 };
  let budget = o.budget ?? CRON_FETCH_BUDGET;
  let fetched = 0;
  let errors = 0;
  const { results: accounts } = await env.DB.prepare(`SELECT * FROM google_accounts WHERE status = 'ok'${o.accountId ? " AND id = ?" : ""}`)
    .bind(...(o.accountId ? [o.accountId] : []))
    .all<AccountRow>();
  const staleBefore = new Date(now.getTime() - (o.force ? 0 : STALE_MS)).toISOString();
  for (const a of accounts) {
    if (budget <= 0) break;
    try {
      const token = await accessToken(env, cipher, a, now, f);
      if (o.force || !a.calendars_synced_at || Date.parse(a.calendars_synced_at) < now.getTime() - LIST_STALE_MS) {
        await syncCalendarList(env, cipher, a, token, now, f);
        budget--;
        fetched++;
      }
      const { results: cals } = await env.DB.prepare(
        "SELECT * FROM google_calendars WHERE account_id = ? AND enabled = 1 AND (synced_at IS NULL OR synced_at <= ?) ORDER BY synced_at IS NOT NULL, synced_at",
      )
        .bind(a.id, staleBefore)
        .all<CalendarRow>();
      for (const c of cals) {
        if (budget <= 0) break;
        try {
          const n = await syncCalendarEvents(env, cipher, c, token, now, f);
          budget -= n;
          fetched += n;
        } catch (e) {
          errors++;
          budget--;
          const msg = e instanceof Error ? e.message.slice(0, 200) : "sync failed";
          await env.DB.prepare("UPDATE google_calendars SET last_error = ?, synced_at = ? WHERE id = ?").bind(msg, now.toISOString(), c.id).run();
        }
      }
    } catch (e) {
      errors++;
      if (!(e instanceof Revoked)) {
        const msg = e instanceof Error ? e.message.slice(0, 200) : "sync failed";
        await env.DB.prepare("UPDATE google_accounts SET last_error = ? WHERE id = ?").bind(msg, a.id).run();
      }
    }
  }
  return { fetched, errors };
}

/** Events from enabled calendars, for the calendar view and the daily summary. */
export function googleEvents(repo: Repo): EventSource {
  return async (from: CivilDate, to: CivilDate, tz: string): Promise<CalEntry[]> => {
    const a = civilToIso(from);
    const b = civilToIso(to);
    // Loose bounds on the stored strings (dates and UTC instants mixed); eventDates() decides exactly.
    const lo = civilToIso(addDays(from, -32));
    const hi = civilToIso(addDays(to, 2));
    const { results } = await repo.db
      .prepare(
        `SELECT e.*, c.name_enc, c.color FROM calendar_events e JOIN google_calendars c ON c.id = e.calendar_id
         JOIN google_accounts g ON g.id = c.account_id
         WHERE c.enabled = 1 AND e.start_at < ? AND e.end_at >= ? LIMIT 2000`,
      )
      .bind(hi, lo)
      .all<{ id: string; calendar_id: string; all_day: number; start_at: string; end_at: string; title_enc: string; location_enc: string | null; name_enc: string; color: string | null }>();
    const names = new Map<string, string>();
    const local = (iso: string) => {
      const p = localParts(new Date(iso), tz);
      return civilToIso(p);
    };
    const out: CalEntry[] = [];
    for (const r of results) {
      const days = eventDates({ allDay: r.all_day === 1, start: r.start_at, end: r.end_at }, a, b, local);
      if (!days.length) continue;
      let name = names.get(r.calendar_id);
      if (name === undefined) {
        name = await repo.cipher.decrypt(r.name_enc, `google_calendars:${r.calendar_id}:name`).catch(() => "Google");
        names.set(r.calendar_id, name);
      }
      let title: string;
      let location: string | null;
      try {
        title = await repo.cipher.decrypt(r.title_enc, `calendar_events:${r.id}:title`);
        location = await repo.cipher.decryptNullable(r.location_enc, `calendar_events:${r.id}:location`);
      } catch {
        continue;
      }
      for (const date of days) {
        out.push({
          kind: "event",
          date,
          title,
          id: r.id,
          at: r.all_day ? null : r.start_at,
          end: r.all_day ? null : r.end_at,
          all_day: r.all_day === 1,
          calendar: name,
          color: r.color,
          location,
        });
      }
    }
    return out;
  };
}

/** GET /api/google: linked accounts and their calendars, for Settings. */
export async function listGoogle(repo: Repo): Promise<Response> {
  const { results: accounts } = await repo.db.prepare("SELECT * FROM google_accounts ORDER BY created_at").all<AccountRow>();
  const { results: cals } = await repo.db.prepare("SELECT * FROM google_calendars").all<CalendarRow>();
  const counts = new Map(
    (await repo.db.prepare("SELECT calendar_id, COUNT(*) AS n FROM calendar_events GROUP BY calendar_id").all<{ calendar_id: string; n: number }>()).results.map((r) => [r.calendar_id, r.n]),
  );
  const out = [];
  for (const a of accounts) {
    const mine = cals.filter((c) => c.account_id === a.id);
    const calendars = [];
    for (const c of mine) {
      calendars.push({
        id: c.id,
        name: await repo.cipher.decrypt(c.name_enc, `google_calendars:${c.id}:name`).catch(() => "Calendar"),
        color: c.color,
        enabled: c.enabled === 1,
        synced_at: c.synced_at,
        events: counts.get(c.id) ?? 0,
        error: c.last_error,
      });
    }
    calendars.sort((x, y) => x.name.localeCompare(y.name));
    out.push({
      id: a.id,
      email: await repo.cipher.decrypt(a.email_enc, `google_accounts:${a.id}:email`).catch(() => "Google account"),
      status: a.status,
      error: a.last_error,
      calendars,
    });
  }
  return json({ configured: googleConfigured(repo.env), redirect_uri_path: "/api/google/callback", accounts: out });
}

/** PATCH /api/google/calendars/:id {enabled}. Switching one off drops its cached events. */
export async function patchGoogleCalendar(repo: Repo, req: Request, id: string): Promise<Response> {
  const b = await readJson<{ enabled?: unknown }>(req);
  if (typeof b.enabled !== "boolean") throw new HttpError(400, "bad_request");
  const row = await repo.db.prepare("SELECT id FROM google_calendars WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "not_found");
  if (b.enabled) await repo.db.prepare("UPDATE google_calendars SET enabled = 1, events_hash = NULL, synced_at = NULL WHERE id = ?").bind(id).run();
  else
    await repo.db.batch([
      repo.db.prepare("DELETE FROM calendar_events WHERE calendar_id = ?").bind(id),
      repo.db.prepare("UPDATE google_calendars SET enabled = 0, events_hash = NULL, synced_at = NULL WHERE id = ?").bind(id),
    ]);
  return listGoogle(repo);
}

/** POST /api/google/sync: refresh everything now (within the fetch budget). */
export async function syncGoogleNow(repo: Repo, now = new Date(), f: GFetch = fetch): Promise<Response> {
  const r = await syncGoogle(repo.env, repo.cipher, now, { force: true, budget: 20 }, f);
  return json(r);
}

/** DELETE /api/google/accounts/:id: revoke at Google (best effort) and forget everything from that account. */
export async function unlinkGoogle(repo: Repo, id: string, f: GFetch = fetch): Promise<Response> {
  const a = await repo.db.prepare("SELECT * FROM google_accounts WHERE id = ?").bind(id).first<AccountRow>();
  if (!a) throw new HttpError(404, "not_found");
  try {
    const token = await repo.cipher.decrypt(a.refresh_token_enc, `google_accounts:${a.id}:refresh_token`);
    await f(GOOGLE_REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
  } catch (e) {
    console.warn("google revoke failed", e instanceof Error ? e.message : e);
  }
  await repo.db.batch([
    repo.db.prepare("DELETE FROM calendar_events WHERE calendar_id IN (SELECT id FROM google_calendars WHERE account_id = ?)").bind(id),
    repo.db.prepare("DELETE FROM google_calendars WHERE account_id = ?").bind(id),
    repo.db.prepare("DELETE FROM google_accounts WHERE id = ?").bind(id),
  ]);
  return listGoogle(repo);
}

/** Expired OAuth states (abandoned consent screens). Called from housekeeping. */
export async function purgeGoogleStates(db: D1Database, cipher: Cipher, now: Date): Promise<void> {
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'gstate:%'").all<{ key: string; value: string }>();
  for (const r of results) {
    let exp = 0;
    try {
      exp = (JSON.parse(await cipher.decrypt(r.value, r.key)) as { exp: number }).exp;
    } catch {
      /* unreadable: drop */
    }
    if (exp < now.getTime()) await db.prepare("DELETE FROM settings WHERE key = ?").bind(r.key).run();
  }
}
