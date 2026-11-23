import { answerQuestion, embed, giveAdvice, parseNote, type AnswerItem } from "../ai";
import { cleanRelation, isSelfMention, matchPerson, normalizeMention, type Person, type PersonMention } from "../core/people";
import { buildRecallQuery } from "../core/recall";
import { DISCLAIMERS, PARSER_VERSION, type CaptureOut, type ParseOutput, type RecallOut } from "../core/schema";
import { civilOf, civilToIso, resolveTimeRef } from "../core/time";
import { HttpError, json, readJson, str } from "../lib/http";
import { ulid } from "../lib/ulid";
import type { ItemRow, Repo } from "../repo";
import { searchVectors, storeVector } from "../vectors";

const MAX_NOTE = 2000;

export interface GapQuestion {
  subject_type: "person" | "me";
  subject_id: string | null;
  subject_name: string;
  key: string;
  question: string;
}

async function resolveMention(
  repo: Repo,
  people: Person[],
  m: PersonMention | null,
  create: boolean,
): Promise<Person | null> {
  if (!m || !m.mention.trim()) return null;
  if (isSelfMention(m)) return null; // the user is implied when no person is set
  const found = matchPerson(people, m);
  if (found || !create) return found;
  // Unknown person: create them so the next mention links. The user can rename or merge later.
  const mention = normalizeMention(m.mention);
  const relation = cleanRelation(m.relation ?? mention);
  const name = mention.charAt(0).toUpperCase() + mention.slice(1);
  const p = await repo.createPerson(name.slice(0, 80), relation, [mention]);
  people.push(p);
  return p;
}

