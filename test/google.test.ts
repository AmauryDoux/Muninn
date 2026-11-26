// Google Calendar, read-only: OAuth with PKCE and a single-use state, sync that writes only what changed, and
// events placed on the right local days. Google is a fake fetch that checks requests the way Google would.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/env";
import { Cipher } from "../worker/lib/crypto";
import { Repo } from "../worker/repo";
import { calendarEntries } from "../worker/calendar";
import { GOOGLE_SCOPES, authUrl, eventDates, hasCalendarScopes, idTokenClaims, isHolidayCalendar, parseCalendarList, parseEvent } from "../worker/core/gcal";
import { finishConnect, googleEvents, listGoogle, patchGoogleCalendar, startConnect, syncGoogle, unlinkGoogle } from "../worker/google";
import { parseCivil } from "../worker/core/time";
import { makeD1 } from "./d1-shim";

const TZ = "America/Chicago";
const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const ORIGIN = "https://m.test";
const d = (s: string) => parseCivil(s)!;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (sub: string, email: string) => `${b64({ alg: "RS256" })}.${b64({ sub, email })}.sig`;
const SCOPE = GOOGLE_SCOPES.join(" ");

describe("gcal pure", () => {
  it("auth URL: read-only scopes, offline, PKCE S256, state", () => {
    const u = new URL(authUrl({ clientId: "cid", redirectUri: `${ORIGIN}/api/google/callback`, state: "st", codeChallenge: "ch" }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const scopes = u.searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.events.readonly");
    expect(scopes.some((s) => /calendar(\.events)?$/.test(s))).toBe(false); // never the read-write scopes
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe("st");
  });
  it("id token claims and scopes", () => {
    expect(idTokenClaims(idToken("123", "a@b.c"))).toEqual({ sub: "123", email: "a@b.c" });
    expect(idTokenClaims("junk")).toBeNull();
    expect(idTokenClaims(`x.${b64({ email: "a" })}.y`)).toBeNull();
    expect(hasCalendarScopes(SCOPE)).toBe(true);
    expect(hasCalendarScopes("openid email https://www.googleapis.com/auth/calendar.events.readonly")).toBe(false);
  });
  it("calendar list", () => {
    expect(
      parseCalendarList({
        items: [
          { id: "me@x", summary: "Me", backgroundColor: "#123456", primary: true },
          { id: "w", summary: "Work", summaryOverride: "Job", backgroundColor: "red" },
          { id: "gone", deleted: true },
          { nope: 1 },
        ],
      }),
    ).toEqual([
      { id: "me@x", summary: "Me", backgroundColor: "#123456", primary: true },
      { id: "w", summary: "Job", backgroundColor: null, primary: false },
    ]);
    expect(isHolidayCalendar("en.usa#holiday@group.v.calendar.google.com")).toBe(true);
    expect(isHolidayCalendar("me@gmail.com")).toBe(false);
  });
  it("events: timed, all-day, cancelled, declined", () => {
    expect(parseEvent({ id: "1", etag: "e", summary: " Dinner ", start: { dateTime: "2026-11-26T17:00:00-06:00" }, end: { dateTime: "2026-11-26T19:00:00-06:00" } })).toEqual({
      gid: "1", etag: "e", allDay: false, start: "2026-11-26T23:00:00.000Z", end: "2026-11-27T01:00:00.000Z", title: "Dinner", location: null,
    });
    expect(parseEvent({ id: "2", etag: "e", start: { date: "2026-12-24" }, end: { date: "2026-12-27" }, location: "Denver" })).toMatchObject({ allDay: true, start: "2026-12-24", end: "2026-12-27", title: "(No title)", location: "Denver" });
    expect(parseEvent({ id: "3", etag: "e", start: { date: "2026-12-24" }, end: {} })).toMatchObject({ end: "2026-12-25" });
    expect(parseEvent({ id: "4", status: "cancelled", start: { date: "2026-12-24" }, end: { date: "2026-12-25" } })).toBeNull();
    expect(parseEvent({ id: "5", attendees: [{ self: true, responseStatus: "declined" }], start: { date: "2026-12-24" }, end: { date: "2026-12-25" } })).toBeNull();
    expect(parseEvent({ id: "6", start: { dateTime: "nope" }, end: {} })).toBeNull();
  });
  it("event dates", () => {
    const local = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));
    // All-day 24 to 26 Dec (end exclusive 27).
    expect(eventDates({ allDay: true, start: "2026-12-24", end: "2026-12-27" }, "2026-12-01", "2026-12-31", local)).toEqual(["2026-12-24", "2026-12-25", "2026-12-26"]);
    expect(eventDates({ allDay: true, start: "2026-12-24", end: "2026-12-27" }, "2026-12-25", "2026-12-25", local)).toEqual(["2026-12-25"]);
    // 20:00 to 02:00 Chicago crosses midnight: two days. A UTC-midnight instant is still the 26th in Chicago.
    expect(eventDates({ allDay: false, start: "2026-11-27T02:00:00.000Z", end: "2026-11-27T08:00:00.000Z" }, "2026-11-01", "2026-11-30", local)).toEqual(["2026-11-26", "2026-11-27"]);
    // Ends exactly at local midnight: one day.
    expect(eventDates({ allDay: false, start: "2026-11-27T04:00:00.000Z", end: "2026-11-27T06:00:00.000Z" }, "2026-11-01", "2026-11-30", local)).toEqual(["2026-11-26"]);
  });
});

