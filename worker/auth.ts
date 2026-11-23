// Single-user auth: passkeys first, a long passphrase as fallback, opaque session cookies stored hashed.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Env } from "./env";
import { fromB64url, toB64url, utf8 } from "./lib/b64";
import { Cipher, randomToken, sha256b64url } from "./lib/crypto";
import { HttpError, clientIp, json, readJson, str } from "./lib/http";
import { getSetting, setSetting } from "./lib/settings";
import { ulid } from "./lib/ulid";
import { isValidTimeZone } from "./core/time";

export const COOKIE = "__Host-muninn";
const CHALLENGE_COOKIE = "__Host-muninn-ch";
const SESSION_DAYS = 30;
const REAUTH_MINUTES = 5;
const MIN_PASSPHRASE = 16;
const ATTEMPT_WINDOW_MIN = 15;
const ATTEMPTS_PER_IP = 5;
const ATTEMPTS_GLOBAL = 20; // stops a slow brute force from many IPs

export interface Session {
  idHash: string;
  reauthAt: Date;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function sessionVersion(db: D1Database): Promise<number> {
  return Number((await getSetting(db, "session_version")) ?? "1");
}

export async function createSession(env: Env, req: Request): Promise<string> {
  const token = randomToken(32);
  const now = new Date();
  await env.DB.prepare(
    "INSERT INTO sessions (id_hash, created_at, expires_at, last_seen_at, reauth_at, version, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      await sha256b64url(token),
      now.toISOString(),
      new Date(now.getTime() + SESSION_DAYS * 86400_000).toISOString(),
      now.toISOString(),
      now.toISOString(),
      await sessionVersion(env.DB),
      (req.headers.get("User-Agent") ?? "").slice(0, 200),
    )
    .run();
  return cookie(COOKIE, token, SESSION_DAYS * 86400);
}

export async function getSession(env: Env, req: Request): Promise<Session | null> {
  const token = readCookie(req, COOKIE);
  if (!token || token.length > 100) return null;
  const idHash = await sha256b64url(token);
  const row = await env.DB.prepare("SELECT * FROM sessions WHERE id_hash = ?")
    .bind(idHash)
    .first<{ expires_at: string; last_seen_at: string; reauth_at: string; version: number }>();
  if (!row) return null;
  const now = Date.now();
  if (new Date(row.expires_at).getTime() < now || row.version !== (await sessionVersion(env.DB))) {
    await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
    return null;
  }
  if (now - new Date(row.last_seen_at).getTime() > 3600_000) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(new Date().toISOString(), idHash).run();
  }
  return { idHash, reauthAt: new Date(row.reauth_at) };
}

export async function requireSession(env: Env, req: Request): Promise<Session> {
  const s = await getSession(env, req);
  if (!s) throw new HttpError(401, "unauthenticated");
  return s;
}

/** Sensitive actions (export, What I know, delete, new credentials) need a strong check in the last few minutes. */
export function requireFresh(s: Session): void {
  if (Date.now() - s.reauthAt.getTime() > REAUTH_MINUTES * 60_000) throw new HttpError(403, "reauth_required");
}

async function markFresh(env: Env, s: Session): Promise<void> {
  await env.DB.prepare("UPDATE sessions SET reauth_at = ? WHERE id_hash = ?").bind(new Date().toISOString(), s.idHash).run();
}

/** Count and record an attempt. Throws 429 past the per-IP or global limit. */
async function rateLimit(env: Env, cipher: Cipher, req: Request): Promise<void> {
  const ipHash = await cipher.mac(`ip:${clientIp(req)}`);
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MIN * 60_000).toISOString();
  const [perIp, global] = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE ip_hash = ? AND at >= ?").bind(ipHash, since),
    env.DB.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE at >= ?").bind(since),
  ]);
  if ((perIp.results[0]?.n ?? 0) >= ATTEMPTS_PER_IP || (global.results[0]?.n ?? 0) >= ATTEMPTS_GLOBAL) {
    throw new HttpError(429, "too_many_attempts", `Try again in ${ATTEMPT_WINDOW_MIN} minutes.`);
  }
  await env.DB.prepare("INSERT INTO auth_attempts (ip_hash, at) VALUES (?, ?)").bind(ipHash, new Date().toISOString()).run();
}

