// Single-user auth: passkeys first, username + password as fallback, opaque session cookies stored hashed.
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
import { normalizeUsername, passwordProblem } from "./core/password";

export const COOKIE = "__Host-muninn";
const CHALLENGE_COOKIE = "__Host-muninn-ch";
const SESSION_DAYS = 30;
const REAUTH_MINUTES = 5;
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

/**
 * Password guessing limits: per IP and in total, so rotating IPs does not help. Counts every attempt up front (so
 * parallel guesses can't race past the limit); a success clears that IP's count. Only password checks and setup use
 * the global cap. Passkey sign-in cannot be guessed, so it never touches it: otherwise anyone could keep the owner
 * locked out just by asking for passkey challenges.
 */
async function rateLimit(env: Env, cipher: Cipher, req: Request): Promise<void> {
  const ipHash = await cipher.mac(`ip:${clientIp(req)}`);
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MIN * 60_000).toISOString();
  const [perIp, global] = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE ip_hash = ? AND at >= ?").bind(ipHash, since),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM auth_attempts WHERE at >= ? AND ip_hash NOT LIKE '${PASSKEY_PREFIX}%'`).bind(since),
  ]);
  if ((perIp.results[0]?.n ?? 0) >= ATTEMPTS_PER_IP || (global.results[0]?.n ?? 0) >= ATTEMPTS_GLOBAL) {
    throw new HttpError(429, "too_many_attempts", `Try again in ${ATTEMPT_WINDOW_MIN} minutes.`);
  }
  await env.DB.prepare("INSERT INTO auth_attempts (ip_hash, at) VALUES (?, ?)").bind(ipHash, new Date().toISOString()).run();
}

const PASSKEY_PREFIX = "pk:";
const PASSKEY_FAILURES_PER_IP = 30;

/** Passkey failures, per IP only. Stops one client from making the Worker verify junk all day; never blocks others. */
async function passkeyIpKey(cipher: Cipher, req: Request): Promise<string> {
  return PASSKEY_PREFIX + (await cipher.mac(`pk-ip:${clientIp(req)}`));
}
async function passkeyLimit(env: Env, cipher: Cipher, req: Request): Promise<void> {
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MIN * 60_000).toISOString();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE ip_hash = ? AND at >= ?")
    .bind(await passkeyIpKey(cipher, req), since)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= PASSKEY_FAILURES_PER_IP) throw new HttpError(429, "too_many_attempts", `Try again in ${ATTEMPT_WINDOW_MIN} minutes.`);
}
async function passkeyFailed(env: Env, cipher: Cipher, req: Request): Promise<void> {
  await env.DB.prepare("INSERT INTO auth_attempts (ip_hash, at) VALUES (?, ?)").bind(await passkeyIpKey(cipher, req), new Date().toISOString()).run();
}

async function clearAttempts(env: Env, cipher: Cipher, req: Request): Promise<void> {
  const ipHash = await cipher.mac(`ip:${clientIp(req)}`);
  await env.DB.prepare("DELETE FROM auth_attempts WHERE ip_hash = ?").bind(ipHash).run();
}

/**
 * Password verifier: HMAC-SHA-256 over username + password, keyed by a key derived from DATA_KEY (a pepper held only
 * in Worker secrets). Workers cannot run PBKDF2 above 100,000 iterations, and the free plan allows ~10 ms CPU per
 * request, so a slow hash is not available here. Instead: the verifier is useless without the Worker secret, the
 * password must be 12+ characters and not trivial, and attempts are rate limited per IP and globally.
 */
async function passwordVerifier(cipher: Cipher, username: string, password: string): Promise<string> {
  return cipher.mac(`password:v2:${username}:${password.normalize("NFKC")}`);
}

/**
 * Checks username + password. Installs from before usernames existed only have a passphrase verifier: the first
 * successful login with the old passphrase sets the username and upgrades the verifier.
 */
async function checkPassword(env: Env, cipher: Cipher, usernameRaw: string, password: string): Promise<boolean> {
  const username = normalizeUsername(usernameRaw) ?? "";
  const stored = await getSetting(env.DB, "password_verifier");
  if (stored) {
    const storedUser = (await getSetting(env.DB, "username")) ?? "";
    // Always compute the MAC, so a wrong username takes as long as a wrong password.
    const ok = await cipher.macVerify(`password:v2:${username}:${password.normalize("NFKC")}`, stored);
    return ok && username === storedUser;
  }
  const legacy = await getSetting(env.DB, "passphrase_verifier");
  if (!legacy || !username) return false;
  if (!(await cipher.macVerify(`passphrase:v1:${password.normalize("NFKC")}`, legacy))) return false;
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('username', ?)").bind(username),
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('password_verifier', ?)").bind(await passwordVerifier(cipher, username, password)),
    env.DB.prepare("DELETE FROM settings WHERE key = 'passphrase_verifier'"),
  ]);
  return true;
}

