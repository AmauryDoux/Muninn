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

const REEMBED_PER_RUN = 10;
const VECTORIZE_SYNC_PER_RUN = 100;

/**
 * Cron: keeps search complete. Re-embeds items whose vector is missing (edited, or restored from a backup, which
 * leaves vectors out) from their current title, details and original note. When Vectorize is newly bound, copies
 * the D1 vectors into it in batches. Small batches keep each run cheap.
 */
export async function maintainVectors(
  env: Env,
  cipher: { decrypt(enc: string, aad: string): Promise<string>; decryptNullable(enc: string | null, aad: string): Promise<string | null> },
  embedText: (text: string) => Promise<Float32Array>,
): Promise<{ embedded: number; synced: number }> {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.capture_id, i.created_at, i.title_enc, i.details_enc, c.raw_text_enc FROM items i JOIN captures c ON c.id = i.capture_id
     WHERE NOT EXISTS (SELECT 1 FROM capture_vectors v WHERE v.capture_id = i.capture_id) ORDER BY i.created_at DESC LIMIT ?`,
  )
    .bind(REEMBED_PER_RUN)
    .all<{ id: string; capture_id: string; created_at: string; title_enc: string; details_enc: string | null; raw_text_enc: string }>();
  let embedded = 0;
  for (const r of results) {
    try {
      await embedOne(r);
      embedded++;
    } catch (e) {
      console.warn("re-embed failed", r.id, e instanceof Error ? e.message : e);
    }
  }
  async function embedOne(r: (typeof results)[number]) {
    const parts = [
      await cipher.decrypt(r.title_enc, `items:${r.id}:title`),
      await cipher.decryptNullable(r.details_enc, `items:${r.id}:details`),
      await cipher.decrypt(r.raw_text_enc, `captures:${r.capture_id}:raw_text`),
    ];
    const text = [...new Set(parts.filter((x): x is string => !!x))].join("\n").slice(0, 4000);
    await storeVector(env, r.capture_id, r.id, r.created_at, await embedText(text));
  }

  let synced = 0;
  if (env.VECTORIZE) {
    const cursor = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'vectorize_cursor'").first<{ value: string }>())?.value ?? "";
    if (cursor !== "done") {
      const { results: rows } = await env.DB.prepare("SELECT capture_id, item_id, created_at, vec FROM capture_vectors WHERE capture_id > ? ORDER BY capture_id LIMIT ?")
        .bind(cursor, VECTORIZE_SYNC_PER_RUN)
        .all<{ capture_id: string; item_id: string; created_at: string; vec: ArrayBuffer | number[] }>();
      if (rows.length) {
        await env.VECTORIZE.upsert(
          rows.map((r) => ({
            id: r.capture_id,
            values: Array.from(new Float32Array(r.vec instanceof ArrayBuffer ? r.vec : new Uint8Array(r.vec).buffer)),
            metadata: { item_id: r.item_id, created_at: r.created_at },
          })),
        );
        synced = rows.length;
      }
      const next = rows.length < VECTORIZE_SYNC_PER_RUN ? "done" : rows[rows.length - 1].capture_id;
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('vectorize_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(next).run();
    }
  }
  return { embedded, synced };
}
