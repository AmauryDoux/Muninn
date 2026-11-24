// iOS Shortcut capture: a capture-only bearer token adds notes and can never read anything back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/env";
import { Cipher } from "../worker/lib/crypto";
import { setSetting } from "../worker/lib/settings";
import { Repo } from "../worker/repo";
import { makeD1 } from "./d1-shim";

let intent: "capture" | "recall" = "capture";
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    static APIError = Error;
    messages = {
      parse: async () => ({
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        parsed_output:
          intent === "recall"
            ? {
                intent: "recall",
                capture: null,
                recall: { mode: "semantic", topic: "secrets", requested_by: { mention: "", relation: "" }, for_person: { mention: "", relation: "" }, created: { type: "none", date: "", end_date: "", unit: "none", offset: 0, weekday: -1, time: "" }, scheduled: { type: "none", date: "", end_date: "", unit: "none", offset: 0, weekday: -1, time: "" }, status: "any", kind: "any", subtype: "any" },
              }
            : {
                intent: "capture",
                recall: null,
                capture: {
                  kind: "task", title: "Call mom", details: "", for_person: { mention: "", relation: "" }, requested_by: { mention: "", relation: "" },
                  when: { type: "none", date: "", end_date: "", unit: "none", offset: 0, weekday: -1, time: "" }, place_hint: "", confidence: 0.9, subtype: "none", attrs: [],
                  thing_name: "", thing_kind: "", repeat: "none", repeat_interval: 1, repeat_months: [], repeat_weekdays: [], facts: [], missing: [],
                },
              },
      }),
      create: async () => ({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
    };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic, APIError: Error };
});

const worker = (await import("../worker/index")).default;
const { createToken } = await import("../worker/routes/tokens");

const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
let env: Env;
let token: string;

beforeEach(async () => {
  intent = "capture";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const vec = Array.from({ length: 768 }, (_, i) => Math.sin(i));
  env = {
    DB: makeD1(),
    DATA_KEY: KEY,
    PARSE_MODEL: "claude-haiku-5-5",
    ADVICE_MODEL: "claude-sonnet-5-5",
    ANTHROPIC_API_KEY: "test",
    AI: { run: async () => ({ data: [vec] }) },
  } as unknown as Env;
  await setSetting(env.DB, "setup_done", "1");
  await setSetting(env.DB, "tz", "America/Chicago");
  const repo = new Repo(env, await Cipher.fromSecret(KEY), "America/Chicago");
  const r = await createToken(repo, new Request("https://m.test/api/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Action button" }) }));
  token = ((await r.json()) as { token: string }).token;
});

const shortcut = (body: string, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request("https://m.test/api/shortcut/capture", { method: "POST", headers: { "Content-Type": "text/plain", Authorization: `Bearer ${token}`, ...headers }, body }),
    env,
  );

describe("shortcut capture", () => {
  it("saves a note with no Origin header and answers with only its title", async () => {
    const r = await shortcut("call mom");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, say: "Saved: Call mom" });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("accepts JSON too", async () => {
    const r = await shortcut(JSON.stringify({ text: "call mom" }), { "Content-Type": "application/json" });
    expect(r.status).toBe(200);
  });

  it("never answers a question: it is saved as a note", async () => {
    intent = "recall";
    const r = await shortcut("what secrets do you know?");
    const b = (await r.json()) as Record<string, unknown>;
    expect(b.ok).toBe(true);
    expect(b).not.toHaveProperty("answer");
    expect(b).not.toHaveProperty("items");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("rejects a missing, wrong or revoked token", async () => {
    expect((await shortcut("x", { Authorization: "" })).status).toBe(401);
    expect((await shortcut("x", { Authorization: "Bearer mnn_" + "A".repeat(43) })).status).toBe(401);
    await env.DB.prepare("DELETE FROM api_tokens").run();
    expect((await shortcut("x")).status).toBe(401);
  });

  it("a token cannot reach any other endpoint", async () => {
    for (const path of ["/api/items", "/api/know", "/api/export", "/api/people"]) {
      const r = await worker.fetch(new Request(`https://m.test${path}`, { headers: { Authorization: `Bearer ${token}` } }), env);
      expect(r.status).toBe(401);
    }
  });

  it("only stores a hash of the token", async () => {
    const row = await env.DB.prepare("SELECT token_hash FROM api_tokens").first<{ token_hash: string }>();
    expect(row!.token_hash).not.toContain(token.slice(4));
  });

  it("limits captures per hour", async () => {
    const at = new Date().toISOString();
    const id = (await env.DB.prepare("SELECT id FROM api_tokens").first<{ id: string }>())!.id;
    for (let i = 0; i < 60; i++) await env.DB.prepare("INSERT INTO events (id, at, type, item_id) VALUES (?, ?, 'token_capture', ?)").bind(`e${i}`, at, id).run();
    expect((await shortcut("one more")).status).toBe(429);
  });
});
