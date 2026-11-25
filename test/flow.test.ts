// End-to-end through the capture box with a simulated model: tell, ask, advice, and failures.
// The fake client checks each request the way the API would (schema limits, thinking settings)
// and answers with JSON shaped like the real structured output.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/env";
import { Cipher } from "../worker/lib/crypto";
import { Repo } from "../worker/repo";
import { GRAMMAR_BUDGET, grammarSize, SCHEMA_LIMITS, schemaComplexity } from "../worker/core/wire";
import { makeD1 } from "./d1-shim";

type Req = { model: string; max_tokens: number; system?: string; thinking?: { type: string }; output_config?: { format?: { schema: unknown } }; messages: { content: string }[] };
const calls: Req[] = [];
let reply: (r: Req) => unknown = () => null;
// Lower it to make the fake API refuse bigger schemas, like the real one's unpublished grammar limit.
let grammarLimitChars = Infinity;

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
        if (r.output_config?.format) {
          const g = grammarSize(r.output_config.format.schema);
          if (g.chars > GRAMMAR_BUDGET.chars || g.enumValues > GRAMMAR_BUDGET.enumValues || g.objects > GRAMMAR_BUDGET.objects || g.chars > grammarLimitChars)
            throw new APIError(400, "The compiled grammar is too large, which would cause performance issues.");
        }
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

const { handleCapture, relatedOpenItems, revertUpdate } = await import("../worker/routes/capture");

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
    thing_name: "", thing_kind: "", repeat: "none", repeat_interval: 1, repeat_months: [], repeat_weekdays: [], facts: [], missing: [], update: "", update_done: false, also: [],
    ...c,
  },
});