// ---- the fake Google ----

interface Ev {
  id: string;
  etag: string;
  summary: string;
  start: Record<string, string>;
  end: Record<string, string>;
}
let google: {
  calendars: { id: string; summary: string; backgroundColor?: string }[];
  events: Record<string, Ev[]>;
  scope: string;
  refreshOk: boolean;
  calls: { url: string; body: string | null; auth: string | null }[];
};

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? String(init.body) : null;
  const auth = new Headers(init?.headers).get("Authorization");
  google.calls.push({ url, body, auth });
  const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  if (url === "https://oauth2.googleapis.com/token") {
    const p = new URLSearchParams(body!);
    if (p.get("client_secret") !== "secret") return j({ error: "invalid_client" }, 401);
    if (p.get("grant_type") === "authorization_code") {
      if (p.get("code") !== "good-code" || !p.get("code_verifier")) return j({ error: "invalid_grant" }, 400);
      return j({ access_token: "at-1", expires_in: 3600, refresh_token: "rt-secret-1", scope: google.scope, id_token: idToken("sub-1", "me@gmail.com") });
    }
    if (p.get("grant_type") === "refresh_token") {
      if (!google.refreshOk) return j({ error: "invalid_grant" }, 400);
      return j({ access_token: "at-2", expires_in: 3600 });
    }
  }
  if (url.startsWith("https://oauth2.googleapis.com/revoke")) return j({});
  if (!auth?.startsWith("Bearer at-")) return j({ error: "unauthorized" }, 401);
  if (url.startsWith("https://www.googleapis.com/calendar/v3/users/me/calendarList")) return j({ items: google.calendars });
  const m = url.match(/calendars\/([^/]+)\/events\?/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const q = new URL(url).searchParams;
    expect(q.get("singleEvents")).toBe("true");
    return j({ items: google.events[id] ?? [] });
  }
  return j({ error: "not_found" }, 404);
}) as typeof fetch;

let env: Env;
let repo: Repo;
let cipher: Cipher;
const NOW = new Date("2026-11-26T15:00:00Z");

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  google = {
    calendars: [
      { id: "me@gmail.com", summary: "Me", backgroundColor: "#4285f4" },
      { id: "family123@group.calendar.google.com", summary: "Family" },
      { id: "en.usa#holiday@group.v.calendar.google.com", summary: "Holidays in United States" },
    ],
    events: {
      "me@gmail.com": [{ id: "e1", etag: '"1"', summary: "Dentist", start: { dateTime: "2026-11-30T15:00:00Z" }, end: { dateTime: "2026-11-30T16:00:00Z" } }],
      "family123@group.calendar.google.com": [
        { id: "e2", etag: '"1"', summary: "Dinner at Mom's", start: { dateTime: "2026-11-26T23:00:00Z" }, end: { dateTime: "2026-11-27T01:00:00Z" } },
        { id: "e3", etag: '"1"', summary: "Ski trip", start: { date: "2026-12-24" }, end: { date: "2026-12-27" } },
      ],
      "en.usa#holiday@group.v.calendar.google.com": [{ id: "h", etag: '"1"', summary: "Thanksgiving Day", start: { date: "2026-11-26" }, end: { date: "2026-11-27" } }],
    },
    scope: SCOPE,
    refreshOk: true,
    calls: [],
  };
  env = { DB: makeD1(), GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "secret", ANTHROPIC_API_KEY: "" } as unknown as Env;
  cipher = await Cipher.fromSecret(KEY);
  repo = new Repo(env, cipher, TZ);
});

const post = (path: string) => new Request(`${ORIGIN}${path}`, { method: "POST", headers: { Origin: ORIGIN } });

