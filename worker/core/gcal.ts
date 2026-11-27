// Google Calendar: OAuth URLs, response parsing and event placement. Pure: the I/O is in worker/google.ts.

/**
 * Read-only and as narrow as Google allows: the calendar list and events, nothing else (no ACLs, no settings,
 * no write). `openid email` only to name the account in Settings and to recognise it when it is linked again.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GCAL_API = "https://www.googleapis.com/calendar/v3";

/** Days of events kept: a month back (for "what did I do") and six months ahead. */
export const SYNC_PAST_DAYS = 31;
export const SYNC_FUTURE_DAYS = 183;

export function authUrl(o: { clientId: string; redirectUri: string; state: string; codeChallenge: string; loginHint?: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    // offline + consent: Google returns a refresh token every time, also when the account was linked before.
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "false",
    state: o.state,
    code_challenge: o.codeChallenge,
    code_challenge_method: "S256",
  });
  if (o.loginHint) q.set("login_hint", o.loginHint);
  return `${GOOGLE_AUTH_URL}?${q}`;
}

/**
 * The id_token's claims. Its signature is not checked: it comes straight from Google's token endpoint over TLS in
 * exchange for our client secret, which OpenID Connect Core 3.1.3.7 allows. Never use this on a token from a client.
 */
export function idTokenClaims(jwt: string): { sub: string; email: string } | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))) as Record<string, unknown>;
    if (typeof json.sub !== "string" || !json.sub) return null;
    return { sub: json.sub, email: typeof json.email === "string" ? json.email : "Google account" };
  } catch {
    return null;
  }
}

/** Every granted scope we need is present (the consent screen lets people untick boxes). */
export function hasCalendarScopes(granted: string): boolean {
  const g = new Set(granted.split(/\s+/));
  return GOOGLE_SCOPES.filter((s) => s.startsWith("https://")).every((s) => g.has(s));
}

/** Google's public holiday calendars duplicate Muninn's own holidays, so they start switched off. */
export function isHolidayCalendar(calId: string): boolean {
  return calId.endsWith("#holiday@group.v.calendar.google.com");
}

export interface GCalListEntry {
  id: string;
  summary: string;
  backgroundColor: string | null;
  primary: boolean;
}

export function parseCalendarList(body: unknown): GCalListEntry[] {
  const items = (body as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  const out: GCalListEntry[] = [];
  for (const raw of items) {
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "string" || c.deleted === true) continue;
    const name = typeof c.summaryOverride === "string" ? c.summaryOverride : typeof c.summary === "string" ? c.summary : c.id;
    const color = typeof c.backgroundColor === "string" && /^#[0-9a-fA-F]{6}$/.test(c.backgroundColor) ? c.backgroundColor : null;
    out.push({ id: c.id, summary: String(name).slice(0, 200), backgroundColor: color, primary: c.primary === true });
  }
  return out;
}

export interface GEvent {
  /** Google's event id (instance id for a recurring event's occurrence). */
  gid: string;
  etag: string;
  allDay: boolean;
  /** Timed: UTC ISO instants. All-day: YYYY-MM-DD, end exclusive. */
  start: string;
  end: string;
  title: string;
  location: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One event from events.list (singleEvents=true). Null for cancelled events, ones you declined, and junk. */
export function parseEvent(raw: unknown): GEvent | null {
  const e = raw as Record<string, unknown>;
  if (!e || typeof e.id !== "string" || e.status === "cancelled") return null;
  const attendees = Array.isArray(e.attendees) ? (e.attendees as Record<string, unknown>[]) : [];
  if (attendees.some((a) => a.self === true && a.responseStatus === "declined")) return null;
  const s = e.start as Record<string, unknown> | undefined;
  const en = e.end as Record<string, unknown> | undefined;
  if (!s || !en) return null;
  let allDay: boolean;
  let start: string;
  let end: string;
  if (typeof s.date === "string" && DATE.test(s.date)) {
    allDay = true;
    start = s.date;
    end = typeof en.date === "string" && DATE.test(en.date) && en.date > s.date ? en.date : nextDay(s.date);
  } else if (typeof s.dateTime === "string") {
    const a = Date.parse(s.dateTime);
    const b = typeof en.dateTime === "string" ? Date.parse(en.dateTime) : NaN;
    if (!Number.isFinite(a)) return null;
    allDay = false;
    start = new Date(a).toISOString();
    end = new Date(Number.isFinite(b) && b >= a ? b : a).toISOString();
  } else return null;
  const title = typeof e.summary === "string" && e.summary.trim() ? e.summary.trim().slice(0, 300) : "(No title)";
  const location = typeof e.location === "string" && e.location.trim() ? e.location.trim().slice(0, 300) : null;
  return { gid: e.id, etag: typeof e.etag === "string" ? e.etag : `${e.updated ?? ""}`, allDay, start, end, title, location };
}

function nextDay(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** Multi-day events are shown on each of their days, up to this many. */
const MAX_SPAN_DAYS = 31;

/**
 * The local dates (YYYY-MM-DD) an event is shown on, within [from, to]. All-day events cover their dates, end
 * exclusive. A timed event covers every local day it touches; one ending exactly at midnight does not spill over.
 * `localDate` turns an instant into the user's local date.
 */
export function eventDates(ev: Pick<GEvent, "allDay" | "start" | "end">, from: string, to: string, localDate: (iso: string) => string): string[] {
  let first: string;
  let last: string;
  if (ev.allDay) {
    first = ev.start;
    last = new Date(Date.parse(`${ev.end}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    if (last < first) last = first;
  } else {
    first = localDate(ev.start);
    const endMs = Date.parse(ev.end);
    last = endMs > Date.parse(ev.start) ? localDate(new Date(endMs - 1).toISOString()) : first;
  }
  const out: string[] = [];
  for (let d = first, n = 0; d <= last && n < MAX_SPAN_DAYS; d = nextDay(d), n++) if (d >= from && d <= to) out.push(d);
  return out;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}

export function parseTokenResponse(body: unknown): TokenResponse | null {
  const b = body as Record<string, unknown>;
  if (!b || typeof b.access_token !== "string" || typeof b.expires_in !== "number") return null;
  return {
    access_token: b.access_token,
    expires_in: b.expires_in,
    refresh_token: typeof b.refresh_token === "string" ? b.refresh_token : undefined,
    scope: typeof b.scope === "string" ? b.scope : undefined,
    id_token: typeof b.id_token === "string" ? b.id_token : undefined,
  };
}
