// Weekly review: code picks the items; the summary falls back to code text when the AI is unavailable.
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/env";
import { Cipher } from "../worker/lib/crypto";
import { Repo } from "../worker/repo";
import { buildReview, codeSummary, weekStart } from "../worker/routes/review";
import { makeD1 } from "./d1-shim";

const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

describe("weekly review", () => {
  it("starts the week on Monday, local time", () => {
    // Sunday 29 Nov 2026, 20:00 in Chicago is Monday 02:00 UTC.
    expect(weekStart(new Date("2026-11-30T02:00:00Z"), "America/Chicago").toISOString()).toBe("2026-11-23T06:00:00.000Z");
    expect(weekStart(new Date("2026-11-23T06:00:00Z"), "America/Chicago").toISOString()).toBe("2026-11-23T06:00:00.000Z");
  });

  it("counts done, slipped and coming items", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { DB: makeD1(), PARSE_MODEL: "claude-haiku-5-5", ANTHROPIC_API_KEY: "" } as unknown as Env;
    const cipher = await Cipher.fromSecret(KEY);
    const repo = new Repo(env, cipher, "UTC");
    const now = new Date("2026-11-29T18:00:00Z");
    const add = async (id: string, status: string, start: string | null, end: string | null) =>
      env.DB.prepare("INSERT INTO items (id, kind, title_enc, status, window_start, window_end, created_at, updated_at) VALUES (?, 'task', ?, ?, ?, ?, 'x', 'x')")
        .bind(id, await cipher.encrypt(`Item ${id}`, `items:${id}:title`), status, start, end)
        .run();
    await add("D1", "done", null, null);
    await add("S1", "open", "2026-11-20T00:00:00Z", "2026-11-21T00:00:00Z");
    await add("C1", "open", "2026-12-01T00:00:00Z", "2026-12-02T00:00:00Z");
    await add("L1", "open", "2026-12-20T00:00:00Z", "2026-12-21T00:00:00Z"); // too far
    await env.DB.prepare("INSERT INTO events (id, at, type, item_id) VALUES ('e1', '2026-11-25T10:00:00Z', 'done', 'D1')").run();
    await env.DB.prepare("INSERT INTO events (id, at, type, item_id) VALUES ('e0', '2026-11-20T10:00:00Z', 'done', 'S1')").run(); // last week

    const r = await buildReview(repo, now, "UTC");
    expect(r.week_start).toBe("2026-11-23");
    expect(r.counts).toMatchObject({ done: 1, slipped: 1, coming: 1 });
    expect(r.done.map((i) => i.title)).toEqual(["Item D1"]);
    expect(r.summary).toBe(codeSummary(r.counts)); // no API key: code text
  });

  it("words the code summary plainly", () => {
    expect(codeSummary({ done: 4, slipped: 2, coming: 3, ideas: 1, debts: 1, follow_ups: 0 })).toBe(
      "4 done this week, 2 slipped, 3 coming up in the next 7 days. Still open: 1 open debt, 1 new idea.",
    );
  });
});
