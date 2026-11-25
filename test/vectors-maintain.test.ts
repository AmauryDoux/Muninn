// Search stays complete: an edited item is re-embedded from its new wording; Vectorize is filled from D1 once bound.
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/env";
import { Cipher } from "../worker/lib/crypto";
import { maintainVectors, storeVector } from "../worker/vectors";
import { makeD1 } from "./d1-shim";

const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

async function setup() {
  const env = { DB: makeD1() } as unknown as Env;
  const cipher = await Cipher.fromSecret(KEY);
  await env.DB.prepare("INSERT INTO captures (id, created_at, source, raw_text_enc, parser_version) VALUES ('C1', '2026-11-01T00:00:00Z', 'text', ?, 1)")
    .bind(await cipher.encrypt("get the blue lego set for emma", "captures:C1:raw_text"))
    .run();
  await env.DB.prepare("INSERT INTO items (id, capture_id, kind, title_enc, status, created_at, updated_at) VALUES ('I1', 'C1', 'note', ?, 'open', '2026-11-01T00:00:00Z', 'x')")
    .bind(await cipher.encrypt("Blue Lego set", "items:I1:title"))
    .run();
  return { env, cipher };
}

describe("vector maintenance", () => {
  it("embeds an item with no vector from its title and note, then leaves it alone", async () => {
    const { env, cipher } = await setup();
    const seen: string[] = [];
    const embed = async (t: string) => (seen.push(t), new Float32Array(768).fill(0.1));
    expect((await maintainVectors(env, cipher, embed)).embedded).toBe(1);
    expect(seen[0]).toBe("Blue Lego set\nget the blue lego set for emma");
    expect((await maintainVectors(env, cipher, embed)).embedded).toBe(0);
  });

  it("copies D1 vectors into Vectorize once, in batches", async () => {
    const { env, cipher } = await setup();
    await storeVector(env, "C1", "I1", "2026-11-01T00:00:00Z", new Float32Array(768).fill(0.2));
    const upsert = vi.fn(async () => ({}));
    (env as { VECTORIZE?: unknown }).VECTORIZE = { upsert, query: vi.fn(), deleteByIds: vi.fn() };
    const embed = async () => new Float32Array(768);
    expect((await maintainVectors(env, cipher, embed)).synced).toBe(1);
    expect((await maintainVectors(env, cipher, embed)).synced).toBe(0);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