async function clearAttempts(env: Env, cipher: Cipher, req: Request): Promise<void> {
  const ipHash = await cipher.mac(`ip:${clientIp(req)}`);
  await env.DB.prepare("DELETE FROM auth_attempts WHERE ip_hash = ?").bind(ipHash).run();
}

/**
 * Passphrase verifier: HMAC-SHA-256 keyed by a key derived from DATA_KEY (a pepper held only in Worker secrets).
 * Workers cannot run PBKDF2 above 100,000 iterations, and the free plan allows ~10 ms CPU per request, so a
 * slow hash is not available here. Instead: the verifier is useless without the Worker secret, the passphrase
 * must be long (>= 16 chars), and attempts are rate limited per IP and globally.
 */
async function passphraseVerifier(cipher: Cipher, passphrase: string): Promise<string> {
  return cipher.mac(`passphrase:v1:${passphrase.normalize("NFKC")}`);
}

async function checkPassphrase(env: Env, cipher: Cipher, passphrase: string): Promise<boolean> {
  const stored = await getSetting(env.DB, "passphrase_verifier");
  if (!stored) return false;
  return cipher.macVerify(`passphrase:v1:${passphrase.normalize("NFKC")}`, stored);
}

async function constantTimeEqual(cipher: Cipher, a: string, b: string): Promise<boolean> {
  // Compare MACs of both values, so timing reveals nothing about the secret.
  return cipher.macVerify(`cmp:${a}`, await cipher.mac(`cmp:${b}`));
}

function validatePassphrase(p: string): void {
  if (p.length < MIN_PASSPHRASE) throw new HttpError(400, "weak_passphrase", `Use at least ${MIN_PASSPHRASE} characters.`);
}

async function saveChallenge(env: Env, challenge: string, purpose: string): Promise<string> {
  const id = randomToken(16);
  await setSetting(env.DB, `challenge:${id}`, JSON.stringify({ challenge, purpose, exp: Date.now() + 5 * 60_000 }));
  return cookie(CHALLENGE_COOKIE, id, 300);
}

async function takeChallenge(env: Env, req: Request, purpose: string): Promise<string> {
  const id = readCookie(req, CHALLENGE_COOKIE);
  if (!id || id.length > 40) throw new HttpError(400, "no_challenge");
  const raw = await getSetting(env.DB, `challenge:${id}`);
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(`challenge:${id}`).run(); // single use
  if (!raw) throw new HttpError(400, "no_challenge");
  const c = JSON.parse(raw) as { challenge: string; purpose: string; exp: number };
  if (c.exp < Date.now() || c.purpose !== purpose) throw new HttpError(400, "challenge_expired");
  return c.challenge;
}

const clearChallenge = cookie(CHALLENGE_COOKIE, "", 0);

function rp(req: Request) {
  const url = new URL(req.url);
  return { rpID: url.hostname, origin: url.origin };
}

