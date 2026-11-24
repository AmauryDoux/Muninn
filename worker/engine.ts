// The life engine: category attributes, things, and triggers that fire. I/O lives here; the
// decisions are in worker/core (categories, triggers, rrule, things), which are unit-tested.
import { category, coerceAttrs, dateFactKind, reviewMonthsFor, triggersFor, triggersForDateFact, type Attrs, type TriggerPlan } from "./core/categories";
import { addMonths, civilToIso, formatDateFact, parseCivil, parseDateFact, type CivilDate } from "./core/civil";
import { parseRule } from "./core/rrule";
import { matchThing, type ThingRef } from "./core/things";
import { nextFire } from "./core/triggers";
import { addDays, civilOf, startOfLocalDay } from "./core/time";
import { ulid } from "./lib/ulid";
import type { ItemRow, Repo } from "./repo";

// ---- attributes ----

export async function readAttrs(repo: Repo, row: Pick<ItemRow, "id" | "attrs_enc">): Promise<Attrs> {
  if (!row.attrs_enc) return {};
  try {
    return JSON.parse(await repo.cipher.decrypt(row.attrs_enc, `items:${row.id}:attrs`)) as Attrs;
  } catch {
    return {};
  }
}

export async function writeAttrs(repo: Repo, id: string, attrs: Attrs): Promise<string | null> {
  return Object.keys(attrs).length ? repo.cipher.encrypt(JSON.stringify(attrs), `items:${id}:attrs`) : null;
}

// ---- things ----

export async function things(repo: Repo): Promise<(ThingRef & { attrs: Record<string, string> })[]> {
  const { results } = await repo.db.prepare("SELECT id, kind, name_enc, attrs_enc FROM things ORDER BY created_at").all<{ id: string; kind: string; name_enc: string; attrs_enc: string | null }>();
  return Promise.all(
    results.map(async (t) => ({
      id: t.id,
      kind: t.kind,
      name: await repo.cipher.decrypt(t.name_enc, `things:${t.id}:name`),
      attrs: t.attrs_enc ? (JSON.parse(await repo.cipher.decrypt(t.attrs_enc, `things:${t.id}:attrs`)) as Record<string, string>) : {},
    })),
  );
}

const THING_KINDS = new Set(["vehicle", "appliance", "key", "document", "device", "furniture", "other"]);

export async function createThing(repo: Repo, name: string, kind: string, attrs: Record<string, string> = {}): Promise<ThingRef> {
  const id = ulid();
  const now = new Date().toISOString();
  const k = THING_KINDS.has(kind) ? kind : "other";
  await repo.db
    .prepare("INSERT INTO things (id, kind, name_enc, attrs_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, k, await repo.cipher.encrypt(name, `things:${id}:name`), Object.keys(attrs).length ? await repo.cipher.encrypt(JSON.stringify(attrs), `things:${id}:attrs`) : null, now, now)
    .run();
  return { id, name, kind: k };
}

export async function updateThingAttrs(repo: Repo, id: string, patch: Record<string, string | null>): Promise<void> {
  const row = await repo.db.prepare("SELECT attrs_enc FROM things WHERE id = ?").bind(id).first<{ attrs_enc: string | null }>();
  if (!row) return;
  const cur = row.attrs_enc ? (JSON.parse(await repo.cipher.decrypt(row.attrs_enc, `things:${id}:attrs`)) as Record<string, string>) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "") delete cur[k];
    else cur[k] = v.slice(0, 300);
  }
  await repo.db
    .prepare("UPDATE things SET attrs_enc = ?, updated_at = ? WHERE id = ?")
    .bind(Object.keys(cur).length ? await repo.cipher.encrypt(JSON.stringify(cur), `things:${id}:attrs`) : null, new Date().toISOString(), id)
    .run();
}

/** Find the thing a mention refers to, creating it when it is new. */
export async function resolveThing(repo: Repo, known: ThingRef[], name: string, kind: string): Promise<ThingRef | null> {
  const n = name.trim().slice(0, 80);
  if (!n) return null;
  const found = matchThing(known, n);
  if (found) return found;
  const t = await createThing(repo, n.charAt(0).toUpperCase() + n.slice(1), kind);
  known.push(t);
  return t;
}

