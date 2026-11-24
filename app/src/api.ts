// Thin fetch wrapper. Same origin, cookie session, JSON only.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

type ReauthHandler = () => Promise<boolean>;
let onReauth: ReauthHandler | null = null;
let onUnauth: (() => void) | null = null;
export function setAuthHandlers(reauth: ReauthHandler, unauth: () => void) {
  onReauth = reauth;
  onUnauth = unauth;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; raw?: BodyInit; contentType?: string } = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.raw !== undefined) {
    body = init.raw;
    if (init.contentType) headers["Content-Type"] = init.contentType;
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["Content-Type"] = "application/json";
  }
  // Typed loosely: this file is also compiled against the Workers types (tests), whose RequestInit has no `credentials`.
  const req: Record<string, unknown> = { method: init.method ?? (body ? "POST" : "GET"), headers, body, credentials: "same-origin" };
  const res = await fetch(path, req as RequestInit);
  if (res.ok) return (res.headers.get("Content-Type")?.includes("json") ? res.json() : res.text()) as Promise<T>;
  let data: { error?: string; message?: string } = {};
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (res.status === 403 && data.error === "reauth_required" && !retried && onReauth) {
    if (await onReauth()) return api<T>(path, init, true);
  }
  if (res.status === 401 && data.error === "unauthenticated") onUnauth?.();
  throw new ApiError(res.status, data.error ?? "error", data.message);
}

// ---- types shared with the Worker ----

export interface PersonRef {
  id: string;
  name: string;
}
export interface Item {
  id: string;
  kind: string;
  subtype: string | null;
  title: string;
  details: string | null;
  attrs: Record<string, unknown> | null;
  for_person: PersonRef | null;
  requested_by: PersonRef | null;
  window_start: string | null;
  window_end: string | null;
  due_at: string | null;
  status: "open" | "done" | "dropped";
  place_hint: string | null;
  confidence: number | null;
  snoozed_until: string | null;
  recurrence: string | null;
  recurrence_text: string | null;
  status_line: { text: string; tone: "ok" | "warn" | "bad" | "muted" } | null;
  thing: PersonRef | null;
  from_reminder: boolean;
  created_at: string;
  updated_at: string;
}
export interface Because {
  kind?: string;
  ref: string | null;
  text: string;
}
export interface Tip {
  id: string;
  rule: string;
  title: string;
  body: string;
  wording: string | null;
  because: Because[];
  domain: "none" | "health" | "finance" | "legal" | string;
  item_id: string | null;
}
export interface Person {
  id: string;
  name: string;
  aliases: string[];
  relation: string;
}
export interface GapQuestion {
  subject_type: "person" | "me";
  subject_id: string | null;
  subject_name: string;
  key: string;
  question: string;
}
export type CaptureResult =
  | { type: "capture"; item: Item; also?: Item[]; question: GapQuestion | null; duplicate?: boolean; ai_error?: string | null }
  | { type: "answer"; answer: string; items: Item[]; disclaimer?: string | null; advice?: boolean; because?: Because[]; ai_error?: string | null };

// ---- offline capture queue (local storage is only a cache; the server is the source of truth) ----

const QUEUE = "muninn.queue.v1";
interface Queued {
  text: string;
  source: "text" | "voice";
  client_id: string;
  /** When the note was typed, so "tomorrow" keeps its meaning when it is sent later. Missing on notes queued by older versions. */
  captured_at?: string;
}

function readQueue(): Queued[] {
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE) ?? "[]");
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}
function writeQueue(q: Queued[]) {
  try {
    localStorage.setItem(QUEUE, JSON.stringify(q));
  } catch {
    /* storage full or blocked: nothing more we can do here */
  }
}
export function queuedCount() {
  return readQueue().length;
}

/**
 * Whether a failed send should be kept and tried again. Only a request the server can never accept (bad input, too
 * large) is dropped. Signed out (401), rate limited (429), server errors (5xx) and timeouts are temporary.
 */
export function isRetryable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true; // network failure
  return e.status === 401 || e.status === 403 || e.status === 408 || e.status === 429 || e.status >= 500;
}

export async function capture(text: string, source: "text" | "voice"): Promise<CaptureResult | { type: "queued" }> {
  const item: Queued = { text, source, client_id: crypto.randomUUID(), captured_at: new Date().toISOString() };
  try {
    return await api<CaptureResult>("/api/capture", { body: item });
  } catch (e) {
    if (!isRetryable(e)) throw e;
    // Offline, signed out or the server is struggling: keep it and send later.
    writeQueue([...readQueue(), item]);
    return { type: "queued" };
  }
}

let flushing: Promise<number> | null = null;

/** Sends queued notes in order. Stops at the first temporary failure and keeps the rest. One flush at a time. */
export function flushQueue(): Promise<number> {
  flushing ??= (async () => {
    let sent = 0;
    try {
      for (const item of readQueue()) {
        try {
          // client_id makes a resend after a lost response harmless: the server returns the first result.
          await api("/api/capture", { body: item });
          sent++;
        } catch (e) {
          if (isRetryable(e)) break;
          console.warn("queued note rejected", e);
        }
        writeQueue(readQueue().filter((x) => x.client_id !== item.client_id));
      }
    } finally {
      flushing = null;
    }
    return sent;
  })();
  return flushing;
}
