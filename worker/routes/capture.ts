import { answerQuestion, embed, giveAdvice, parseNote, type AnswerItem } from "../ai";
import { category } from "../core/categories";
import { classifyDomain, stricterDomain } from "../core/domain";
import { cleanRelation, isSelfMention, matchPerson, normalizeMention, type Person, type PersonMention } from "../core/people";
import { buildRecallQuery } from "../core/recall";
import { firstWindow } from "../core/recurring";
import { recurrenceToRule } from "../core/rrule";
import { DISCLAIMERS, PARSER_VERSION, type CaptureOut, type ParseOutput, type RecallOut } from "../core/schema";
import { matchThing, thingTokens } from "../core/things";
import { civilOf, civilToIso, resolveTimeRef } from "../core/time";
import { logModelError } from "../lib/usage";
import { addFactSmart, applyCategory, linkThing, resolveThing, things, updateThingAttrs } from "../engine";
import { getSetting } from "../lib/settings";
import { HttpError, json, readJson, str } from "../lib/http";
import { ulid } from "../lib/ulid";
import type { ItemRow, Repo } from "../repo";
import { searchVectors, storeVector } from "../vectors";

const MAX_NOTE = 2000;
const MAX_QUEUE_AGE_MS = 14 * 86400_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * When the note was written. A note queued offline is sent later with the time it was typed, so "tomorrow" means the
 * day after it was written, not the day after it reached the server. Bounded: never in the future (beyond clock skew)
 * and never older than 14 days, so a wrong phone clock cannot place notes anywhere.
 */
export function captureTime(raw: unknown, serverNow: Date): Date {
  if (typeof raw !== "string" || raw.length > 40) return serverNow;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return serverNow;
  if (t > serverNow.getTime() + MAX_CLOCK_SKEW_MS) return serverNow;
  return new Date(Math.max(t, serverNow.getTime() - MAX_QUEUE_AGE_MS));
}

export interface GapQuestion {
  subject_type: "person" | "me";
  subject_id: string | null;
  subject_name: string;
  key: string;
  question: string;
}

/**
 * A person typed into a form ("Emma", "wife", "Aunt Lisa"): the existing match, or a new person.
 * Returns null for "me" or an empty name. Typed names keep their casing; relation words become the relation.
 */
export async function personFromTypedName(repo: Repo, typed: string): Promise<Person | null> {
  const raw = typed.trim().slice(0, 80);
  if (!raw) return null;
  const m = { mention: raw, relation: null };
  if (isSelfMention(m)) return null;
  const people = await repo.people();
  const found = matchPerson(people, m);
  if (found) return found;
  const relation = cleanRelation(raw);
  const name = relation !== "other" ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : raw;
  return repo.createPerson(name, relation, relation !== "other" ? [normalizeMention(raw)] : []);
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
  const body = await readJson<{ text?: unknown; source?: unknown; client_id?: unknown; captured_at?: unknown }>(req);
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

  const now = captureTime(body.captured_at, new Date());
  const people = await repo.people();
  const factKeys = await repo.activeFactKeys();
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? "me";
  let out: ParseOutput | null = null;
  let model: string | null = repo.env.PARSE_MODEL;
  let aiError: string | null = null;
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
    aiError = await logModelError(repo.db, "parse", e);
    model = null;
  }

  if (!aiError && out && out.intent === "capture" && !out.capture) aiError = "The model returned no capture.";
  if (!aiError && !out && model) aiError = "The model declined to read this note.";

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
    subtype: "none",
    attrs: [],
    thing: null,
    recurrence: null,
    facts: [],
    missing: [],
  };

  const forP = await resolveMention(repo, people, cap.for_person, true);
  const byP = await resolveMention(repo, people, cap.requested_by, true);
  let win = resolveTimeRef(cap.when, now, tz);
  const rrule = recurrenceToRule(cap.recurrence);
  // A repeating item with no date starts at its next occurrence ("change the AC filter every 3 months").
  const first = rrule && !win ? firstWindow(rrule, now, tz) : null;
  if (first) win = { startDate: "", endDate: "", start: new Date(first.window_start!), end: new Date(first.window_end!), dueAt: null };
  if (rrule && win && !win.dueAt && cap.when.time) {
    // "every morning at 8": keep the time on the first occurrence.
    const r = resolveTimeRef({ type: "date", date: civilToIso(civilOf(win.start, tz)), time: cap.when.time }, now, tz);
    if (r) win = r;
  }

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
          window_start, window_end, due_at, status, place_hint, confidence, recurrence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
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
        rrule,
        iso,
        iso,
      ),
  ]);

  // Category: typed attributes, the thing it is about, triggers ("30 days before the warranty ends").
  const cat = category(cap.subtype === "none" ? null : cap.subtype);
  const known = await things(repo);
  const thing = cap.thing?.name ? await resolveThing(repo, known, cap.thing.name, cap.thing.kind) : null;
  if (cat) {
    const currency = (await getSetting(repo.db, "currency")) ?? "USD";
    await applyCategory(repo, itemId, { subtype: cat.subtype, attrs: cap.attrs, thing: thing ? { name: thing.name, kind: thing.kind } : null, recurrence: rrule }, tz, currency);
  }
  // A plain task or note about an owned object ("change the AC filter") is still linked to it.
  if (thing && !cat?.thing) await linkThing(repo, itemId, thing.id);

  // Told facts: about a person, the user, or the thing ("spare key is in the blue drawer").
  for (const f of cap.facts.slice(0, 6)) {
    const key = f.key.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
    if (!key || !f.value) continue;
    const value = f.value.slice(0, 500);
    if (f.about_thing && thing) {
      await addFactSmart(repo, { subjectType: "thing", subjectId: thing.id, key, value, source: "told" }, tz);
      if (["location", "size", "model", "filter_size"].includes(key)) await updateThingAttrs(repo, thing.id, { [key]: value });
      continue;
    }
    const subj = f.subject ? await resolveMention(repo, people, f.subject, true) : null;
    await addFactSmart(repo, { subjectType: subj ? "person" : "me", subjectId: subj?.id ?? null, key, value, source: "told" }, tz);
  }

  // Ask once: the first missing fact the profile really lacks.
  const knownKeys = new Set((await repo.activeFactKeys()).map((f) => `${f.subject_type}:${f.subject_id ?? ""}:${f.key}`));
  let question: GapQuestion | null = null;
  for (const m of cap.missing) {
    const subj = m.subject ? await resolveMention(repo, people, m.subject, false) : null;
    const key = m.key.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
    const type = subj ? "person" : "me";
    if (!key || knownKeys.has(`${type}:${subj?.id ?? ""}:${key}`)) continue;
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
  return json({ type: "capture", item: (await repo.itemViews([row]))[0], question, ai_error: aiError });
}