export async function linkThing(repo: Repo, itemId: string, thingId: string): Promise<void> {
  await repo.db
    .prepare("INSERT OR IGNORE INTO links (item_id, target_type, target_id, role, created_at) VALUES (?, 'thing', ?, 'about', ?)")
    .bind(itemId, thingId, new Date().toISOString())
    .run();
}

// ---- triggers ----

interface TriggerRow {
  id: string;
  item_id: string | null;
  anchor_type: "fact" | "item" | "date";
  anchor_id: string | null;
  anchor_date: string | null;
  offset_days: number;
  repeat: string | null;
  next_fire_at: string | null;
  occurrence_date: string | null;
  last_occurrence: string | null;
  require_open: number;
  kind: string | null;
  payload_enc: string | null;
  active: number;
}

/** UTC instant a trigger fires on a local date: just after local midnight, so the item is in that morning's brief. */
function fireInstant(d: CivilDate, tz: string): Date {
  return new Date(startOfLocalDay(d, tz).getTime() + 5 * 60_000);
}

async function insertPlans(
  repo: Repo,
  plans: TriggerPlan[],
  src: { itemId: string | null; anchorType: "fact" | "item"; anchorId: string; personId: string | null },
  today: CivilDate,
  tz: string,
) {
  const stmts: D1PreparedStatement[] = [];
  const now = new Date().toISOString();
  for (const p of plans) {
    const repeat = p.repeat ? parseRule(p.repeat) : null;
    if (p.repeat && !repeat) continue;
    const nf = nextFire({ anchor: p.anchor, repeat, offsetDays: p.offsetDays }, today);
    if (!nf) continue;
    const id = ulid();
    stmts.push(
      repo.db
        .prepare(
          `INSERT INTO triggers (id, item_id, anchor_type, anchor_id, anchor_field, anchor_date, offset_days, repeat, next_fire_at, last_fired_at,
             active, created_at, kind, payload_enc, occurrence_date, last_occurrence, require_open)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, NULL, ?)`,
        )
        .bind(
          id,
          src.itemId,
          src.anchorType,
          src.anchorId,
          civilToIso(p.anchor),
          p.offsetDays,
          p.repeat,
          fireInstant(nf.fireOn, tz).toISOString(),
          now,
          p.kind,
          await repo.cipher.encrypt(JSON.stringify({ title: p.title, person_id: src.personId }), `triggers:${id}:payload`),
          civilToIso(nf.occurrence),
          p.requireOpen ? 1 : 0,
        ),
    );
  }
  if (stmts.length) await repo.db.batch(stmts);
}

/** Replace the triggers of a categorised item after it was created or its attributes changed. */
export async function syncItemTriggers(repo: Repo, row: ItemRow, tz: string): Promise<void> {
  await repo.db.prepare("DELETE FROM triggers WHERE anchor_type = 'item' AND anchor_id = ?").bind(row.id).run();
  if (!category(row.subtype)) return;
  const attrs = await readAttrs(repo, row);
  const today = civilOf(new Date(), tz);
  const person = row.for_person_id ? (await repo.people()).find((p) => p.id === row.for_person_id) : null;
  const plans = triggersFor(
    row.subtype!,
    attrs,
    {
      title: await repo.cipher.decrypt(row.title_enc, `items:${row.id}:title`),
      status: row.status,
      created_at: row.created_at,
      window_start_date: row.window_start ? civilToIso(civilOf(new Date(row.window_start), tz)) : null,
      person_name: person?.name ?? null,
    },
    today,
  );
  // A newer service record for the same thing replaces the older one's "next service" reminder.
  if (row.subtype === "service_record" && plans.length) {
    const thing = await repo.db.prepare("SELECT target_id FROM links WHERE item_id = ? AND target_type = 'thing'").bind(row.id).first<{ target_id: string }>();
    if (thing) {
      await repo.db
        .prepare(
          `DELETE FROM triggers WHERE kind = 'service_due' AND anchor_type = 'item' AND anchor_id IN (
             SELECT l.item_id FROM links l JOIN items i ON i.id = l.item_id
             WHERE l.target_type = 'thing' AND l.target_id = ? AND i.subtype = 'service_record' AND l.item_id != ? AND i.created_at <= ?)`,
        )
        .bind(thing.target_id, row.id, row.created_at)
        .run();
    }
  }
  await insertPlans(repo, plans, { itemId: row.id, anchorType: "item", anchorId: row.id, personId: row.for_person_id }, today, tz);
}