beforeEach(async () => {
  calls.length = 0;
  grammarLimitChars = Infinity;
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

  it("remind me in 5 minutes gets a due time, not Anytime", async () => {
    reply = () => capture({ kind: "task", title: "Check the oven", when: { ...noTime, type: "relative", unit: "minute", offset: 5 } });
    const before = Date.now();
    const b = await send("remind me to check the oven in 5 minutes");
    const due = Date.parse(b.item.due_at);
    expect(due).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
    expect(due).toBeLessThanOrEqual(Date.now() + 6 * 60_000);
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
        return { intent: "recall", capture: null, recall: { mode: "filter", requested_by: "", for_person: "Emma", created: noTime, scheduled: noTime, status: "open", kind: "any", subtype: "gift_idea", topic: "" } };
      }
      const ids = [...r.messages[0].content.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
      return { answer: "Emma wants the blue Lego set.", cited_ids: ids };
    };
    const before = calls.length;
    const b = await send("what gift ideas do I have for Emma?");
    expect(b.type).toBe("answer");
    // A question costs two small parse calls: the capture schema (which has no recall object), then the recall one.
    const parses = calls.slice(before).filter((c) => c.system?.startsWith("You turn"));
    expect(parses).toHaveLength(2);
    expect(Object.keys((parses[0].output_config!.format!.schema as { properties: object }).properties)).toEqual(["intent", "capture"]);
    expect(parses[1].system).toMatch(/^You turn one question/);
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

describe("AI budget", () => {
  it("past the monthly budget, a note is still saved, without calling the model", async () => {
    await repo.db.prepare("INSERT INTO settings (key, value) VALUES ('ai_budget_usd', '0.10')").run();
    await repo.db
      .prepare("INSERT INTO events (id, at, type, payload_json) VALUES ('u1', ?, 'model_usage', ?)")
      .bind(new Date().toISOString(), JSON.stringify({ job: "parse", usd: 0.11 }))
      .run();
    const b = await send("buy milk");
    expect(calls).toHaveLength(0);
    expect(b.type).toBe("capture");
    expect(b.item.title).toBe("buy milk");
    expect(b.ai_error).toMatch(/budget/);
  });
});

describe("several to-dos in one note", () => {
  it("each becomes its own item, with its own date and person", async () => {
    reply = () =>
      capture({
        kind: "task",
        title: "Buy milk",
        also: [
          { title: "Call mom", who: "mom", date: "2099-03-11", time: "" },
          { title: "Book the dentist", who: "", date: "", time: "" },
        ],
      });
    const b = await send("buy milk, call mom tomorrow and book the dentist");
    expect(b.item.title).toBe("Buy milk");
    expect(b.also.map((i: { title: string }) => i.title)).toEqual(["Call mom", "Book the dentist"]);
    expect(b.also[0].for_person.name).toBe("Mom");
    expect(b.also[0].window_start).toBeTruthy();
    const n = await repo.db.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
    expect(n!.n).toBe(3);
  });
});

describe("when the parser fails", () => {
  const grammarError = () => Object.assign(new Error("The compiled grammar is too large"), { status: 400 });
  it("a question is answered from the open list, not saved as a to-do", async () => {
    reply = () => capture({ kind: "task", title: "Pick up prescription", when: { ...noTime, type: "relative", unit: "day", offset: 0 } });
    await send("pick up prescription today");
    reply = (r) => (r.system?.startsWith("You turn") || r.system?.startsWith("You read") ? grammarError() : { answer: "Pick up your prescription.", cited_ids: [...r.messages[0].content.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]) });
    for (const q of ["What have I got to do today", "Have I got any upcoming things on my calendar?"]) {
      const b = await send(q);
      expect(b.type).toBe("answer");
      expect(b.ai_error).toBeTruthy();
    }
    const n = await repo.db.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
    expect(n!.n).toBe(1);
  });
  it("a note is still saved as-is", async () => {
    reply = () => grammarError();
    const b = await send("buy milk");
    expect(b.type).toBe("capture");
    expect(b.item.title).toBe("buy milk");
    expect(b.ai_error).toBeTruthy();
  });
});

describe("a note about an existing item updates it", () => {
  const count = async () => (await repo.db.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>())!.n;
  const details = async (id: string) => repo.cipher.decryptNullable((await repo.getItemRow(id))!.details_enc, `items:${id}:details`);
  const revert = async (captureId: string, asNew: boolean) =>
    (await revertUpdate(repo, new Request("https://m.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ as_new: asNew }) }), captureId, TZ)).json() as Promise<Record<string, any>>;
  let giftId = "";
  beforeEach(async () => {
    reply = () => capture({ kind: "task", title: "Gift for wife's birthday", for_person: { mention: "wife", relation: "wife" }, when: { ...noTime, type: "date", date: "2099-12-01" } });
    giftId = (await send("find a gift for my wife's birthday on 1 Dec")).item.id;
  });

  it("offers open items to the model and adds the note to the one it picks", async () => {
    let offered = "";
    reply = (r) => {
      offered = r.messages[0].content;
      return capture({ kind: "note", title: "Bought necklace", update: "1" });
    };
    const b = await send("bought her the silver necklace for the birthday");
    expect(offered).toMatch(/Open items that may be related.*"ref":"1","title":"Gift for wife's birthday"/);
    expect(b.updated).toEqual({ item_id: giftId, done: false });
    expect(b.item.id).toBe(giftId);
    expect(b.item.status).toBe("open");
    expect(await details(giftId)).toMatch(/: bought her the silver necklace/);
    expect(await count()).toBe(1);
  });

  it("closes the item when the note says it is finished", async () => {
    reply = () => capture({ kind: "note", title: "Gift done", update: "1", update_done: true });
    const b = await send("wife's gift is sorted, wrapped and hidden");
    expect(b.item.status).toBe("done");
  });

  it("an unrelated note makes a new item, even when the model is offered the open ones", async () => {
    reply = () => capture({ kind: "task", title: "Buy milk", update: "" });
    const b = await send("buy milk");
    expect(b.updated).toBeNull();
    expect(b.item.id).not.toBe(giftId);
    expect(await details(giftId)).toBeNull();
    expect(await count()).toBe(2);
  });

  it("a ref that was not offered is ignored", async () => {
    reply = () => capture({ kind: "task", title: "Call the bank", update: "7" });
    const b = await send("call the bank");
    expect(b.updated).toBeNull();
    expect(await count()).toBe(2);
  });

  it("done items are not offered", async () => {
    await repo.db.prepare("UPDATE items SET status = 'done'").run();
    let offered = "";
    reply = (r) => ((offered = r.messages[0].content), capture({ title: "x", update: "1" }));
    const b = await send("bought the necklace for the birthday");
    expect(offered).toContain("Open items that may be related (ref, title, when, for): []");
    expect(b.updated).toBeNull();
  });

  it("undo puts the item back; 'make it a new item' also creates one from the same parse", async () => {
    reply = () => capture({ kind: "note", title: "Bought necklace", update: "1", update_done: true });
    const first = await send("bought the necklace");
    const undone = await revert(first.capture_id, false);
    expect(undone.item).toMatchObject({ id: giftId, status: "open" });
    expect(await details(giftId)).toBeNull();
    expect(await count()).toBe(1);
    await expect(revert(first.capture_id, false)).rejects.toThrow();

    const second = await send("bought the necklace");
    const calls0 = calls.length;
    const made = await revert(second.capture_id, true);
    expect(calls.length).toBe(calls0); // no second model call
    expect(made.item.title).toBe("Bought necklace");
    expect(made.item.id).not.toBe(giftId);
    expect(await count()).toBe(2);
    expect((await repo.getItemRow(giftId))!.status).toBe("open");
  });

  it("without an embedding, titles sharing a meaningful word are still offered", async () => {
    expect((await relatedOpenItems(repo, "got the birthday present", null)).map((r) => r.row.id)).toEqual([giftId]);
    expect(await relatedOpenItems(repo, "buy milk", null)).toEqual([]);
    expect(await relatedOpenItems(repo, "what about this", null)).toEqual([]);
  });

  it("a capture-only key (Shortcuts) never updates", async () => {
    reply = () => capture({ kind: "note", title: "Bought necklace", update: "1" });
    const b = await (await handleCapture(repo, req("bought the necklace"), TZ, { captureOnly: true })).json() as Record<string, any>;
    expect(b.updated).toBeNull();
    expect(await count()).toBe(2);
  });
});

describe("when the API refuses the capture schema itself", () => {
  it("the note is still read, with the tiny schema, and the error is recorded", async () => {
    grammarLimitChars = 1500;
    reply = (r) => (r.system?.startsWith("You read one short note") ? { intent: "capture", kind: "task", title: "Dentist", date: "2099-03-11", time: "15:00" } : grammarLimitChars);
    const b = await send("dentist on 11 March 2099 at 3pm");
    expect(b.ai_error).toBeNull();
    expect(b.item).toMatchObject({ title: "Dentist", kind: "task" });
    expect(b.item.due_at).toBeTruthy();
    const err = await repo.db.prepare("SELECT payload_json FROM events WHERE type = 'model_error'").first<{ payload_json: string }>();
    expect(err?.payload_json).toMatch(/grammar/);
  });
  it("a question still gets answered", async () => {
    grammarLimitChars = 1500;
    reply = (r) =>
      r.system?.startsWith("You read one short note")
        ? { intent: "recall", kind: "note", title: "", date: "", time: "" }
        : r.system?.startsWith("You turn one question")
          ? { recall: { mode: "filter", requested_by: "", for_person: "", created: noTime, scheduled: noTime, status: "open", kind: "any", subtype: "any", topic: "" } }
          : { answer: "Nothing yet.", cited_ids: [] };
    const b = await send("what do I have to do?");
    expect(b.type).toBe("answer");
  });
});