function toAnswerItems(views: Awaited<ReturnType<Repo["itemViews"]>>, tz: string): AnswerItem[] {
  const fmt = (iso: string | null) => (iso ? civilToIso(civilOf(new Date(iso), tz)) : null);
  return views.map((v) => ({
    id: v.id,
    title: v.title,
    details: v.details,
    kind: v.kind,
    status: v.status,
    subtype: v.subtype,
    attrs: v.attrs,
    status_line: v.status_line?.text ?? null,
    thing: v.thing?.name ?? null,
    captured: fmt(v.created_at)!,
    scheduled: v.due_at ? fmt(v.due_at) : v.window_start ? `${fmt(v.window_start)}..${fmt(new Date(new Date(v.window_end!).getTime() - 1).toISOString())}` : null,
    for_person: v.for_person?.name ?? null,
    requested_by: v.requested_by?.name ?? null,
  }));
}

/** People named in a question, by name, alias or a unique relation ("my wife", "Emma"). */
function peopleIn(question: string, people: Person[]): Person[] {
  const q = ` ${normalizeMention(question)} `;
  return people.filter((p) => {
    if (p.relation === "self") return false;
    const names = [p.name, ...p.aliases].map(normalizeMention).filter(Boolean);
    if (names.some((n) => q.includes(` ${n} `))) return true;
    return q.includes(` ${p.relation} `) && people.filter((x) => x.relation === p.relation).length === 1;
  });
}

export interface Because {
  ref: string;
  text: string;
}

