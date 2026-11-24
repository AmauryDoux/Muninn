import { estimateUsd } from "../core/costs";
import { ulid } from "./ulid";

/** One event per AI call: which feature, which model, tokens, estimated cost. Workers AI calls log cost 0 (free tier). */
export async function logUsage(
  db: D1Database,
  job: string,
  model: string,
  usage: { input_tokens?: number; output_tokens?: number } = {},
  extra: Record<string, unknown> = {},
): Promise<void> {
  const inT = usage.input_tokens ?? 0;
  const outT = usage.output_tokens ?? 0;
  const usd = model.startsWith("@cf/") ? 0 : estimateUsd(model, inT, outT);
  await db
    .prepare("INSERT INTO events (id, at, type, payload_json) VALUES (?, ?, 'model_usage', ?)")
    .bind(ulid(), new Date().toISOString(), JSON.stringify({ job, model, in: inT, out: outT, usd, ...extra }))
    .run();
}

/**
 * Records a failed AI call so it shows up in Settings (the user may only have a phone, no `wrangler tail`).
 * Keeps only the HTTP status and the first 160 characters of the message: no request body, no key.
 */
export async function logModelError(db: D1Database, job: string, e: unknown): Promise<string> {
  const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : null;
  const raw = e instanceof Error ? e.message : String(e);
  const msg = raw.replace(/sk-ant-[\w-]+/g, "[key]").replace(/\s+/g, " ").slice(0, 160);
  const summary = status ? `${status}: ${msg}` : msg;
  try {
    await db
      .prepare("INSERT INTO events (id, at, type, payload_json) VALUES (?, ?, 'model_error', ?)")
      .bind(ulid(), new Date().toISOString(), JSON.stringify({ job, status, message: msg }))
      .run();
  } catch {
    // Logging must never break the request.
  }
  return summary;
}
