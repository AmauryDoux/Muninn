// Login limits: password guessing stays capped, but nobody can lock the owner out of passkey sign-in.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/env";
import { handleAuth } from "../worker/auth";
import { Cipher } from "../worker/lib/crypto";
import { HttpError } from "../worker/lib/http";
import { setSetting } from "../worker/lib/settings";
import { makeD1 } from "./d1-shim";

const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
let env: Env;
let cipher: Cipher;

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  env = { DB: makeD1(), DATA_KEY: KEY } as unknown as Env;
  cipher = await Cipher.fromSecret(KEY);
  await setSetting(env.DB, "setup_done", "1");
});

const call = async (path: string, ip: string, body: unknown = {}, cookie = "") => {
  const req = new Request(`https://m.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://m.test", "CF-Connecting-IP": ip, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  try {
    return await handleAuth(env, req, path, cipher);
  } catch (e) {
    if (e instanceof HttpError) return new Response(JSON.stringify({ error: e.code }), { status: e.status });
    throw e;
  }
};
const challengeCookie = (r: Response) => r.headers.get("Set-Cookie")!.split(";")[0];

describe("lockout", () => {
  it("passkey challenges from many IPs never block the owner", async () => {
    for (let i = 0; i < 100; i++) expect((await call("/api/auth/passkey/login/options", `198.51.100.${i}`))!.status).toBe(200);
    expect((await call("/api/auth/passkey/login/options", "203.0.113.7"))!.status).toBe(200);
    // And asking for challenges writes nothing to D1.
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'challenge:%'").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("failed passkey attempts from other IPs do not block the owner, and do not count toward the password cap", async () => {
    for (let i = 0; i < 40; i++) {
      const ip = `198.51.100.${i}`;
      const opts = await call("/api/auth/passkey/login/options", ip);
      const r = await call("/api/auth/passkey/login/verify", ip, { id: "nope", response: {} }, challengeCookie(opts!));
      expect(r!.status).toBe(401);
    }
    const opts = await call("/api/auth/passkey/login/options", "203.0.113.7");
    expect(opts!.status).toBe(200);
    // The password limit is untouched by passkey failures.
    expect((await call("/api/auth/login", "203.0.113.7", { username: "me", password: "x" }))!.status).toBe(401);
  });

  it("one IP spamming passkey failures is throttled on its own", async () => {
    const ip = "198.51.100.9";
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const opts = await call("/api/auth/passkey/login/options", ip);
      last = (await call("/api/auth/passkey/login/verify", ip, { id: "nope" }, challengeCookie(opts!)))!.status;
    }
    expect(last).toBe(429);
    const other = await call("/api/auth/passkey/login/options", "203.0.113.7");
    const r = await call("/api/auth/passkey/login/verify", "203.0.113.7", { id: "nope" }, challengeCookie(other!));
    expect(r!.status).toBe(401); // not 429
  });

  it("password guessing is still capped per IP and globally", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call("/api/auth/login", "198.51.100.1", { username: "me", password: "x" }))!.status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
    for (let i = 0; i < 20; i++) await call("/api/auth/login", `198.51.100.${50 + i}`, { username: "me", password: "x" });
    expect((await call("/api/auth/login", "203.0.113.200", { username: "me", password: "x" }))!.status).toBe(429);
  });
});

describe("signed challenge cookie", () => {
  it("rejects a forged, expired-purpose or missing challenge", async () => {
    const opts = await call("/api/auth/passkey/login/options", "203.0.113.7");
    const good = challengeCookie(opts!);
    const forged = good.replace(/\.[^.]+$/, ".AAAA");
    expect((await call("/api/auth/passkey/login/verify", "203.0.113.7", { id: "x" }, forged))!.status).toBe(400);
    expect((await call("/api/auth/passkey/login/verify", "203.0.113.7", { id: "x" }))!.status).toBe(400);
    // A login challenge can't be used to register a passkey (purpose is signed).
    const body = good.split("=")[1].split(".")[0];
    const swapped = JSON.parse(Buffer.from(body, "base64url").toString());
    swapped.p = "register";
    const tampered = `__Host-muninn-ch=${Buffer.from(JSON.stringify(swapped)).toString("base64url")}.${good.split(".")[1]}`;
    expect((await call("/api/auth/passkey/login/verify", "203.0.113.7", { id: "x" }, tampered))!.status).toBe(400);
  });
});

describe("sessions and passkey-only", () => {
  async function signedIn() {
    const { createSession } = await import("../worker/auth");
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const cookie = (await createSession(env, new Request("https://m.test/", { headers: { "User-Agent": ua } }))).split(";")[0];
    await createSession(env, new Request("https://m.test/", { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36" } }));
    return cookie;
  }
  const get = (path: string, cookie: string) =>
    handleAuth(env, new Request(`https://m.test${path}`, { headers: { Cookie: cookie } }), path, cipher);

  it("lists sessions with device names and marks this one", async () => {
    const cookie = await signedIn();
    const r = (await (await get("/api/auth/sessions", cookie))!.json()) as { sessions: { device: string; current: boolean }[] };
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions.find((s) => s.current)!.device).toBe("iPhone, Safari");
    expect(r.sessions.find((s) => !s.current)!.device).toBe("Windows, Chrome");
  });

  it("password sign-in can be turned off only with a passkey, and then refuses passwords", async () => {
    const cookie = await signedIn();
    await env.DB.prepare("UPDATE sessions SET reauth_at = ?").bind(new Date().toISOString()).run();
    const off = (c = cookie) => call("/api/auth/password-login", "203.0.113.7", { enabled: false }, c);
    expect((await off())!.status).toBe(409);
    await env.DB.prepare("INSERT INTO passkeys (id, public_key, counter, label, created_at) VALUES ('pk', 'x', 0, 'iPhone', 'x')").run();
    expect((await off())!.status).toBe(200);
    expect((await call("/api/auth/login", "203.0.113.8", { username: "me", password: "Correct-Horse-9" }))!.status).toBe(403);
  });
});