export async function handleCapture(repo: Repo, req: Request, tz: string): Promise<Response> {
  const body = await readJson<{ text?: unknown; source?: unknown; client_id?: unknown }>(req);
  const text = str(body.text, "text", MAX_NOTE).trim();
  if (!text) throw new HttpError(400, "empty");
  const source = body.source === "voice" ? "voice" : "text";
  const clientId = body.client_id == null ? null : str(body.client_id, "client_id", 64);

  if (clientId) {
    const dup = await repo.db
      .prepare("SELECT i.* FROM captures c JOIN items i ON i.capture_id = c.id WHERE c.client_id = ?")
      .bind(clientId)
      .first<ItemRow>();
    if (dup) return json({ type: "capture", item: (await repo.itemViews([dup]))[0], question: null, duplicate: true });
  }

  const now = new Date();
  const people = await repo.people();
  const factKeys = await repo.activeFactKeys();
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? "me";
  let out: ParseOutput | null = null;
  let model: string | null = repo.env.PARSE_MODEL;
  try {
    ({ out, model } = await parseNote(repo.env, text, {
      now,
      tz,
      people: people.map((p) => ({ name: p.name, aliases: p.aliases, relation: p.relation })),
      knownFacts: factKeys.map((f) => ({ subject: f.subject_type === "me" ? "me" : nameOf(f.subject_id), key: f.key })),
    }));
  } catch (e) {
    // Never lose a capture because the model is down: keep the raw note and let the user fix it.
    console.error("parse failed", e instanceof Error ? e.message : e);
    model = null;
  }

  if (out?.intent === "recall" && out.recall) {
    return json({ type: "answer", ...(await recall(repo, text, out.recall, people, now, tz)) });
  }
  if (out?.intent === "advice") {
    return json({ type: "answer", ...(await advise(repo, text, people, now, tz)) });
  }

  const cap: CaptureOut = out?.capture ?? {
    // Model refused or returned nothing usable: keep the note as-is, flagged for a fix.
    kind: "note",
    title: text.slice(0, 80),
    details: text.length > 80 ? text : null,
    for_person: null,
    requested_by: null,
    when: { type: "none", date: null, end_date: null, unit: null, offset: null, weekday: null, time: null },
    place_hint: null,
    confidence: 0,
    facts: [],
    missing: [],
  };

  const forP = await resolveMention(repo, people, cap.for_person, true);
  const byP = await resolveMention(repo, people, cap.requested_by, true);
  const win = resolveTimeRef(cap.when, now, tz);

  const captureId = ulid();
  const itemId = ulid();
  const iso = now.toISOString();
  const confidence = Math.max(0, Math.min(1, Number(cap.confidence) || 0));
  const title = (cap.title || text).slice(0, 200);
  await repo.db.batch([
    repo.db
      .prepare(
        "INSERT INTO captures (id, created_at, source, raw_text_enc, transcript_enc, client_id, parse_enc, parser_version, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        captureId,
        iso,
        source,
        await repo.cipher.encrypt(text, `captures:${captureId}:raw_text`),
        null,
        clientId,
        out ? await repo.cipher.encrypt(JSON.stringify(out), `captures:${captureId}:parse`) : null,
        PARSER_VERSION,
        model,
      ),
    repo.db
      .prepare(
        `INSERT INTO items (id, capture_id, kind, title_enc, details_enc, for_person_id, requested_by_person_id,
          window_start, window_end, due_at, status, place_hint, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .bind(
        itemId,
        captureId,
        cap.kind,
        await repo.cipher.encrypt(title, `items:${itemId}:title`),
        await repo.cipher.encryptNullable(cap.details?.slice(0, 2000) || null, `items:${itemId}:details`),
        forP?.id ?? null,
        byP?.id ?? null,
        win ? win.start.toISOString() : null,
        win ? win.end.toISOString() : null,
        win?.dueAt ? win.dueAt.toISOString() : null,
        cap.place_hint?.slice(0, 100) ?? null,
        confidence,
        iso,
        iso,
      ),
  ]);

  // Told facts.
  for (const f of cap.facts.slice(0, 5)) {
    const subj = f.subject ? await resolveMention(repo, people, f.subject, true) : null;
    const key = f.key.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
    if (!key || !f.value) continue;
    await repo.addFact({
      subjectType: subj ? "person" : "me",
      subjectId: subj?.id ?? null,
      key,
      value: f.value.slice(0, 500),
      source: "told",
    });
  }

  // Ask once: the first missing fact the profile really lacks.
  const known = new Set((await repo.activeFactKeys()).map((f) => `${f.subject_type}:${f.subject_id ?? ""}:${f.key}`));
  let question: GapQuestion | null = null;
  for (const m of cap.missing) {
    const subj = m.subject ? await resolveMention(repo, people, m.subject, false) : null;
    const key = m.key.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
    const type = subj ? "person" : "me";
    if (!key || known.has(`${type}:${subj?.id ?? ""}:${key}`)) continue;
    question = { subject_type: type, subject_id: subj?.id ?? null, subject_name: subj?.name ?? "you", key, question: m.question.slice(0, 200) };
    break;
  }

  // Embedding failures must not lose the capture.
  try {
    await storeVector(repo.env, captureId, itemId, iso, await embed(repo.env, text));
  } catch (e) {
    console.warn("embed failed", e instanceof Error ? e.message : e);
  }

  const row = (await repo.getItemRow(itemId))!;
  return json({ type: "capture", item: (await repo.itemViews([row]))[0], question });
}

function toAnswerItems(views: Awaited<ReturnType<Repo["itemViews"]>>, tz: string): AnswerItem[] {
  const fmt = (iso: string | null) => (iso ? civilToIso(civilOf(new Date(iso), tz)) : null);
  return views.map((v) => ({
    id: v.id,
    title: v.title,
    details: v.details,
    kind: v.kind,
    status: v.status,
    captured: fmt(v.created_at)!,
    scheduled: v.due_at ? fmt(v.due_at) : v.window_start ? `${fmt(v.window_start)}..${fmt(new Date(new Date(v.window_end!).getTime() - 1).toISOString())}` : null,
    for_person: v.for_person?.name ?? null,
    requested_by: v.requested_by?.name ?? null,
  }));
}

/** On-demand advice, grounded in the profile (facts, people) and the notes closest to the question. */
async function advise(repo: Repo, question: string, people: Person[], now: Date, tz: string) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const { results } = await repo.db
    .prepare("SELECT id, subject_type, subject_id, key, value_enc FROM facts WHERE active = 1 ORDER BY created_at DESC LIMIT 150")
    .all<{ id: string; subject_type: string; subject_id: string | null; key: string; value_enc: string }>();
  const facts = await Promise.all(
    results.map(async (f) => ({
      id: f.id,
      about: f.subject_type === "me" ? "me" : (byId.get(f.subject_id ?? "")?.name ?? f.subject_type),
      key: f.key,
      value: await repo.cipher.decrypt(f.value_enc, `facts:${f.id}:value`),
    })),
  );
  let related: ItemRow[] = [];
  try {
    const hits = await searchVectors(repo.env, await embed(repo.env, question), 8);
    if (hits.length) {
      const ids = hits.map((h) => h.itemId);
      related = (await repo.db.prepare(`SELECT * FROM items WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<ItemRow>()).results;
    }
  } catch (e) {
    console.warn("advice search failed", e instanceof Error ? e.message : e);
  }
  const views = await repo.itemViews(related);
  const self = people.find((p) => p.relation === "self");
  const adv = await giveAdvice(repo.env, question, {
    today: civilToIso(civilOf(now, tz)),
    me: self?.name ?? "me",
    people: people.filter((p) => p.relation !== "self").map((p) => ({ name: p.name, relation: p.relation })),
    facts,
    related: toAnswerItems(views, tz),
  });
  if (!adv) return { answer: "I couldn't give advice on that one.", items: [], advice: true };
  const cited = new Set(adv.cited_ids);
  return {
    answer: adv.answer,
    // Added by code, not left to the model, so it is always there.
    disclaimer: adv.sensitive_domain !== "none" ? DISCLAIMERS[adv.sensitive_domain] : null,
    items: views.filter((v) => cited.has(v.id)),
    advice: true,
  };
}

