// Vector search: Vectorize when bound, otherwise brute-force cosine over vectors stored in D1.
import type { Env } from "./env";
import { cosine, topK } from "./core/recall";

const D1_SCAN_LIMIT = 3000; // keeps CPU per request low; raise only on Workers Paid

export async function storeVector(env: Env, captureId: string, itemId: string, createdAt: string, vec: Float32Array) {
  if (env.VECTORIZE) {
    await env.VECTORIZE.upsert([{ id: captureId, values: Array.from(vec), metadata: { item_id: itemId, created_at: createdAt } }]);
  }
  // Always keep a copy in D1, so the index can be rebuilt or the store switched without re-embedding.
  await env.DB.prepare("INSERT OR REPLACE INTO capture_vectors (capture_id, item_id, created_at, vec) VALUES (?, ?, ?, ?)")
    .bind(captureId, itemId, createdAt, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength))
    .run();
}

export async function searchVectors(
  env: Env,
  q: Float32Array,
  k: number,
  createdRange?: { start: string; end: string } | null,
): Promise<{ itemId: string; score: number }[]> {
  if (env.VECTORIZE) {
    const res = await env.VECTORIZE.query(Array.from(q), { topK: createdRange ? 50 : k, returnMetadata: "all" });
    return res.matches
      .map((m) => ({ itemId: String(m.metadata?.item_id ?? ""), createdAt: String(m.metadata?.created_at ?? ""), score: m.score }))
      .filter((m) => m.itemId && (!createdRange || (m.createdAt >= createdRange.start && m.createdAt < createdRange.end)))
      .slice(0, k);
  }
  const sql = createdRange
    ? "SELECT item_id, vec FROM capture_vectors WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?"
    : "SELECT item_id, vec FROM capture_vectors ORDER BY created_at DESC LIMIT ?";
  const stmt = createdRange
    ? env.DB.prepare(sql).bind(createdRange.start, createdRange.end, D1_SCAN_LIMIT)
    : env.DB.prepare(sql).bind(D1_SCAN_LIMIT);
  const { results } = await stmt.all<{ item_id: string; vec: ArrayBuffer | number[] }>();
  const rows = results.map((r) => {
    const buf = r.vec instanceof ArrayBuffer ? r.vec : new Uint8Array(r.vec).buffer;
    return { itemId: r.item_id, vec: new Float32Array(buf) };
  });
  return topK(rows, (r) => cosine(q, r.vec), k)
    .filter((x) => x.score > 0.3)
    .map((x) => ({ itemId: x.row.itemId, score: x.score }));
}

export async function deleteVectors(env: Env, captureIds: string[]) {
  if (!captureIds.length) return;
  if (env.VECTORIZE) await env.VECTORIZE.deleteByIds(captureIds);
}
