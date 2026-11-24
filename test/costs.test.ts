import { describe, expect, it } from "vitest";
import { estimateUsd, summarize } from "../worker/core/costs";
import { DISCLAIMERS, AdviceSchema } from "../worker/core/schema";

describe("costs", () => {
  it("prices Haiku 5.5 parse calls as in the spec", () => {
    // 600 parses at 2,000 in / 500 out is about $0.27 a month.
    expect(600 * estimateUsd("claude-haiku-5-5", 2000, 500)!).toBeCloseTo(0.27, 2);
  });
  it("returns null for unknown models", () => {
    expect(estimateUsd("mystery", 1, 1)).toBeNull();
  });
  it("summarizes by feature", () => {
    const s = summarize([
      { job: "parse", model: "claude-haiku-5-5", in: 2000, out: 500, usd: 0.00045 },
      { job: "parse", model: "claude-haiku-5-5", in: 1000, out: 100, usd: 0.00015 },
      { job: "embed", model: "@cf/baai/bge-base-en-v1.5", usd: 0 },
    ]);
    expect(s.calls).toBe(3);
    expect(s.by_job.parse.calls).toBe(2);
    expect(s.usd).toBeCloseTo(0.0006, 6);
  });
});

describe("advice disclaimers", () => {
  it("cover every sensitive domain the model can return", () => {
    const domains = AdviceSchema.shape.sensitive_domain.options.filter((d) => d !== "none");
    for (const d of domains) expect(DISCLAIMERS[d as keyof typeof DISCLAIMERS]).toBeTruthy();
  });
});