async function recall(repo: Repo, question: string, r: RecallOut, people: Person[], now: Date, tz: string) {
  const today = civilToIso(civilOf(now, tz));
  const unknown: string[] = [];
  const pick = async (m: PersonMention | null) => {
    if (!m || isSelfMention(m)) return null;
    const p = matchPerson(people, m);
    if (!p) unknown.push(m.mention);
    return p;
  };
  const byP = await pick(r.requested_by);
  const forP = await pick(r.for_person);
  if (unknown.length) {
    return { answer: `I don't know who "${unknown[0]}" is yet.`, items: [] };
  }

  let rows: ItemRow[] = [];
  if (r.mode === "filter") {
    const q = buildRecallQuery(
      { requestedById: byP?.id ?? null, forPersonId: forP?.id ?? null, created: r.created, scheduled: r.scheduled, status: r.status, kind: r.kind },
      now,
      tz,
      20,
    );
    rows = (await repo.db.prepare(q.sql).bind(...q.params).all<ItemRow>()).results;
  } else {
    const created = resolveTimeRef(r.created, now, tz);
    const vec = await embed(repo.env, r.topic || question);
    const hits = await searchVectors(
      repo.env,
      vec,
      10,
      created ? { start: created.start.toISOString(), end: created.end.toISOString() } : null,
    );
    if (hits.length) {
      const ids = hits.map((h) => h.itemId);
      const { results } = await repo.db
        .prepare(`SELECT * FROM items WHERE id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids)
        .all<ItemRow>();
      const order = new Map(ids.map((id, i) => [id, i]));
      rows = results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
  }

  if (!rows.length) return { answer: "I have nothing on that.", items: [] };
  const views = await repo.itemViews(rows);
  const forModel = toAnswerItems(views, tz);
  const ans = await answerQuestion(repo.env, question, forModel, today);
  if (!ans) return { answer: "I couldn't answer that one. Here is what matched.", items: views };
  const cited = new Set(ans.cited_ids);
  return { answer: ans.answer, items: views.filter((v) => cited.has(v.id)) };
}
