// The phone's offline queue: a note must survive every temporary failure and be sent once, with the time it was typed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

type Reply = { status: number; body?: unknown } | "offline";
let replies: Reply[] = [];
const sentBodies: Record<string, unknown>[] = [];
vi.stubGlobal("fetch", async (_path: string, init: { body?: string }) => {
  sentBodies.push(JSON.parse(init.body ?? "{}"));
  const r = replies.shift() ?? { status: 200, body: { type: "capture" } };
  if (r === "offline") throw new TypeError("Failed to fetch");
  return new Response(JSON.stringify(r.body ?? { error: "x" }), { status: r.status, headers: { "Content-Type": "application/json" } });
});

const { capture, flushQueue, queuedCount, isRetryable, ApiError } = await import("../app/src/api");

beforeEach(() => {
  store.clear();
  replies = [];
  sentBodies.length = 0;
});

describe("offline queue", () => {
  it("queues a note when offline, with its capture time, and sends it later", async () => {
    replies = ["offline"];
    const before = Date.now();
    expect(await capture("call mom tomorrow", "text")).toEqual({ type: "queued" });
    expect(queuedCount()).toBe(1);
    replies = [{ status: 200, body: { type: "capture" } }];
    expect(await flushQueue()).toBe(1);
    expect(queuedCount()).toBe(0);
    const resent = sentBodies[1];
    expect(resent.client_id).toBe(sentBodies[0].client_id);
    expect(Date.parse(resent.captured_at as string)).toBeGreaterThanOrEqual(before - 1);
  });

  it.each([401, 429, 500, 503])("keeps queued notes when the server answers %i", async (status) => {
    replies = ["offline", "offline"];
    await capture("one", "text");
    await capture("two", "text");
    replies = [{ status, body: { error: "unauthenticated" } }];
    expect(await flushQueue()).toBe(0);
    expect(queuedCount()).toBe(2);
  });

  it("drops only a note the server can never accept, and keeps going", async () => {
    replies = ["offline", "offline"];
    await capture("bad", "text");
    await capture("good", "text");
    replies = [{ status: 400, body: { error: "bad_request" } }, { status: 200, body: { type: "capture" } }];
    expect(await flushQueue()).toBe(1);
    expect(queuedCount()).toBe(0);
  });

  it("queues instead of failing when signed out or the server errors on the first send", async () => {
    replies = [{ status: 401, body: { error: "unauthenticated" } }];
    expect(await capture("x", "text")).toEqual({ type: "queued" });
    replies = [{ status: 502, body: {} }];
    expect(await capture("y", "text")).toEqual({ type: "queued" });
    expect(queuedCount()).toBe(2);
  });

  it("two flushes at once send each note once", async () => {
    replies = ["offline"];
    await capture("once", "text");
    const [a, b] = await Promise.all([flushQueue(), flushQueue()]);
    expect(a + b).toBe(2); // same promise, counted by both callers
    expect(sentBodies.filter((s) => s.text === "once")).toHaveLength(2); // the failed first try and one resend
  });

  it("classifies errors", () => {
    expect(isRetryable(new TypeError("net"))).toBe(true);
    expect(isRetryable(new ApiError(400, "bad"))).toBe(false);
    expect(isRetryable(new ApiError(413, "too_large"))).toBe(false);
    expect(isRetryable(new ApiError(500, "internal"))).toBe(true);
  });
});
