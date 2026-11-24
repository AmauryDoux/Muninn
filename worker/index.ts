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
  getHealth,
  getUsage,
  listDevices,
  deleteDevice,
  putSettings,
  subscribePush,
  testPush,
  transcribeAudio,
  unsubscribePush,
} from "./routes/misc";
import { addFact, createPerson, deleteFact, deletePerson, knowledge, listPeople, mergePerson, patchFact, patchPattern, patchPerson } from "./routes/profile";
import {
  addSeasonalStarter,
  createLifeItem,
  createThingRoute,
  deleteThing,
  getThing,
  getTips,
  ideasDigest,
  lifeSummary,
  listLifeItems,
  listThings,
  patchLifeItem,
  patchThing,
  postTip,
  upcoming,
} from "./routes/life";
import { runScheduled } from "./scheduled";
import { getReview } from "./routes/review";
import { deleteFile, getFile, listFiles, uploadFile } from "./routes/files";
import { calendarFeed, createToken, deleteToken, listTokens, shortcutArrive, shortcutCapture } from "./routes/tokens";

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

  // iOS Shortcuts: bearer token, capture only, no cookie read. Shortcuts send no Origin, so this one path is checked
  // before the Origin rule below; it never uses the session cookie, so it is not a CSRF target.
  if (path === "/api/shortcut/capture") {
    if (m !== "POST") throw new HttpError(405, "method_not_allowed");
    return shortcutCapture(env, req, await getCipher(env));
  }
  if (path === "/api/shortcut/arrive") {
    if (m !== "POST") throw new HttpError(405, "method_not_allowed");
    return shortcutArrive(env, req, await getCipher(env));
  }

  // Calendar subscription: read-only, token in the URL (calendar apps can't send headers).
  const cal = path.match(/^\/api\/calendar\/(mnn_[A-Za-z0-9_-]{20,80})\.ics$/);
  if (cal && (m === "GET" || m === "HEAD")) return calendarFeed(env, req, await getCipher(env), cal[1]);

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
  const rs = reminderSettings(await getSettingsMap(env.DB));
  const repo = new Repo(env, cipher, rs.tz);
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
  if ((mm = path.match(new RegExp(`^/api/items/${ID}/files$`)))) {
    if (m === "GET") return listFiles(repo, mm[1]);
    if (m === "POST") return uploadFile(repo, req, mm[1]);
  }
  if ((mm = path.match(new RegExp(`^/api/files/${ID}$`)))) {
    if (m === "GET") return getFile(repo, mm[1]);
    if (m === "DELETE") {
      requireFresh(session);
      return deleteFile(repo, mm[1]);
    }
  }
  if (path === "/api/brief" && m === "GET") return getBrief(repo, rs);

  if (path === "/api/people" && m === "GET") return listPeople(repo);
  if (path === "/api/people" && m === "POST") return createPerson(repo, req);
  if ((mm = path.match(new RegExp(`^/api/people/${ID}$`)))) {
    if (m === "PATCH") return patchPerson(repo, req, mm[1]);
    if (m === "DELETE") {
      requireFresh(session);
      return deletePerson(repo, mm[1], rs.tz);
    }
  }
  if ((mm = path.match(new RegExp(`^/api/people/${ID}/merge$`))) && m === "POST") return mergePerson(repo, req, mm[1], rs.tz);
  if (path === "/api/facts" && m === "POST") return addFact(repo, req, rs.tz);

  // Life: categories, dates, things, tips, digest.
  if (path === "/api/life" && m === "GET") return lifeSummary(repo, rs.tz);
  if (path === "/api/life/items" && m === "GET") return listLifeItems(repo, url);
  if (path === "/api/life/items" && m === "POST") return createLifeItem(repo, req, rs.tz);
  if ((mm = path.match(new RegExp(`^/api/life/items/${ID}$`))) && m === "PATCH") return patchLifeItem(repo, req, mm[1], rs.tz);
  if (path === "/api/life/seasonal-starter" && m === "POST") return addSeasonalStarter(repo, rs.tz);
  if (path === "/api/dates" && m === "GET") return upcoming(repo, url, rs.tz);
  if (path === "/api/things" && m === "GET") return listThings(repo);
  if (path === "/api/things" && m === "POST") return createThingRoute(repo, req);
  if ((mm = path.match(new RegExp(`^/api/things/${ID}$`)))) {
    if (m === "GET") return getThing(repo, mm[1]);
    if (m === "PATCH") return patchThing(repo, req, mm[1]);
    if (m === "DELETE") {
      requireFresh(session);
      return deleteThing(repo, mm[1]);
    }
  }
  if (path === "/api/tips" && m === "GET") return getTips(repo, rs.tz);
  if ((mm = path.match(new RegExp(`^/api/tips/${ID}$`))) && m === "POST") return postTip(repo, req, mm[1]);
  if (path === "/api/digest" && m === "GET") return ideasDigest(repo, url, rs.tz);
  if (path === "/api/review" && m === "GET") return getReview(repo, rs.tz);

  // "What I know about you" and everything that edits it need a fresh passkey/password check.
  if (path === "/api/know" && m === "GET") {
    requireFresh(session);
    return knowledge(repo);
  }
  if ((mm = path.match(new RegExp(`^/api/facts/${ID}$`)))) {
    requireFresh(session);
    if (m === "PATCH") return patchFact(repo, req, mm[1], rs.tz);
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

  // Capture tokens: creating one hands out a credential, so it needs a fresh Face ID or password check.
  if (path === "/api/tokens" && m === "GET") return listTokens(repo);
  if (path === "/api/tokens" && m === "POST") {
    requireFresh(session);
    return createToken(repo, req);
  }
  if ((mm = path.match(new RegExp(`^/api/tokens/${ID}$`))) && m === "DELETE") return deleteToken(repo, mm[1]);

  // Pushes can carry item titles, so adding a device that receives them needs a fresh Face ID or password check:
  // otherwise a stolen session could subscribe its own browser and read your reminders.
  if (path === "/api/push/subscribe" && m === "POST") {
    requireFresh(session);
    return subscribePush(repo, req);
  }
  if (path === "/api/push/unsubscribe" && m === "POST") return unsubscribePush(repo, req);
  if (path === "/api/push/test" && m === "POST") return testPush(repo);
  if (path === "/api/devices" && m === "GET") return listDevices(repo);
  if ((mm = path.match(new RegExp(`^/api/devices/${ID}$`))) && m === "DELETE") return deleteDevice(repo, mm[1]);
  if (path === "/api/usage" && m === "GET") return getUsage(repo, url);
  if (path === "/api/health" && m === "GET") return getHealth(repo);
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