/** On-demand advice, grounded in the profile (facts, people), the people asked about, and the closest notes. */
async function advise(repo: Repo, question: string, people: Person[], now: Date, tz: string) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const { results } = await repo.db
    .prepare("SELECT id, subject_type, subject_id, key, value_enc, created_at FROM facts WHERE active = 1 AND subject_type != 'thing' ORDER BY created_at DESC LIMIT 150")
    .all<{ id: string; subject_type: string; subject_id: string | null; key: string; value_enc: string; created_at: string }>();
  const facts = await Promise.all(
    results.map(async (f) => ({
      id: f.id,
      about: f.subject_type === "me" ? "me" : (byId.get(f.subject_id ?? "")?.name ?? f.subject_type),
      key: f.key,
      value: await repo.cipher.decrypt(f.value_enc, `facts:${f.id}:value`),
      created_at: f.created_at,
    })),
  );
  // Focus: what Muninn holds about the people in the question (gift ideas, debts, events), newest first.
  const named = peopleIn(question, people);
  let focusRows: ItemRow[] = [];
  if (named.length) {
    const ids = named.map((p) => p.id);
    const ph = ids.map(() => "?").join(",");
    focusRows = (
      await repo.db
        .prepare(
          `SELECT * FROM items WHERE status = 'open' AND subtype IN ('gift_idea', 'debt', 'occasion', 'follow_up')
           AND (for_person_id IN (${ph}) OR requested_by_person_id IN (${ph})) ORDER BY created_at DESC LIMIT 15`,
        )
        .bind(...ids, ...ids)
        .all<ItemRow>()
    ).results;
  }
  let related: ItemRow[] = [];
  try {
    const hits = await searchVectors(repo.env, await embed(repo.env, question), 8);
    const ids = hits.map((h) => h.itemId).filter((id) => !focusRows.some((r) => r.id === id));
    if (ids.length) {
      related = (await repo.db.prepare(`SELECT * FROM items WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<ItemRow>()).results;
    }
  } catch (e) {
    console.warn("advice search failed", e instanceof Error ? e.message : e);
  }
  const views = await repo.itemViews([...focusRows, ...related]);
  const focusViews = views.slice(0, focusRows.length);
  const relatedViews = views.slice(focusRows.length);
  const self = people.find((p) => p.relation === "self");
  let adv: Awaited<ReturnType<typeof giveAdvice>> = null;
  let aiError: string | null = null;
  try {
    adv = await giveAdvice(repo.env, question, {
    today: civilToIso(civilOf(now, tz)),
    me: self?.name ?? "me",
    people: people.filter((p) => p.relation !== "self").map((p) => ({ name: p.name, relation: p.relation })),
    facts: facts.map(({ created_at: _c, ...f }) => f),
    related: toAnswerItems(relatedViews, tz),
    focus: toAnswerItems(focusViews, tz),
    });
  } catch (e) {
    aiError = await logModelError(repo.db, "advice", e);
  }
  if (!adv) return { answer: "I couldn't give advice on that one.", items: [], advice: true, because: [], disclaimer: null, ai_error: aiError };
  const cited = new Set(adv.cited_ids);
  const day = (iso: string) => civilToIso(civilOf(new Date(iso), tz));
  // "Because you told me X": built by code from the cited ids, so the user can spot a wrong memory.
  const because: Because[] = [
    ...facts.filter((f) => cited.has(f.id)).map((f) => ({ ref: f.id, text: `${f.about === "me" ? "Your" : `${f.about}'s`} ${f.key.replace(/_/g, " ")}: ${f.value} (told ${day(f.created_at)})` })),
    ...views.filter((v) => cited.has(v.id)).map((v) => ({ ref: v.id, text: `You noted "${v.title}" (${day(v.created_at)})` })),
  ];
  // The stricter of the model's label and a keyword check, added by code so it is always there.
  const domain = stricterDomain(adv.sensitive_domain, classifyDomain(question));
  return {
    answer: adv.answer,
    disclaimer: domain !== "none" ? DISCLAIMERS[domain] : null,
    because,
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
      { requestedById: byP?.id ?? null, forPersonId: forP?.id ?? null, created: r.created, scheduled: r.scheduled, status: r.status, kind: r.kind, subtype: r.subtype === "any" ? null : r.subtype },
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

  // Things: "where is the spare key", "what size is the furnace filter" answer from the thing's details and facts.
  const thingItems: AnswerItem[] = [];
  const topic = r.topic || question;
  if (thingTokens(topic).length) {
    const all = await things(repo);
    const t = matchThing(all, topic) ?? all.find((x) => thingTokens(topic).some((tok) => thingTokens(x.name).includes(tok) && tok.length > 3)) ?? null;
    if (t) {
      const { results: tf } = await repo.db
        .prepare("SELECT id, key, value_enc FROM facts WHERE subject_type = 'thing' AND subject_id = ? AND active = 1")
        .bind(t.id)
        .all<{ id: string; key: string; value_enc: string }>();
      const details = { ...t.attrs, ...Object.fromEntries(await Promise.all(tf.map(async (f) => [f.key, await repo.cipher.decrypt(f.value_enc, `facts:${f.id}:value`)]))) };
      thingItems.push({ id: t.id, title: t.name, details: JSON.stringify(details), kind: "thing", status: "open", captured: today, scheduled: null, for_person: null, requested_by: null });
    }
  }

  if (!rows.length && !thingItems.length) return { answer: "I have nothing on that.", items: [] };
  const views = await repo.itemViews(rows);
  const forModel = [...thingItems, ...toAnswerItems(views, tz)];
  let ans: Awaited<ReturnType<typeof answerQuestion>> = null;
  let aiError: string | null = null;
  try {
    ans = await answerQuestion(repo.env, question, forModel, today);
  } catch (e) {
    aiError = await logModelError(repo.db, "answer", e);
  }
  if (!ans) return { answer: "I couldn't answer that one. Here is what matched.", items: views, ai_error: aiError };
  const cited = new Set(ans.cited_ids);
  return { answer: ans.answer, items: views.filter((v) => cited.has(v.id)) };
}