/** Routes under /api/auth/*. Returns null when the path is not an auth route. */
export async function handleAuth(env: Env, req: Request, path: string, cipher: Cipher): Promise<Response | null> {
  const db = env.DB;
  const setupDone = (await getSetting(db, "setup_done")) === "1";

  if (path === "/api/auth/status" && req.method === "GET") {
    const s = await getSession(env, req);
    const pk = await db.prepare("SELECT COUNT(*) AS n FROM passkeys").first<{ n: number }>();
    return json({ setup_done: setupDone, signed_in: !!s, has_passkey: (pk?.n ?? 0) > 0 });
  }

  if (path === "/api/auth/setup" && req.method === "POST") {
    if (setupDone) throw new HttpError(409, "already_set_up");
    await rateLimit(env, cipher, req);
    const body = await readJson<{ code?: unknown; passphrase?: unknown; tz?: unknown; name?: unknown }>(req);
    const code = str(body.code, "code", 200);
    if (!env.SETUP_CODE || env.SETUP_CODE.length < 16) throw new HttpError(500, "setup_code_missing");
    if (!(await constantTimeEqual(cipher, code, env.SETUP_CODE))) throw new HttpError(401, "bad_code");
    const passphrase = str(body.passphrase, "passphrase", 500);
    validatePassphrase(passphrase);
    const tz = str(body.tz, "tz", 64);
    if (!isValidTimeZone(tz)) throw new HttpError(400, "bad_tz");
    const name = str(body.name, "name", 80, { optional: true }) || "Me";
    const selfId = ulid();
    await db.batch([
      db.prepare("INSERT INTO settings (key, value) VALUES ('passphrase_verifier', ?)").bind(await passphraseVerifier(cipher, passphrase)),
      db.prepare("INSERT INTO settings (key, value) VALUES ('tz', ?)").bind(tz),
      db.prepare("INSERT INTO settings (key, value) VALUES ('session_version', '1')"),
      db
        .prepare("INSERT INTO people (id, name_enc, aliases_enc, relation, created_at) VALUES (?, ?, ?, 'self', ?)")
        .bind(
          selfId,
          await cipher.encrypt(name, `people:${selfId}:name`),
          await cipher.encrypt(JSON.stringify(["me"]), `people:${selfId}:aliases`),
          new Date().toISOString(),
        ),
      // Last, and conditional, so two racing setup calls cannot both succeed.
      db.prepare("INSERT INTO settings (key, value) VALUES ('setup_done', '1')"),
    ]);
    await clearAttempts(env, cipher, req);
    return json({ ok: true }, 200, { "Set-Cookie": await createSession(env, req) });
  }

  if (!setupDone) throw new HttpError(409, "setup_required");

  if (path === "/api/auth/login" && req.method === "POST") {
    await rateLimit(env, cipher, req);
    const body = await readJson<{ passphrase?: unknown }>(req);
    const ok = await checkPassphrase(env, cipher, str(body.passphrase, "passphrase", 500));
    if (!ok) throw new HttpError(401, "bad_credentials");
    await clearAttempts(env, cipher, req);
    return json({ ok: true }, 200, { "Set-Cookie": await createSession(env, req) });
  }

  if (path === "/api/auth/passkey/login/options" && req.method === "POST") {
    await rateLimit(env, cipher, req);
    const { rpID } = rp(req);
    const opts = await generateAuthenticationOptions({ rpID, userVerification: "required" });
    return json(opts, 200, { "Set-Cookie": await saveChallenge(env, opts.challenge, "login") });
  }

  if ((path === "/api/auth/passkey/login/verify" || path === "/api/auth/passkey/reauth/verify") && req.method === "POST") {
    const purpose = path.includes("reauth") ? "reauth" : "login";
    const session = purpose === "reauth" ? await requireSession(env, req) : null;
    const expectedChallenge = await takeChallenge(env, req, purpose);
    const response = await readJson<AuthenticationResponseJSON>(req, 16 * 1024);
    if (typeof response?.id !== "string") throw new HttpError(400, "bad_request");
    const row = await db
      .prepare("SELECT * FROM passkeys WHERE id = ?")
      .bind(response.id)
      .first<{ id: string; public_key: string; counter: number; transports: string | null }>();
    if (!row) throw new HttpError(401, "bad_credentials");
    const { rpID, origin } = rp(req);
    let verified = false;
    let newCounter = row.counter;
    try {
      const r = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: row.id,
          publicKey: fromB64url(row.public_key),
          counter: row.counter,
          transports: row.transports ? JSON.parse(row.transports) : undefined,
        },
      });
      verified = r.verified;
      newCounter = r.authenticationInfo.newCounter;
    } catch (e) {
      console.warn("passkey verify failed", e instanceof Error ? e.message : e);
    }
    if (!verified) throw new HttpError(401, "bad_credentials");
    await db
      .prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
      .bind(newCounter, new Date().toISOString(), row.id)
      .run();
    if (session) {
      await markFresh(env, session);
      return json({ ok: true }, 200, { "Set-Cookie": clearChallenge });
    }
    await clearAttempts(env, cipher, req);
    const headers = new Headers();
    headers.append("Set-Cookie", await createSession(env, req));
    headers.append("Set-Cookie", clearChallenge);
    return json({ ok: true }, 200, headers);
  }

  // Everything below needs a session.
  const session = await requireSession(env, req);

  if (path === "/api/auth/passkey/reauth/options" && req.method === "POST") {
    const { rpID } = rp(req);
    const opts = await generateAuthenticationOptions({ rpID, userVerification: "required" });
    return json(opts, 200, { "Set-Cookie": await saveChallenge(env, opts.challenge, "reauth") });
  }

  if (path === "/api/auth/reauth" && req.method === "POST") {
    await rateLimit(env, cipher, req);
    const body = await readJson<{ passphrase?: unknown }>(req);
    if (!(await checkPassphrase(env, cipher, str(body.passphrase, "passphrase", 500)))) throw new HttpError(401, "bad_credentials");
    await clearAttempts(env, cipher, req);
    await markFresh(env, session);
    return json({ ok: true });
  }

  if (path === "/api/auth/passkey/register/options" && req.method === "POST") {
    requireFresh(session);
    const { rpID } = rp(req);
    const existing = await db.prepare("SELECT id, transports FROM passkeys").all<{ id: string; transports: string | null }>();
    const opts = await generateRegistrationOptions({
      rpName: "Muninn",
      rpID,
      userName: "muninn",
      userDisplayName: "Muninn",
      userID: utf8("muninn-owner"),
      attestationType: "none",
      excludeCredentials: existing.results.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    return json(opts, 200, { "Set-Cookie": await saveChallenge(env, opts.challenge, "register") });
  }

  if (path === "/api/auth/passkey/register/verify" && req.method === "POST") {
    requireFresh(session);
    const expectedChallenge = await takeChallenge(env, req, "register");
    const body = await readJson<{ response: RegistrationResponseJSON; label?: unknown }>(req, 32 * 1024);
    const { rpID, origin } = rp(req);
    let info;
    try {
      const r = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
      if (!r.verified) throw new Error("not verified");
      info = r.registrationInfo;
    } catch (e) {
      console.warn("passkey registration failed", e instanceof Error ? e.message : e);
      throw new HttpError(400, "registration_failed");
    }
    await db
      .prepare("INSERT INTO passkeys (id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(
        info.credential.id,
        toB64url(info.credential.publicKey),
        info.credential.counter,
        info.credential.transports ? JSON.stringify(info.credential.transports) : null,
        str(body.label, "label", 60, { optional: true }) || "Passkey",
        new Date().toISOString(),
      )
      .run();
    return json({ ok: true }, 200, { "Set-Cookie": clearChallenge });
  }

  if (path === "/api/auth/passkeys" && req.method === "GET") {
    const { results } = await db.prepare("SELECT id, label, created_at, last_used_at FROM passkeys ORDER BY created_at").all();
    return json({ passkeys: results });
  }

  if (path.startsWith("/api/auth/passkeys/") && req.method === "DELETE") {
    requireFresh(session);
    const id = decodeURIComponent(path.slice("/api/auth/passkeys/".length));
    await db.prepare("DELETE FROM passkeys WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }

  if (path === "/api/auth/passphrase" && req.method === "POST") {
    requireFresh(session);
    const body = await readJson<{ passphrase?: unknown }>(req);
    const p = str(body.passphrase, "passphrase", 500);
    validatePassphrase(p);
    await setSetting(db, "passphrase_verifier", await passphraseVerifier(cipher, p));
    return json({ ok: true });
  }

  if (path === "/api/auth/logout" && req.method === "POST") {
    await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(session.idHash).run();
    return json({ ok: true }, 200, { "Set-Cookie": cookie(COOKIE, "", 0) });
  }

  if (path === "/api/auth/logout-all" && req.method === "POST") {
    const v = (await sessionVersion(db)) + 1;
    await setSetting(db, "session_version", String(v));
    await db.prepare("DELETE FROM sessions").run();
    return json({ ok: true }, 200, { "Set-Cookie": cookie(COOKIE, "", 0) });
  }

  return null;
}