async function connect(code = "good-code", now = NOW): Promise<{ res: Response; state: string }> {
  const start = (await (await startConnect(repo, post("/api/google/connect"))).json()) as { url: string };
  const state = new URL(start.url).searchParams.get("state")!;
  const res = await finishConnect(env, cipher, new URL(`${ORIGIN}/api/google/callback?code=${code}&state=${state}`), now, fakeFetch);
  return { res, state };
}
const where = (r: Response) => new URL(r.headers.get("Location")!).searchParams.get("google");
const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;

describe("linking", () => {
  it("links an account, lists its calendars (holiday calendar off), and fetches events", async () => {
    const { res } = await connect();
    expect(res.status).toBe(303);
    expect(where(res)).toBe("linked");
    // PKCE: the verifier sent to Google hashes to the challenge in the auth URL (checked by the fake via presence).
    expect(google.calls[0].body).toContain("code_verifier=");
    const list = (await (await listGoogle(repo)).json()) as { accounts: { email: string; status: string; calendars: { name: string; enabled: boolean; events: number }[] }[] };
    expect(list.accounts).toHaveLength(1);
    expect(list.accounts[0]).toMatchObject({ email: "me@gmail.com", status: "ok" });
    expect(list.accounts[0].calendars.map((c) => [c.name, c.enabled, c.events])).toEqual([
      ["Family", true, 2],
      ["Holidays in United States", false, 0],
      ["Me", true, 1],
    ]);
  });

  it("stores tokens, emails and titles encrypted", async () => {
    await connect();
    const raw = JSON.stringify([
      (await env.DB.prepare("SELECT * FROM google_accounts").all()).results,
      (await env.DB.prepare("SELECT * FROM google_calendars").all()).results,
      (await env.DB.prepare("SELECT * FROM calendar_events").all()).results,
    ]);
    for (const secret of ["rt-secret-1", "at-1", "me@gmail.com", "Dinner at Mom", "family123", "sub-1"]) expect(raw).not.toContain(secret);
  });

  it("a state works once, expires, and must exist", async () => {
    const { state } = await connect();
    const again = await finishConnect(env, cipher, new URL(`${ORIGIN}/api/google/callback?code=good-code&state=${state}`), NOW, fakeFetch);
    expect(where(again)).toBe("bad_state");
    expect(where(await finishConnect(env, cipher, new URL(`${ORIGIN}/api/google/callback?code=good-code&state=forged`), NOW, fakeFetch))).toBe("bad_state");
    const late = await connect("good-code", new Date(Date.now() + 11 * 60_000));
    expect(where(late.res)).toBe("expired");
    expect(await count("google_accounts")).toBe(1);
  });

  it("denied consent, a bad code, or unticked calendar scopes link nothing", async () => {
    const start = (await (await startConnect(repo, post("/api/google/connect"))).json()) as { url: string };
    const state = new URL(start.url).searchParams.get("state")!;
    expect(where(await finishConnect(env, cipher, new URL(`${ORIGIN}/api/google/callback?error=access_denied&state=${state}`), NOW, fakeFetch))).toBe("denied");
    expect(where((await connect("bad-code")).res)).toBe("failed");
    google.scope = "openid email";
    expect(where((await connect()).res)).toBe("missing_scope");
    expect(await count("google_accounts")).toBe(0);
  });

  it("linking the same account again updates it instead of adding another", async () => {
    await connect();
    await connect();
    expect(await count("google_accounts")).toBe(1);
    expect(await count("google_calendars")).toBe(3);
  });

  it("refuses to start when the client is not configured", async () => {
    env.GOOGLE_CLIENT_SECRET = undefined;
    await expect(startConnect(repo, post("/api/google/connect"))).rejects.toMatchObject({ status: 409 });
  });
});

