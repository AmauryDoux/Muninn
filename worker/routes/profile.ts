// People, facts and patterns: the "What I know about you" screen.
import { cleanRelation } from "../core/people";
import { HttpError, json, readJson, str } from "../lib/http";
import type { Repo } from "../repo";

function aliasesFrom(v: unknown): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, "bad_aliases");
  return [...new Set(v.slice(0, 20).map((a) => str(a, "alias", 60).toLowerCase().trim()).filter(Boolean))];
}

export async function listPeople(repo: Repo): Promise<Response> {
  return json({ people: await repo.people() });
}

export async function createPerson(repo: Repo, req: Request): Promise<Response> {
  const b = await readJson<{ name?: unknown; relation?: unknown; aliases?: unknown }>(req);
  const name = str(b.name, "name", 80).trim();
  if (!name) throw new HttpError(400, "empty_name");
  const relation = cleanRelation(typeof b.relation === "string" ? b.relation : null);
  if (relation === "self") throw new HttpError(400, "bad_relation");
  return json({ person: await repo.createPerson(name, relation, b.aliases === undefined ? [] : aliasesFrom(b.aliases)) });
}

export async function patchPerson(repo: Repo, req: Request, id: string): Promise<Response> {
  const p = (await repo.people()).find((x) => x.id === id);
  if (!p) throw new HttpError(404, "not_found");
  const b = await readJson<{ name?: unknown; relation?: unknown; aliases?: unknown }>(req);
  if (b.name !== undefined) p.name = str(b.name, "name", 80).trim() || p.name;
  if (b.aliases !== undefined) p.aliases = aliasesFrom(b.aliases);
  if (b.relation !== undefined && p.relation !== "self") {
    const r = cleanRelation(typeof b.relation === "string" ? b.relation : null);
    if (r !== "self") p.relation = r;
  }
  await repo.updatePerson(p);
  return json({ person: p });
}

export async function deletePerson(repo: Repo, id: string): Promise<Response> {
  const p = (await repo.people()).find((x) => x.id === id);
  if (!p) throw new HttpError(404, "not_found");
  if (p.relation === "self") throw new HttpError(400, "cannot_delete_self");
  await repo.db.batch([
    repo.db.prepare("UPDATE items SET for_person_id = NULL WHERE for_person_id = ?").bind(id),
    repo.db.prepare("UPDATE items SET requested_by_person_id = NULL WHERE requested_by_person_id = ?").bind(id),
    repo.db.prepare("DELETE FROM facts WHERE subject_type = 'person' AND subject_id = ?").bind(id),
    repo.db.prepare("DELETE FROM people WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

/** Everything Muninn knows, with source and date. Needs a fresh check (see router). */
export async function knowledge(repo: Repo): Promise<Response> {
  const people = await repo.people();
  const { results: facts } = await repo.db
    .prepare("SELECT * FROM facts WHERE active = 1 ORDER BY created_at DESC LIMIT 500")
    .all<{ id: string; subject_type: string; subject_id: string | null; key: string; value_enc: string; source: string; review_after: string | null; created_at: string }>();
  const { results: patterns } = await repo.db.prepare("SELECT * FROM patterns ORDER BY key").all();
  return json({
    people,
    facts: await Promise.all(
      facts.map(async (f) => ({
        id: f.id,
        subject_type: f.subject_type,
        subject_id: f.subject_id,
        key: f.key,
        value: await repo.cipher.decrypt(f.value_enc, `facts:${f.id}:value`),
        source: f.source,
        review_after: f.review_after,
        created_at: f.created_at,
      })),
    ),
    patterns,
  });
}

/** Answer to a gap question, or a fact added by hand. */
export async function addFact(repo: Repo, req: Request): Promise<Response> {
  const b = await readJson<{ subject_type?: unknown; subject_id?: unknown; key?: unknown; value?: unknown; source?: unknown; review_after?: unknown }>(req);
  const subjectType = b.subject_type === "person" ? "person" : b.subject_type === "me" ? "me" : null;
  if (!subjectType) throw new HttpError(400, "bad_subject");
  let subjectId: string | null = null;
  if (subjectType === "person") {
    subjectId = str(b.subject_id, "subject_id", 40);
    if (!(await repo.people()).some((p) => p.id === subjectId)) throw new HttpError(400, "bad_subject");
  }
  const key = str(b.key, "key", 60).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const value = str(b.value, "value", 500).trim();
  if (!key || !value) throw new HttpError(400, "empty");
  const source = b.source === "told" ? "told" : "asked";
  let reviewAfter: string | null = null;
  if (b.review_after != null) {
    const d = new Date(str(b.review_after, "review_after", 40));
    if (Number.isNaN(d.getTime())) throw new HttpError(400, "bad_review_after");
    reviewAfter = d.toISOString();
  }
  const id = await repo.addFact({ subjectType, subjectId, key, value, source, reviewAfter });
  return json({ id });
}

export async function patchFact(repo: Repo, req: Request, id: string): Promise<Response> {
  const row = await repo.db.prepare("SELECT id FROM facts WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "not_found");
  const b = await readJson<{ value?: unknown; active?: unknown }>(req);
  if (b.value !== undefined) {
    const v = str(b.value, "value", 500).trim();
    if (!v) throw new HttpError(400, "empty");
    await repo.db.prepare("UPDATE facts SET value_enc = ? WHERE id = ?").bind(await repo.cipher.encrypt(v, `facts:${id}:value`), id).run();
  }
  if (typeof b.active === "boolean") await repo.db.prepare("UPDATE facts SET active = ? WHERE id = ?").bind(b.active ? 1 : 0, id).run();
  return json({ ok: true });
}

export async function deleteFact(repo: Repo, id: string): Promise<Response> {
  await repo.db.prepare("DELETE FROM facts WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

/** Switching a pattern off locks it, so the nightly job will not bring it back. */
export async function patchPattern(repo: Repo, req: Request, id: string): Promise<Response> {
  const b = await readJson<{ active?: unknown }>(req);
  if (typeof b.active !== "boolean") throw new HttpError(400, "bad_request");
  await repo.db.prepare("UPDATE patterns SET active = ?, user_locked = ? WHERE id = ?").bind(b.active ? 1 : 0, b.active ? 0 : 1, id).run();
  return json({ ok: true });
}
