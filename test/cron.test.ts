// A whole simulated day of the 5-minute cron against the real schema: every job runs, none throws.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/env";
import { Cipher } from "../worker/lib/crypto";
import { setSetting } from "../worker/lib/settings";
import { Repo } from "../worker/repo";
import { addFactSmart } from "../worker/engine";
import { createLifeItem } from "../worker/routes/life";
import { runScheduled } from "../worker/scheduled";
import { makeD1 } from "./d1-shim";

const TZ = "America/Chicago";
const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
let env: Env;
let repo: Repo;
const errors: unknown[][] = [];

beforeEach(async () => {
  errors.length = 0;
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  env = { DB: makeD1(), DATA_KEY: KEY, PARSE_MODEL: "claude-haiku-5-5", ANTHROPIC_API_KEY: "" } as unknown as Env;
  repo = new Repo(env, await Cipher.fromSecret(KEY), TZ);
  for (const [k, v] of [["setup_done", "1"], ["tz", TZ], ["home_lat", "41.88"], ["home_lon", "-87.63"]]) await setSetting(env.DB, k, v);
  // Open-Meteo stand-in: a cold week.
  vi.stubGlobal("fetch", async (url: string) => {
    if (!String(url).includes("open-meteo")) throw new Error("unexpected fetch " + url);
    const days = Array.from({ length: 7 }, (_, i) => `2026-11-${String(22 + i).padStart(2, "0")}`);
    return new Response(JSON.stringify({ daily: { time: days, temperature_2m_min: days.map(() => -3), temperature_2m_max: days.map(() => 4), precipitation_sum: days.map(() => 0) } }));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const post = (body: unknown) => new Request("https://m.test/api/x", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://m.test" }, body: JSON.stringify(body) });

describe("cron over a full Sunday", () => {
  it("runs every job without errors and produces triggers, tips and weather", async () => {
    const emma = await repo.createPerson("Emma", "daughter", ["daughter"]);
    await addFactSmart(repo, { subjectType: "person", subjectId: emma.id, key: "birthday", value: "--12-08", source: "told" }, TZ);
    await createLifeItem(repo, post({ subtype: "gift_idea", title: "Blue Lego set", for_person_id: emma.id }), TZ);
    await createLifeItem(repo, post({ subtype: "seasonal", title: "Put winter tires on", recurrence: "FREQ=YEARLY;BYMONTH=11" }), TZ);
    await createLifeItem(repo, post({ subtype: "idea", title: "Blog post on AD" }), TZ);
    await createLifeItem(repo, post({ subtype: "debt", title: "Lent Mike", attrs: { direction: "they_owe_me", amount: "$40", since: "2026-09-01" } }), TZ);

    // Sunday 2026-11-29 in Chicago, every 5 minutes.
    const start = Date.parse("2026-11-29T06:00:00Z");
    for (let t = start; t < start + 24 * 3600e3; t += 5 * 60e3) await runScheduled(env, new Date(t));

    expect(errors).toEqual([]);
    // Emma's birthday 8 Dec: the 14-days-before reminder fired on 24 Nov's catch-up, so its task exists.
    const fired = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE source_trigger_id IS NOT NULL").first<{ n: number }>();
    expect(fired!.n).toBeGreaterThan(0);
    const tips = await env.DB.prepare("SELECT rule FROM tips WHERE status = 'active'").all<{ rule: string }>();
    expect(tips.results.map((r) => r.rule)).toEqual(expect.arrayContaining(["date_prep"]));
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'weather'").first()).toBeTruthy();
    // No push configured: nothing may be marked as reminded.
    const reminded = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE reminded_start_at IS NOT NULL").first<{ n: number }>();
    expect(reminded!.n).toBe(0);
  });
});

describe("reminder delivery", () => {
  async function withPush() {
    const toB64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
    const vapid = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    Object.assign(env, {
      VAPID_PUBLIC_KEY: toB64(await crypto.subtle.exportKey("raw", vapid.publicKey) as ArrayBuffer),
      VAPID_PRIVATE_KEY: ((await crypto.subtle.exportKey("jwk", vapid.privateKey)) as JsonWebKey).d,
      VAPID_SUBJECT: "mailto:t@example.invalid",
    });
    await env.DB.prepare("INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at) VALUES ('s1', 'https://web.push.apple.com/x', ?, ?, ?)")
      .bind(toB64(await crypto.subtle.exportKey("raw", ua.publicKey) as ArrayBuffer), toB64(crypto.getRandomValues(new Uint8Array(16))), new Date().toISOString())
      .run();
  }

  it("leaves reminders unmarked when no device got the push, and marks them once one does", async () => {
    await withPush();
    let status = 500;
    vi.stubGlobal("fetch", async () => new Response("", { status }));
    const due = "2026-11-24T16:00:00Z"; // 10:00 in Chicago
    await env.DB.prepare(
      "INSERT INTO items (id, kind, title_enc, status, window_start, window_end, due_at, created_at, updated_at) VALUES ('01J0000000000000000000000A', 'task', 'x', 'open', ?, ?, ?, ?, ?)",
    )
      .bind("2026-11-24T06:00:00Z", "2026-11-25T06:00:00Z", due, due, due)
      .run();
    const reminded = async () =>
      (await env.DB.prepare("SELECT reminded_start_at AS r FROM items").first<{ r: string | null }>())!.r;

    await runScheduled(env, new Date("2026-11-24T16:01:00Z"));
    expect(await reminded()).toBeNull();
    const failed = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'push_failed'").first<{ n: number }>();
    expect(failed!.n).toBeGreaterThan(0);
    expect(await env.DB.prepare("SELECT 1 FROM events WHERE type = 'push_sent'").first()).toBeNull();

    status = 201;
    await runScheduled(env, new Date("2026-11-24T16:06:00Z"));
    expect(await reminded()).not.toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM events WHERE type = 'push_sent'").first()).toBeTruthy();
  });
});
