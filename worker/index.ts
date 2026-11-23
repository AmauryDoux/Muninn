import type { Env } from "./env";
import { handleAuth, requireFresh, requireSession } from "./auth";
import { Cipher } from "./lib/crypto";
import { HttpError, errorResponse, json } from "./lib/http";
import { getSettingsMap, reminderSettings } from "./lib/settings";
import { Repo } from "./repo";
import { handleCapture } from "./routes/capture";
import { actOnItem, deleteItem, getItem, listItems, patchItem } from "./routes/items";
import {
  exportAll,
  getBrief,
  getSettings,
  listDevices,
  deleteDevice,
  putSettings,
  subscribePush,
  testPush,
  transcribeAudio,
  unsubscribePush,
} from "./routes/misc";
import { addFact, createPerson, deleteFact, deletePerson, knowledge, listPeople, patchFact, patchPattern, patchPerson } from "./routes/profile";
import { runScheduled } from "./scheduled";

let cipherCache: { key: string; cipher: Promise<Cipher> } | null = null;
function getCipher(env: Env): Promise<Cipher> {
  if (!cipherCache || cipherCache.key !== env.DATA_KEY) cipherCache = { key: env.DATA_KEY, cipher: Cipher.fromSecret(env.DATA_KEY) };
  return cipherCache.cipher;
}

const ID = "([0-9A-Z]{26})";

async function api(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = req.method;

  // CSRF defence in depth (cookies are already SameSite=Strict): state-changing calls must come from our own origin.
  if (m !== "GET" && m !== "HEAD") {
    const origin = req.headers.get("Origin");
    if (origin !== url.origin) throw new HttpError(403, "bad_origin");
  }

  const cipher = await getCipher(env);
  if (path.startsWith("/api/auth/")) {
    const r = await handleAuth(env, req, path, cipher);
    if (r) return r;
    throw new HttpError(404, "not_found");
  }

  const session = await requireSession(env, req);
  const repo = new Repo(env, cipher);
  const rs = reminderSettings(await getSettingsMap(env.DB));
  let mm: RegExpMatchArray | null;

  if (path === "/api/capture" && m === "POST") return handleCapture(repo, req, rs.tz);
  if (path === "/api/transcribe" && m === "POST") return transcribeAudio(repo, req);
  if (path === "/api/items" && m === "GET") return listItems(repo, url);
  if ((mm = path.match(new RegExp(`^/api/items/${ID}$`)))) {
    if (m === "GET") return getItem(repo, mm[1]);
    if (m === "PATCH") return patchItem(repo, req, mm[1], rs.tz);
    if (m === "DELETE") {
      requireFresh(session);
      return deleteItem(repo, mm[1]);
    }
  }
  if ((mm = path.match(new RegExp(`^/api/items/${ID}/act$`))) && m === "POST") return actOnItem(repo, req, mm[1], rs);
  if (path === "/api/brief" && m === "GET") return getBrief(repo, rs);

  if (path === "/api/people" && m === "GET") return listPeople(repo);
  if (path === "/api/people" && m === "POST") return createPerson(repo, req);
  if ((mm = path.match(new RegExp(`^/api/people/${ID}$`)))) {
    if (m === "PATCH") return patchPerson(repo, req, mm[1]);
    if (m === "DELETE") {
      requireFresh(session);
      return deletePerson(repo, mm[1]);
    }
  }
  if (path === "/api/facts" && m === "POST") return addFact(repo, req);

  // "What I know about you" and everything that edits it need a fresh passkey/passphrase check.
  if (path === "/api/know" && m === "GET") {
    requireFresh(session);
    return knowledge(repo);
  }
  if ((mm = path.match(new RegExp(`^/api/facts/${ID}$`)))) {
    requireFresh(session);
    if (m === "PATCH") return patchFact(repo, req, mm[1]);
    if (m === "DELETE") return deleteFact(repo, mm[1]);
  }
  if ((mm = path.match(new RegExp(`^/api/patterns/${ID}$`))) && m === "PATCH") {
    requireFresh(session);
    return patchPattern(repo, req, mm[1]);
  }
  if (path === "/api/export" && m === "GET") {
    requireFresh(session);
    return exportAll(repo);
  }

  if (path === "/api/push/subscribe" && m === "POST") return subscribePush(repo, req);
  if (path === "/api/push/unsubscribe" && m === "POST") return unsubscribePush(repo, req);
  if (path === "/api/push/test" && m === "POST") return testPush(repo);
  if (path === "/api/devices" && m === "GET") return listDevices(repo);
  if ((mm = path.match(new RegExp(`^/api/devices/${ID}$`))) && m === "DELETE") return deleteDevice(repo, mm[1]);
  if (path === "/api/settings" && m === "GET") return getSettings(repo);
  if (path === "/api/settings" && m === "PUT") return putSettings(repo, req);

  throw new HttpError(404, "not_found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(req, env);
      } catch (e) {
        return errorResponse(e);
      }
    }
    // Static assets are normally served before the Worker runs; this is the fallback.
    return env.ASSETS.fetch(req);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env).catch((e) => console.error("cron failed", e instanceof Error ? e.stack : e)));
  },
} satisfies ExportedHandler<Env>;

export { json };
