// End-to-end through the capture box with a simulated model: tell, ask, advice, and failures.
// The fake client checks each request the way the API would (schema limits, thinking settings)
// and answers with JSON shaped like the real structured output.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/env";
import { Cipher } from "../worker/lib/crypto";
import { Repo } from "../worker/repo";
import { SCHEMA_LIMITS, schemaComplexity } from "../worker/core/wire";
import { makeD1 } from "./d1-shim";

type Req = { model: string; max_tokens: number; system?: string; thinking?: { type: string }; output_config?: { format?: { schema: unknown } }; messages: { content: string }[] };
const calls: Req[] = [];
let reply: (r: Req) => unknown = () => null;

vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  class FakeAnthropic {
    static APIError = APIError;
    messages = {
      parse: async (r: Req) => {
        calls.push(r);
        const c = r.output_config?.format ? schemaComplexity(r.output_config.format.schema) : { unions: 0, optional: 0 };
        if (c.unions > SCHEMA_LIMITS.unions || c.optional > SCHEMA_LIMITS.optional) throw new APIError(400, "Schema is too complex for compilation.");
        if (r.model.startsWith("claude-haiku") && r.thinking?.type !== "disabled") throw new Error("test: Haiku calls should disable thinking");
        if (r.model.startsWith("claude-sonnet-5-5") && r.thinking?.type === "disabled") throw new APIError(400, "thinking disabled is not supported");
        const out = reply(r);
        if (out instanceof Error) throw out;
        return { stop_reason: "end_turn", parsed_output: out, usage: { input_tokens: 100, output_tokens: 50 } };
      },
      create: async (r: Req) => {
        calls.push(r);
        return { stop_reason: "end_turn", content: [{ type: "text", text: "Two things today." }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic, APIError };
});

const { handleCapture } = await import("../worker/routes/capture");

const TZ = "America/Chicago";
const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
let repo: Repo;
const req = (text: string) => new Request("https://m.test/api/capture", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://m.test" }, body: JSON.stringify({ text }) });
const send = async (text: string) => (await handleCapture(repo, req(text), TZ)).json() as Promise<Record<string, any>>;

const none = { mention: "", relation: "" };
const noTime = { type: "none", date: "", end_date: "", unit: "none", offset: 0, weekday: -1, time: "" };
const capture = (c: Record<string, unknown>) => ({
  intent: "capture",
  recall: null,
  capture: {
    kind: "note", title: "", details: "", for_person: none, requested_by: none, when: noTime, place_hint: "", confidence: 0.9, subtype: "none", attrs: [],
    thing_name: "", thing_kind: "", repeat: "none", repeat_interval: 1, repeat_months: [], repeat_weekdays: [], facts: [], missing: [],
    ...c,
  },
});

beforeEach(async () => {
  calls.length = 0;
  const vec = Array.from({ length: 768 }, (_, i) => Math.sin(i));
  const env = {
    DB: makeD1(),
    PARSE_MODEL: "claude-haiku-5-5",
    ADVICE_MODEL: "claude-sonnet-5-5",
    EMBED_MODEL: "@cf/baai/bge-base-en-v1.5",
    ANTHROPIC_API_KEY: "test",
    AI: { run: async () => ({ data: [vec] }) },
  } as unknown as Env;
  repo = new Repo(env, await Cipher.fromSecret(KEY), TZ);
});

describe("tell", () => {
  it("a gift idea becomes a gift_idea item for Emma, with its price, and her birthday is stored", async () => {
    reply = () =>
      capture({
        title: "Blue Lego set", subtype: "gift_idea", for_person: { mention: "Emma", relation: "daughter" }, attrs: [{ key: "price", value: "40 USD" }],
        facts: [{ subject: { mention: "Emma", relation: "daughter" }, about_thing: false, key: "birthday", value: "--03-03" }],
      });
    const b = await send("Emma wants the blue Lego set, about 40 dollars. Her birthday is March 3");
    expect(b.ai_error).toBeNull();
    expect(b.item).toMatchObject({ title: "Blue Lego set", subtype: "gift_idea", for_person: { name: "Emma" } });
    expect(b.item.attrs.price).toBeTruthy();
    const trig = await repo.db.prepare("SELECT kind FROM triggers WHERE active = 1 ORDER BY kind").all<{ kind: string }>();
    expect(trig.results.map((t) => t.kind)).toEqual(["birthday_0", "birthday_1"]);
    expect(calls[0]).toMatchObject({ model: "claude-haiku-5-5", thinking: { type: "disabled" } });
  });

  it("a repeating chore with a thing gets a recurrence and the thing", async () => {
    reply = () => capture({ kind: "task", title: "Change AC filter", thing_name: "AC", thing_kind: "appliance", repeat: "monthly", repeat_interval: 3 });
    const b = await send("change the AC filter every 3 months");
    expect(b.item.recurrence).toBe("FREQ=MONTHLY;INTERVAL=3");
    expect(b.item.thing?.name).toBe("AC");
    expect(b.item.due_start ?? b.item.window_start).toBeTruthy();
  });

  it("a dated task resolves the date in code", async () => {
    reply = () => capture({ kind: "task", title: "Dentist", when: { ...noTime, type: "relative", unit: "day", offset: 1, time: "15:00" } });
    const b = await send("dentist tomorrow 3pm");
    expect(b.item.kind).toBe("task");
    expect(b.item.due_at).toBeTruthy();
  });
});

describe("ask", () => {
  it("recall by category answers from saved items and cites them", async () => {
    reply = () => capture({ title: "Blue Lego set", subtype: "gift_idea", for_person: { mention: "Emma", relation: "daughter" } });
    await send("Emma wants the blue Lego set");
    reply = (r) => {
      if (r.system?.startsWith("You turn")) {
        return { intent: "recall", capture: null, recall: { mode: "filter", requested_by: none, for_person: { mention: "Emma", relation: "" }, created: noTime, scheduled: noTime, status: "open", kind: "any", subtype: "gift_idea", topic: "" } };
      }
      const ids = [...r.messages[0].content.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
      return { answer: "Emma wants the blue Lego set.", cited_ids: ids };
    };
    const b = await send("what gift ideas do I have for Emma?");
    expect(b.type).toBe("answer");
    expect(b.answer).toContain("Lego");
    expect(b.items).toHaveLength(1);
  });
});

describe("advice", () => {
  it("uses Sonnet with thinking left on, and cites a saved gift idea", async () => {
    reply = () => capture({ title: "Blue Lego set", subtype: "gift_idea", for_person: { mention: "Emma", relation: "daughter" } });
    const saved = await send("Emma wants the blue Lego set");
    reply = (r) => {
      if (r.system?.startsWith("You turn")) return { intent: "advice", capture: null, recall: null };
      return { answer: "Get her the blue Lego set you noted.", cited_ids: [saved.item.id], sensitive_domain: "none" };
    };
    const b = await send("what should I get Emma for her birthday?");
    expect(b.answer).toContain("Lego");
    expect(b.because?.[0]?.text).toContain("Blue Lego set");
    const adv = calls.find((c) => c.model === "claude-sonnet-5-5")!;
    expect(adv.thinking).toBeUndefined();
    expect(adv.max_tokens).toBeGreaterThanOrEqual(8000);
  });

  it("falls back to the parse model when the advice model errors", async () => {
    reply = (r) => {
      if (r.system?.startsWith("You turn")) return { intent: "advice", capture: null, recall: null };
      if (r.model === "claude-sonnet-5-5") return Object.assign(new Error("overloaded"), { status: 529 });
      return { answer: "Check the label for the dose.", cited_ids: [], sensitive_domain: "health" };
    };
    const b = await send("how much ibuprofen can I take?");
    expect(b.answer).toContain("label");
    expect(b.disclaimer).toMatch(/not medical advice/i);
  });

  it("both models failing gives a message, not a crash", async () => {
    reply = (r) => (r.system?.startsWith("You turn") ? { intent: "advice", capture: null, recall: null } : Object.assign(new Error("down"), { status: 500 }));
    const b = await send("how often should I service the boiler?");
    expect(b.type).toBe("answer");
    expect(b.ai_error).toContain("500");
  });
});

describe("notes sent late from the offline queue", () => {
  it("'tomorrow' counts from when the note was typed, not when it arrived", async () => {
    reply = () => capture({ kind: "task", title: "Call mom", when: { ...noTime, type: "relative", unit: "day", offset: 1 } });
    const typed = new Date(Date.now() - 2 * 86400_000);
    const r = new Request("https://m.test/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://m.test" },
      body: JSON.stringify({ text: "call mom tomorrow", client_id: "q1", captured_at: typed.toISOString() }),
    });
    const b = (await (await handleCapture(repo, r, TZ)).json()) as Record<string, any>;
    const start = new Date(b.item.window_start).getTime();
    // The day after it was typed: about a day after `typed`, so already in the past now.
    expect(start).toBeGreaterThan(typed.getTime());
    expect(start).toBeLessThan(Date.now() - 12 * 3600_000);
    expect(b.item.created_at).toBe(typed.toISOString());
  });

  it("bounds the capture time", async () => {
    const { captureTime } = await import("../worker/routes/capture");
    const now = new Date("2026-11-24T12:00:00Z");
    expect(captureTime(undefined, now)).toEqual(now);
    expect(captureTime("garbage", now)).toEqual(now);
    expect(captureTime("2026-11-25T12:00:00Z", now)).toEqual(now); // future
    expect(captureTime("2026-11-24T11:58:00Z", now).toISOString()).toBe("2026-11-24T11:58:00.000Z");
    expect(captureTime("2026-01-01T00:00:00Z", now).toISOString()).toBe("2026-11-10T12:00:00.000Z"); // 14 days max
  });
});