/** Replace triggers for a date fact (birthday, passport expiry, last tetanus shot). */
export async function syncFactTriggers(repo: Repo, f: { id: string; subjectType: string; subjectId: string | null; key: string; value: string }, tz: string): Promise<void> {
  // Old values of the same fact are inactive now; drop their triggers too.
  await repo.db
    .prepare(
      `DELETE FROM triggers WHERE anchor_type = 'fact' AND anchor_id IN (
         SELECT id FROM facts WHERE subject_type = ? AND subject_id IS ? AND key = ?)`,
    )
    .bind(f.subjectType, f.subjectId, f.key)
    .run();
  if (!dateFactKind(f.key)) return;
  const df = parseDateFact(f.value);
  if (!df) return;
  const person = f.subjectType === "person" && f.subjectId ? (await repo.people()).find((p) => p.id === f.subjectId) : null;
  const who = person?.name ?? "you";
  const today = civilOf(new Date(), tz);
  await insertPlans(repo, triggersForDateFact(f.key, df, who), { itemId: null, anchorType: "fact", anchorId: f.id, personId: person?.id ?? null }, today, tz);
}

/** Add a fact with the right value type, review date and triggers. */
export async function addFactSmart(
  repo: Repo,
  f: { subjectType: "person" | "me" | "thing"; subjectId: string | null; key: string; value: string; source: "told" | "asked" | "observed"; reviewAfter?: string | null },
  tz: string,
): Promise<string> {
  let reviewAfter = f.reviewAfter ?? null;
  let value = f.value;
  const isDate = !!dateFactKind(f.key);
  if (isDate) {
    const df = parseDateFact(value);
    if (df) value = formatDateFact(df);
  }
  if (!reviewAfter && f.subjectType === "person") {
    const relation = (await repo.people()).find((p) => p.id === f.subjectId)?.relation ?? null;
    const months = reviewMonthsFor(f.key, relation);
    if (months) reviewAfter = startOfLocalDay(addMonths(civilOf(new Date(), tz), months), tz).toISOString();
  }
  const id = await repo.addFact({ ...f, value, reviewAfter });
  if (isDate && parseDateFact(value)) {
    await repo.db.prepare("UPDATE facts SET value_type = 'date' WHERE id = ?").bind(id).run();
  }
  await syncFactTriggers(repo, { id, subjectType: f.subjectType, subjectId: f.subjectId, key: f.key, value }, tz);
  return id;
}

/**
 * Fire due triggers: each creates a normal task for that day, which the reminder engine then pushes
 * (grouped, under the daily cap). The UPDATE is conditional on next_fire_at, so two overlapping cron
 * runs cannot create the same task twice.
 */
