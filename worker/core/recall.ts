// Pure: turn a validated recall object into a parameterised SQL query. The model never writes SQL.
import { category } from "./categories";
import { resolveTimeRef, type TimeRef } from "./time";

export interface RecallFilter {
  requestedById: string | null;
  forPersonId: string | null;
  created: TimeRef | null;
  scheduled: TimeRef | null;
  status: "open" | "done" | "dropped" | "any";
  kind: "task" | "note" | "fact" | "event" | "any";
  /** A category subtype, or "any"/undefined. Validated against the registry. */
  subtype?: string | null;
}

export interface SqlQuery {
  sql: string;
  params: (string | number)[];
}

const STATUSES = new Set(["open", "done", "dropped"]);
const KINDS = new Set(["task", "note", "fact", "event"]);

export function buildRecallQuery(f: RecallFilter, now: Date, tz: string, limit = 50): SqlQuery {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.requestedById) {
    where.push("requested_by_person_id = ?");
    params.push(f.requestedById);
  }
  if (f.forPersonId) {
    where.push("for_person_id = ?");
    params.push(f.forPersonId);
  }
  const created = resolveTimeRef(f.created, now, tz);
  if (created) {
    where.push("created_at >= ? AND created_at < ?");
    params.push(created.start.toISOString(), created.end.toISOString());
  }
  const sched = resolveTimeRef(f.scheduled, now, tz);
  if (sched) {
    // Overlaps the asked window.
    where.push("COALESCE(due_at, window_start) < ? AND COALESCE(window_end, due_at, window_start) >= ?");
    params.push(sched.end.toISOString(), sched.start.toISOString());
  }
  if (STATUSES.has(f.status)) {
    where.push("status = ?");
    params.push(f.status);
  }
  if (KINDS.has(f.kind) && !f.subtype) {
    where.push("kind = ?");
    params.push(f.kind);
  }
  if (f.subtype && category(f.subtype)) {
    where.push("subtype = ?");
    params.push(f.subtype);
  }
  const n = Math.max(1, Math.min(200, Math.trunc(limit)));
  const sql =
    "SELECT * FROM items" + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + ` ORDER BY created_at DESC LIMIT ${n}`;
  return { sql, params };
}

/** Cosine similarity for the D1 fallback vector store. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function topK<T>(rows: T[], score: (r: T) => number, k: number): { row: T; score: number }[] {
  return rows
    .map((row) => ({ row, score: score(row) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, k);
}