/** For re-checks inside a session: the stored username is used. */
async function checkCurrentPassword(env: Env, cipher: Cipher, password: string): Promise<boolean> {
  const username = (await getSetting(env.DB, "username")) ?? "";
  if (!username) return false;
  return checkPassword(env, cipher, username, password);
}

async function constantTimeEqual(cipher: Cipher, a: string, b: string): Promise<boolean> {
  // Compare MACs of both values, so timing reveals nothing about the secret.
  return cipher.macVerify(`cmp:${a}`, await cipher.mac(`cmp:${b}`));
}

function validateCredentials(usernameRaw: unknown, password: unknown): { username: string; password: string } {
  const username = normalizeUsername(str(usernameRaw, "username", 64));
  if (!username) throw new HttpError(400, "bad_username", "Use 3 to 64 letters, digits, or . _ - @ +");
  const p = str(password, "password", 500);
  const problem = passwordProblem(username, p);
  if (problem) throw new HttpError(400, "weak_password", problem);
  return { username, password: p };
}

/**
 * WebAuthn challenges travel in a signed cookie, so asking for one writes nothing to D1 (no storage to fill, no
 * limit to trip). The cookie is HttpOnly, bound to its purpose, expires in 5 minutes, and is single use: a
 * successful verify records it as used.
 */
async function saveChallenge(cipher: Cipher, challenge: string, purpose: string): Promise<string> {
  const body = toB64url(utf8(JSON.stringify({ c: challenge, p: purpose, e: Date.now() + 5 * 60_000 })));
  return cookie(CHALLENGE_COOKIE, `${body}.${await cipher.mac(`challenge:${body}`)}`, 300);
}

