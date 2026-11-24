// Pure cost estimation for model calls. Prices are USD per million tokens (Anthropic first-party list prices,
// checked 2026-11-23). Update here when prices change; old events keep the cost they were logged with.

export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

export function estimateUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export interface UsageRow {
  job: string;
  model: string;
  in?: number;
  out?: number;
  usd?: number | null;
}

export interface UsageSummary {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  usd: number;
  by_job: Record<string, { calls: number; input_tokens: number; output_tokens: number; usd: number; model: string }>;
}

export function summarize(rows: UsageRow[]): UsageSummary {
  const s: UsageSummary = { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0, by_job: {} };
  for (const r of rows) {
    const j = (s.by_job[r.job] ??= { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0, model: r.model });
    const usd = r.usd ?? 0;
    j.calls++;
    j.input_tokens += r.in ?? 0;
    j.output_tokens += r.out ?? 0;
    j.usd += usd;
    s.calls++;
    s.input_tokens += r.in ?? 0;
    s.output_tokens += r.out ?? 0;
    s.usd += usd;
  }
  return s;
}