export async function fireTriggers(repo: Repo, now: Date, tz: string): Promise<number> {
  const db = repo.db;
  const { results } = await db
    .prepare("SELECT * FROM triggers WHERE active = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at LIMIT 50")
    .bind(now.toISOString())
    .all<TriggerRow>();
  const today = civilOf(now, tz);
  let fired = 0;
  for (const t of results) {
    const occ = t.occurrence_date ? parseCivil(t.occurrence_date) : null;
    const anchor = t.anchor_date ? parseCivil(t.anchor_date) : null;
    const repeat = t.repeat ? parseRule(t.repeat) : null;
    if (!occ || !anchor || (t.repeat && !repeat)) {
      await db.prepare("UPDATE triggers SET active = 0 WHERE id = ?").bind(t.id).run();
      continue;
    }
    if (t.require_open && t.item_id) {
      const src = await db.prepare("SELECT status FROM items WHERE id = ?").bind(t.item_id).first<{ status: string }>();
      if (!src || src.status !== "open") {
        await db.prepare("UPDATE triggers SET active = 0 WHERE id = ?").bind(t.id).run();
        continue;
      }
    }
    const nf = nextFire({ anchor, repeat, offsetDays: t.offset_days }, today, occ);
    const claim = await db
      .prepare(
        `UPDATE triggers SET last_fired_at = ?, last_occurrence = ?, next_fire_at = ?, occurrence_date = ?, active = ?
         WHERE id = ? AND next_fire_at = ?`,
      )
      .bind(
        now.toISOString(),
        t.occurrence_date,
        nf ? fireInstant(nf.fireOn, tz).toISOString() : null,
        nf ? civilToIso(nf.occurrence) : null,
        nf ? 1 : 0,
        t.id,
        t.next_fire_at,
      )
      .run();
    if (!claim.meta.changes) continue; // another run took it
    // After a cron outage, a "before" reminder whose occurrence already passed is dropped rather than nagging about the past.
    if ((t.offset_days <= 0 && civilToIso(occ) < civilToIso(today)) || !t.payload_enc) continue;
    const payload = JSON.parse(await repo.cipher.decrypt(t.payload_enc, `triggers:${t.id}:payload`)) as { title: string; person_id: string | null };
    const id = ulid();
    const iso = now.toISOString();
    // The window runs from today to the occurrence (a birthday two weeks out), at least one day.
    const lastDay = civilToIso(occ) > civilToIso(today) ? occ : today;
    const start = startOfLocalDay(today, tz).toISOString();
    const end = startOfLocalDay(addDays(lastDay, 1), tz).toISOString();
    const stmts = [
      db
        .prepare(
          `INSERT INTO items (id, capture_id, kind, subtype, title_enc, for_person_id, window_start, window_end, status, confidence, created_at, updated_at, source_trigger_id)
           VALUES (?, NULL, 'task', NULL, ?, ?, ?, ?, 'open', 1, ?, ?, ?)`,
        )
        .bind(id, await repo.cipher.encrypt(payload.title.slice(0, 200), `items:${id}:title`), payload.person_id, start, end, iso, iso, t.id),
      db.prepare("INSERT INTO events (id, at, type, item_id, nudge_type, payload_json) VALUES (?, ?, 'trigger_fired', ?, ?, NULL)").bind(ulid(), iso, id, t.kind),
    ];
    if (t.item_id) {
      stmts.push(db.prepare("INSERT OR IGNORE INTO links (item_id, target_type, target_id, role, created_at) VALUES (?, 'item', ?, 'follow_up_of', ?)").bind(id, t.item_id, iso));
    }
    await db.batch(stmts);
    fired++;
  }
  return fired;
}

// ---- applying a category to a new item ----

export interface CategoryInput {
  subtype: string;
  attrs: Record<string, unknown> | { key: string; value: unknown }[];
  thing?: { name: string; kind: string } | null;
  recurrence?: string | null;
}

/**
 * Store a category on an item: validated attributes, the thing link, inventory details on the thing,
 * the initial status (records are history), recurrence, and the triggers. Returns validation errors.
 */
export async function applyCategory(repo: Repo, itemId: string, input: CategoryInput, tz: string, defaultCur: string): Promise<string[]> {
  const cat = category(input.subtype);
  if (!cat) return ["unknown_subtype"];
  const { attrs, errors } = coerceAttrs(cat.subtype, input.attrs, defaultCur);
  if (cat.thing && input.thing?.name) {
    const t = await resolveThing(repo, await things(repo), input.thing.name, input.thing.kind);
    if (t) {
      await linkThing(repo, itemId, t.id);
      if (cat.subtype === "inventory") {
        const patch: Record<string, string> = {};
        for (const k of ["location", "size", "model"]) if (typeof attrs[k] === "string") patch[k] = attrs[k] as string;
        if (Object.keys(patch).length) await updateThingAttrs(repo, t.id, patch);
      }
    }
  }
  const rule = input.recurrence && parseRule(input.recurrence) ? input.recurrence : null;
  await repo.db
    .prepare("UPDATE items SET subtype = ?, kind = ?, attrs_enc = ?, status = ?, recurrence = COALESCE(?, recurrence), updated_at = ? WHERE id = ?")
    .bind(cat.subtype, cat.kind, await writeAttrs(repo, itemId, attrs), cat.initialStatus, rule, new Date().toISOString(), itemId)
    .run();
  const row = await repo.getItemRow(itemId);
  if (row) await syncItemTriggers(repo, row, tz);
  return errors;
}