async function takeChallenge(env: Env, cipher: Cipher, req: Request, purpose: string): Promise<{ challenge: string; used: () => Promise<void> }> {
  const raw = readCookie(req, CHALLENGE_COOKIE);
  if (!raw || raw.length > 600) throw new HttpError(400, "no_challenge");
  const [body, mac] = raw.split(".");
  if (!body || !mac || !(await cipher.macVerify(`challenge:${body}`, mac))) throw new HttpError(400, "no_challenge");
  let c: { c: string; p: string; e: number };
  try {
    c = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  } catch {
    throw new HttpError(400, "no_challenge");
  }
  if (c.e < Date.now() || c.p !== purpose) throw new HttpError(400, "challenge_expired");
  const usedKey = `challenge:used:${await sha256b64url(body)}`;
  if (await getSetting(env.DB, usedKey)) throw new HttpError(400, "challenge_expired");
  return {
    challenge: c.c,
    // Housekeeping deletes it once `exp` has passed, like any `challenge:%` key.
    used: () => setSetting(env.DB, usedKey, JSON.stringify({ exp: c.e })),
  };
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
    const needsUsername = setupDone && !(await getSetting(db, "username"));
    return json({ setup_done: setupDone, signed_in: !!s, has_passkey: (pk?.n ?? 0) > 0, needs_username: needsUsername });
  }

  if (path === "/api/auth/setup" && req.method === "POST") {
    if (setupDone) throw new HttpError(409, "already_set_up");
    await rateLimit(env, cipher, req);
    const body = await readJson<{ code?: unknown; username?: unknown; password?: unknown; tz?: unknown; name?: unknown }>(req);
    const code = str(body.code, "code", 200);
    if (!env.SETUP_CODE || env.SETUP_CODE.length < 16) throw new HttpError(500, "setup_code_missing");
    if (!(await constantTimeEqual(cipher, code, env.SETUP_CODE))) throw new HttpError(401, "bad_code");
    const cred = validateCredentials(body.username, body.password);
    const tz = str(body.tz, "tz", 64);
    if (!isValidTimeZone(tz)) throw new HttpError(400, "bad_tz");
    const name = str(body.name, "name", 80, { optional: true }) || "Me";
    const selfId = ulid();
    // Setup must also work on a database where the login was reset by hand (setup_done deleted) but other settings
    // and the "self" person are still there. Plain INSERTs on those keys hit the settings primary key and fail.
    const upsert = "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
    await db.batch([
      db.prepare(upsert).bind("username", cred.username),
      db.prepare(upsert).bind("password_verifier", await passwordVerifier(cipher, cred.username, cred.password)),
      db.prepare("DELETE FROM settings WHERE key = 'passphrase_verifier'"),
      db.prepare(upsert).bind("tz", tz),
      // Keep an existing version; old sessions are dropped below.
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('session_version', '1')"),
      db.prepare("DELETE FROM sessions"),
      // One "self" person only: keep the existing one (and the facts linked to it) on a re-setup.
      db
        .prepare(
          "INSERT INTO people (id, name_enc, aliases_enc, relation, created_at) SELECT ?, ?, ?, 'self', ? WHERE NOT EXISTS (SELECT 1 FROM people WHERE relation = 'self')",
        )
        .bind(
          selfId,
          await cipher.encrypt(name, `people:${selfId}:name`),
          await cipher.encrypt(JSON.stringify(["me"]), `people:${selfId}:aliases`),
          new Date().toISOString(),
        ),
      // Last, and a plain INSERT on purpose: if two setup calls race, the second hits the primary key here and its
      // whole batch (one transaction) rolls back.
      db.prepare("INSERT INTO settings (key, value) VALUES ('setup_done', '1')"),
    ]);
    await clearAttempts(env, cipher, req);
    return json({ ok: true }, 200, { "Set-Cookie": await createSession(env, req) });
  }

  if (!setupDone) throw new HttpError(409, "setup_required");

  if (path === "/api/auth/login" && req.method === "POST") {
    await rateLimit(env, cipher, req);
    const body = await readJson<{ username?: unknown; password?: unknown }>(req);
    const ok = await checkPassword(env, cipher, str(body.username, "username", 64), str(body.password, "password", 500));
    if (!ok) throw new HttpError(401, "bad_credentials");
    await clearAttempts(env, cipher, req);
    return json({ ok: true }, 200, { "Set-Cookie": await createSession(env, req) });
  }

  if (path === "/api/auth/passkey/login/options" && req.method === "POST") {
    const { rpID } = rp(req);
    const opts = await generateAuthenticationOptions({ rpID, userVerification: "required" });
    return json(opts, 200, { "Set-Cookie": await saveChallenge(cipher, opts.challenge, "login") });
  }

  if ((path === "/api/auth/passkey/login/verify" || path === "/api/auth/passkey/reauth/verify") && req.method === "POST") {
    const purpose = path.includes("reauth") ? "reauth" : "login";
    const session = purpose === "reauth" ? await requireSession(env, req) : null;
    await passkeyLimit(env, cipher, req);
    const ch = await takeChallenge(env, cipher, req, purpose);
    const expectedChallenge = ch.challenge;
    const response = await readJson<AuthenticationResponseJSON>(req, 16 * 1024);
    if (typeof response?.id !== "string") throw new HttpError(400, "bad_request");
    const row = await db
      .prepare("SELECT * FROM passkeys WHERE id = ?")
      .bind(response.id)
      .first<{ id: string; public_key: string; counter: number; transports: string | null }>();
    if (!row) {
      await passkeyFailed(env, cipher, req);
      throw new HttpError(401, "bad_credentials");
    }
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
    if (!verified) {
      await passkeyFailed(env, cipher, req);
      throw new HttpError(401, "bad_credentials");
    }
    await ch.used();
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
    return json(opts, 200, { "Set-Cookie": await saveChallenge(cipher, opts.challenge, "reauth") });
  }

  if (path === "/api/auth/reauth" && req.method === "POST") {
    await rateLimit(env, cipher, req);
    const body = await readJson<{ password?: unknown }>(req);
    if (!(await checkCurrentPassword(env, cipher, str(body.password, "password", 500)))) throw new HttpError(401, "bad_credentials");
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
    return json(opts, 200, { "Set-Cookie": await saveChallenge(cipher, opts.challenge, "register") });
  }

  if (path === "/api/auth/passkey/register/verify" && req.method === "POST") {
    requireFresh(session);
    const ch = await takeChallenge(env, cipher, req, "register");
    const expectedChallenge = ch.challenge;
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
    await ch.used();
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

  if (path === "/api/auth/password" && req.method === "POST") {
    requireFresh(session);
    const body = await readJson<{ username?: unknown; password?: unknown }>(req);
    const cred = validateCredentials(body.username ?? (await getSetting(db, "username")) ?? "", body.password);
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('username', ?)").bind(cred.username),
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('password_verifier', ?)").bind(await passwordVerifier(cipher, cred.username, cred.password)),
      db.prepare("DELETE FROM settings WHERE key = 'passphrase_verifier'"),
    ]);
    return json({ ok: true, username: cred.username });
  }

  if (path === "/api/auth/username" && req.method === "GET") {
    return json({ username: await getSetting(db, "username") });
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
