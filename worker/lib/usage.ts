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