describe("sync", () => {
  it("an unchanged calendar costs no event writes; a changed one writes only the difference", async () => {
    await connect();
    const before = await env.DB.prepare("SELECT id, title_enc FROM calendar_events ORDER BY id").all<{ id: string; title_enc: string }>();
    const later = new Date(NOW.getTime() + 20 * 60_000);
    await syncGoogle(env, cipher, later, {}, fakeFetch);
    const same = await env.DB.prepare("SELECT id, title_enc FROM calendar_events ORDER BY id").all<{ id: string; title_enc: string }>();
    expect(same.results).toEqual(before.results); // ciphertexts unchanged: nothing rewritten

    google.events["family123@group.calendar.google.com"] = [
      { id: "e2", etag: '"2"', summary: "Dinner at Mom's (6pm)", start: { dateTime: "2026-11-27T00:00:00Z" }, end: { dateTime: "2026-11-27T02:00:00Z" } },
    ];
    await syncGoogle(env, cipher, new Date(later.getTime() + 20 * 60_000), {}, fakeFetch);
    const e = await googleEvents(repo)(d("2026-11-01"), d("2026-12-31"), TZ);
    expect(e.map((x) => `${x.date} ${x.title}`).sort()).toEqual(["2026-11-26 Dinner at Mom's (6pm)", "2026-11-30 Dentist"]);
  });

  it("is not refetched while fresh, and respects the fetch budget", async () => {
    await connect();
    const n = google.calls.length;
    await syncGoogle(env, cipher, new Date(NOW.getTime() + 60_000), {}, fakeFetch);
    expect(google.calls.length).toBe(n); // fresh, token still valid: no calls at all
    const r = await syncGoogle(env, cipher, new Date(NOW.getTime() + 20 * 60_000), { budget: 1 }, fakeFetch);
    expect(r.fetched).toBe(1);
  });

  it("a revoked refresh token marks the account for relinking and stops", async () => {
    await connect();
    google.refreshOk = false;
    const r = await syncGoogle(env, cipher, new Date(NOW.getTime() + 2 * 3600_000), {}, fakeFetch);
    expect(r.errors).toBe(1);
    const list = (await (await listGoogle(repo)).json()) as { accounts: { status: string; error: string }[] };
    expect(list.accounts[0].status).toBe("revoked");
    expect(list.accounts[0].error).toMatch(/Link the account again/);
    // Revoked accounts are skipped, not retried every 5 minutes.
    const calls = google.calls.length;
    await syncGoogle(env, cipher, new Date(NOW.getTime() + 3 * 3600_000), {}, fakeFetch);
    expect(google.calls.length).toBe(calls);
  });

  it("a calendar removed in Google disappears with its events", async () => {
    await connect();
    google.calendars = google.calendars.filter((c) => c.summary !== "Family");
    await syncGoogle(env, cipher, NOW, { force: true }, fakeFetch);
    expect(await count("google_calendars")).toBe(2);
    expect(await count("calendar_events")).toBe(1);
  });
});

describe("calendar view and settings", () => {
  it("events show in the calendar next to holidays, multi-day ones on each day", async () => {
    await connect();
    const e = await calendarEntries(repo, d("2026-11-26"), d("2026-12-26"), TZ, googleEvents(repo));
    const ev = e.filter((x) => x.kind === "event").map((x) => `${x.date} ${x.title}`);
    expect(ev).toEqual(["2026-11-26 Dinner at Mom's", "2026-11-30 Dentist", "2026-12-24 Ski trip", "2026-12-25 Ski trip", "2026-12-26 Ski trip"]);
    expect(e.find((x) => x.kind === "event" && x.title === "Dentist")).toMatchObject({ calendar: "Me", color: "#4285f4", all_day: false });
    // The disabled Google holiday calendar does not duplicate Muninn's own Thanksgiving.
    expect(e.filter((x) => x.date === "2026-11-26" && /Thanksgiving/.test(x.title)).map((x) => x.kind)).toEqual(["holiday"]);
  });

  it("switching a calendar off drops its events; on again refetches them", async () => {
    await connect();
    const cal = await env.DB.prepare("SELECT id FROM google_calendars WHERE color = '#4285f4'").first<{ id: string }>();
    const patch = (enabled: boolean) => new Request(`${ORIGIN}/x`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
    await patchGoogleCalendar(repo, patch(false), cal!.id);
    expect((await googleEvents(repo)(d("2026-11-01"), d("2026-12-31"), TZ)).map((x) => x.title)).not.toContain("Dentist");
    await patchGoogleCalendar(repo, patch(true), cal!.id);
    await syncGoogle(env, cipher, NOW, {}, fakeFetch);
    expect((await googleEvents(repo)(d("2026-11-01"), d("2026-12-31"), TZ)).map((x) => x.title)).toContain("Dentist");
  });

  it("unlinking revokes at Google and forgets everything", async () => {
    await connect();
    const a = await env.DB.prepare("SELECT id FROM google_accounts").first<{ id: string }>();
    await unlinkGoogle(repo, a!.id, fakeFetch);
    expect(google.calls.some((c) => c.url.startsWith("https://oauth2.googleapis.com/revoke") && c.body === "token=rt-secret-1")).toBe(true);
    for (const t of ["google_accounts", "google_calendars", "calendar_events"]) expect(await count(t)).toBe(0);
  });
});
