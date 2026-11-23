export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  new Headers(extra).forEach((v, k) => headers.append(k, v));
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
  // Never leak internals to the client; details go to Workers logs.
  console.error("unhandled", e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : e);
  return json({ error: "internal" }, 500);
}

const MAX_BODY = 64 * 1024;

export async function readJson<T = unknown>(req: Request, max = MAX_BODY): Promise<T> {
  const ct = req.headers.get("Content-Type") ?? "";
  if (!ct.startsWith("application/json")) throw new HttpError(415, "json_required");
  const len = Number(req.headers.get("Content-Length") ?? "0");
  if (len > max) throw new HttpError(413, "too_large");
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "too_large");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

export function str(v: unknown, field: string, max = 2000, { optional = false } = {}): string {
  if (v == null && optional) return "";
  if (typeof v !== "string") throw new HttpError(400, "bad_request", `${field} must be a string`);
  if (v.length > max) throw new HttpError(400, "bad_request", `${field} is too long`);
  return v;
}

export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "unknown";
}
