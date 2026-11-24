import { personFromTypedName } from "./capture";
// The Life screens: categories, important dates, balances, study, things, tips and the ideas digest.
import { actOnTip, currentTips } from "../advice";
import { CATEGORIES, attrMoney, category, coerceAttrs, dateFactKind, GROUPS } from "../core/categories";
import { ageOn, nextAnniversary, parseDateFact } from "../core/civil";
import { clusterByCosine } from "../core/cluster";
import { balances } from "../core/money";
import { firstWindow } from "../core/recurring";
import { parseRule } from "../core/rrule";
import { SEASONAL_TEMPLATES } from "../core/seasonal";
import { studyStats } from "../core/streaks";
import { daysUntil } from "../core/triggers";
import { addDays, civilOf, civilToIso, parseCivil, resolveTimeRef } from "../core/time";
import { applyCategory, createThing, readAttrs, syncItemTriggers, things, updateThingAttrs, writeAttrs } from "../engine";
import { HttpError, json, readJson, str } from "../lib/http";
import { getSetting } from "../lib/settings";
import { ulid } from "../lib/ulid";
import type { ItemRow, Repo } from "../repo";

const DAY = 86_400_000;

/** Upcoming birthdays, anniversaries and expiries from date facts, soonest first. */
async function upcomingDates(repo: Repo, tz: string, days: number) {
  const today = civilOf(new Date(), tz);
  const people = new Map((await repo.people()).map((p) => [p.id, p]));
  const { results } = await repo.db
    .prepare("SELECT id, subject_type, subject_id, key, value_enc FROM facts WHERE active = 1 AND value_type = 'date' LIMIT 500")
    .all<{ id: string; subject_type: string; subject_id: string | null; key: string; value_enc: string }>();
  const out = [];
  for (const f of results) {
    const k = dateFactKind(f.key);
    const df = parseDateFact(await repo.cipher.decrypt(f.value_enc, `facts:${f.id}:value`));
    if (!k || !df) continue;
    const on = k.yearly ? nextAnniversary(df, today) : df.year != null ? { year: df.year, month: df.month, day: df.day } : null;
    if (!on) continue;
    const d = daysUntil(on, today);
    if (d < 0 || d > days) continue;
    const who = f.subject_type === "person" && f.subject_id ? (people.get(f.subject_id)?.name ?? null) : null;
    out.push({
      fact_id: f.id,
      key: f.key,
      label: k.label,
      who,
      person_id: f.subject_type === "person" ? f.subject_id : null,
      date: civilToIso(on),
      days: d,
      age: f.key === "birthday" && df.year ? ageOn({ year: df.year, month: df.month, day: df.day }, on) : null,
    });
  }
  return out.sort((a, b) => a.days - b.days);
}

async function itemsOf(repo: Repo, subtypes: string[], status: "open" | "all", limit = 300): Promise<ItemRow[]> {
  if (!subtypes.length) return [];
  const ph = subtypes.map(() => "?").join(",");
  const sql = `SELECT * FROM items WHERE subtype IN (${ph})${status === "open" ? " AND status = 'open'" : ""} ORDER BY created_at DESC LIMIT ${limit}`;
  return (await repo.db.prepare(sql).bind(...subtypes).all<ItemRow>()).results;
}

async function study(repo: Repo, tz: string) {
  const rows = await itemsOf(repo, ["study_session"], "all", 1000);
  const sessions = await Promise.all(
    rows.map(async (r) => ({ date: civilToIso(civilOf(new Date(r.created_at), tz)), minutes: Number((await readAttrs(repo, r)).minutes) || 30 })),
  );
  return studyStats(sessions, civilOf(new Date(), tz));
}

/** Overview: counts per category, the next important dates, money balances, study streak. */
export async function lifeSummary(repo: Repo, tz: string): Promise<Response> {
  const { results } = await repo.db
    .prepare("SELECT subtype, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open, COUNT(*) AS total FROM items WHERE subtype IS NOT NULL GROUP BY subtype")
    .all<{ subtype: string; open: number; total: number }>();
  const counts = new Map(results.map((r) => [r.subtype, r]));
  const debts = await itemsOf(repo, ["debt"], "open");
  const debtData = await Promise.all(debts.map(async (r) => ({ r, a: await readAttrs(repo, r) })));
  const people = new Map((await repo.people()).map((p) => [p.id, p.name]));
  const bal = balances(
    debtData
      .map(({ r, a }) => ({ person_id: r.for_person_id, direction: a.direction === "i_owe_them" ? ("i_owe_them" as const) : ("they_owe_me" as const), amount: attrMoney(a, "amount")!, open: true }))
      .filter((d) => d.amount),
  ).map((b) => ({ ...b, name: (b.person_id && people.get(b.person_id)) || "Someone" }));
  const thingCount = await repo.db.prepare("SELECT COUNT(*) AS n FROM things").first<{ n: number }>();
  return json({
    groups: GROUPS.map((g) => ({
      ...g,
      categories: CATEGORIES.filter((c) => c.group === g.id).map((c) => ({ subtype: c.subtype, open: counts.get(c.subtype)?.open ?? 0, total: counts.get(c.subtype)?.total ?? 0 })),
    })),
    dates: await upcomingDates(repo, tz, 60),
    balances: bal,
    study: await study(repo, tz),
    things: thingCount?.n ?? 0,
  });
}

export async function listLifeItems(repo: Repo, url: URL): Promise<Response> {
  const subtypes = (url.searchParams.get("subtype") ?? "").split(",").filter((s) => category(s));
  if (!subtypes.length) throw new HttpError(400, "bad_subtype");
  const status = url.searchParams.get("status") === "all" ? "all" : "open";
  return json({ items: await repo.itemViews(await itemsOf(repo, subtypes, status)) });
}

interface CreateBody {
  subtype?: unknown;
  title?: unknown;
  details?: unknown;
  for_person_id?: unknown;
  /** Typed name: matched to an existing person or created. Used when no id is given. */
  for_person_name?: unknown;
  attrs?: unknown;
  date?: unknown;
  end_date?: unknown;
  time?: unknown;
  recurrence?: unknown;
  thing_name?: unknown;
  thing_kind?: unknown;
}

/** Create a categorised item from a form (the same rules as a parsed capture). */
export async function createLifeItem(repo: Repo, req: Request, tz: string): Promise<Response> {
  const b = await readJson<CreateBody>(req);
  const cat = category(typeof b.subtype === "string" ? b.subtype : null);
  if (!cat) throw new HttpError(400, "bad_subtype");
  const title = str(b.title, "title", 200).trim();
  if (!title) throw new HttpError(400, "empty_title");
  const details = b.details == null ? null : str(b.details, "details", 2000).trim() || null;
  let personId: string | null = null;
  if (b.for_person_id != null) {
    personId = str(b.for_person_id, "for_person_id", 40);
    if (!(await repo.people()).some((p) => p.id === personId)) throw new HttpError(400, "bad_person");
  } else if (b.for_person_name != null && b.for_person_name !== "") {
    personId = (await personFromTypedName(repo, str(b.for_person_name, "for_person_name", 80)))?.id ?? null;
  }
  if (b.attrs != null && (typeof b.attrs !== "object" || Array.isArray(b.attrs))) throw new HttpError(400, "bad_attrs");
  const recurrence = b.recurrence == null || b.recurrence === "" ? null : str(b.recurrence, "recurrence", 200);
  if (recurrence && !parseRule(recurrence)) throw new HttpError(400, "bad_recurrence");
  const now = new Date();
  let win: { start: string; end: string; due: string | null } | null = null;
  if (b.date != null && b.date !== "") {
    const date = str(b.date, "date", 10);
    const end = b.end_date ? str(b.end_date, "end_date", 10) : date;
    const time = b.time ? str(b.time, "time", 5) : null;
    if (!parseCivil(date) || !parseCivil(end)) throw new HttpError(400, "bad_date");
    const r = resolveTimeRef(time ? { type: "date", date, time } : { type: "range", date, end_date: end }, now, tz)!;
    win = { start: r.start.toISOString(), end: r.end.toISOString(), due: r.dueAt?.toISOString() ?? null };
  } else if (recurrence) {
    const f = firstWindow(recurrence, now, tz);
    if (f) win = { start: f.window_start!, end: f.window_end!, due: null };
  }
  const id = ulid();
  const iso = now.toISOString();
  await repo.db
    .prepare(
      `INSERT INTO items (id, capture_id, kind, subtype, title_enc, details_enc, for_person_id, window_start, window_end, due_at, status, confidence, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)`,
    )
    .bind(id, cat.kind, cat.subtype, await repo.cipher.encrypt(title, `items:${id}:title`), await repo.cipher.encryptNullable(details, `items:${id}:details`), personId, win?.start ?? null, win?.end ?? null, win?.due ?? null, iso, iso)
    .run();
  const thingName = b.thing_name ? str(b.thing_name, "thing_name", 80).trim() : "";
  const errors = await applyCategory(
    repo,
    id,
    { subtype: cat.subtype, attrs: (b.attrs as Record<string, unknown>) ?? {}, thing: cat.thing && thingName ? { name: thingName, kind: typeof b.thing_kind === "string" ? b.thing_kind : "other" } : null, recurrence },
    tz,
    (await getSetting(repo.db, "currency")) ?? "USD",
  );
  await repo.event("create", { itemId: id, payload: { subtype: cat.subtype, form: true } });
  const row = (await repo.getItemRow(id))!;
  return json({ item: (await repo.itemViews([row]))[0], warnings: errors });
}

/** Replace a categorised item's attributes and/or recurrence; triggers follow. */
export async function patchLifeItem(repo: Repo, req: Request, id: string, tz: string): Promise<Response> {
  const row = await repo.getItemRow(id);
  if (!row || !category(row.subtype)) throw new HttpError(404, "not_found");
  const b = await readJson<{ attrs?: unknown; recurrence?: unknown }>(req);
  const sets: string[] = [];
  const params: (string | null)[] = [];
  if (b.attrs !== undefined) {
    if (typeof b.attrs !== "object" || b.attrs === null || Array.isArray(b.attrs)) throw new HttpError(400, "bad_attrs");
    const { attrs, errors } = coerceAttrs(row.subtype!, b.attrs as Record<string, unknown>, (await getSetting(repo.db, "currency")) ?? "USD");
    if (errors.length) throw new HttpError(400, "bad_attrs", errors.join(", "));
    sets.push("attrs_enc = ?");
    params.push(await writeAttrs(repo, id, attrs));
  }
  if (b.recurrence !== undefined) {
    const r = b.recurrence === null || b.recurrence === "" ? null : str(b.recurrence, "recurrence", 200);
    if (r && !parseRule(r)) throw new HttpError(400, "bad_recurrence");
    sets.push("recurrence = ?");
    params.push(r);
  }
  if (!sets.length) throw new HttpError(400, "nothing_to_change");
  await repo.db.prepare(`UPDATE items SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...params, new Date().toISOString(), id).run();
  const fresh = (await repo.getItemRow(id))!;
  await syncItemTriggers(repo, fresh, tz);
  await repo.event("correction", { itemId: id, payload: { fields: [...(b.attrs !== undefined ? ["attrs"] : []), ...(b.recurrence !== undefined ? ["recurrence"] : [])] } });
  return json({ item: (await repo.itemViews([fresh]))[0] });
}

export async function upcoming(repo: Repo, url: URL, tz: string): Promise<Response> {
  const days = Math.min(400, Math.max(1, Number(url.searchParams.get("days") ?? 60) || 60));
  return json({ dates: await upcomingDates(repo, tz, days) });
}

// ---- things (home inventory) ----

export async function listThings(repo: Repo): Promise<Response> {
  const all = await things(repo);
  const { results: counts } = await repo.db
    .prepare("SELECT target_id, COUNT(*) AS n FROM links WHERE target_type = 'thing' GROUP BY target_id")
    .all<{ target_id: string; n: number }>();
  const n = new Map(counts.map((c) => [c.target_id, c.n]));
  return json({ things: all.map((t) => ({ ...t, items: n.get(t.id) ?? 0 })) });
}

export async function getThing(repo: Repo, id: string): Promise<Response> {
  const t = (await things(repo)).find((x) => x.id === id);
  if (!t) throw new HttpError(404, "not_found");
  const { results } = await repo.db
    .prepare("SELECT i.* FROM items i JOIN links l ON l.item_id = i.id WHERE l.target_type = 'thing' AND l.target_id = ? ORDER BY i.created_at DESC LIMIT 100")
    .bind(id)
    .all<ItemRow>();
  const { results: facts } = await repo.db
    .prepare("SELECT id, key, value_enc, created_at FROM facts WHERE subject_type = 'thing' AND subject_id = ? AND active = 1")
    .bind(id)
    .all<{ id: string; key: string; value_enc: string; created_at: string }>();
  return json({
    thing: t,
    items: await repo.itemViews(results),
    facts: await Promise.all(facts.map(async (f) => ({ id: f.id, key: f.key, created_at: f.created_at, value: await repo.cipher.decrypt(f.value_enc, `facts:${f.id}:value`) }))),
  });
}

const THING_ATTRS = ["location", "size", "model", "serial", "notes"];

export async function createThingRoute(repo: Repo, req: Request): Promise<Response> {
  const b = await readJson<{ name?: unknown; kind?: unknown; attrs?: Record<string, unknown> }>(req);
  const name = str(b.name, "name", 80).trim();
  if (!name) throw new HttpError(400, "empty_name");
  const attrs: Record<string, string> = {};
  for (const k of THING_ATTRS) if (typeof b.attrs?.[k] === "string" && (b.attrs[k] as string).trim()) attrs[k] = (b.attrs[k] as string).trim().slice(0, 300);
  return json({ thing: await createThing(repo, name, typeof b.kind === "string" ? b.kind : "other", attrs) });
}

export async function patchThing(repo: Repo, req: Request, id: string): Promise<Response> {
  const row = await repo.db.prepare("SELECT id FROM things WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "not_found");
  const b = await readJson<{ name?: unknown; attrs?: Record<string, unknown> }>(req);
  if (b.name !== undefined) {
    const name = str(b.name, "name", 80).trim();
    if (!name) throw new HttpError(400, "empty_name");
    await repo.db.prepare("UPDATE things SET name_enc = ?, updated_at = ? WHERE id = ?").bind(await repo.cipher.encrypt(name, `things:${id}:name`), new Date().toISOString(), id).run();
  }
  if (b.attrs && typeof b.attrs === "object") {
    const patch: Record<string, string | null> = {};
    for (const k of THING_ATTRS) if (k in b.attrs) patch[k] = b.attrs[k] == null ? null : str(b.attrs[k], k, 300);
    await updateThingAttrs(repo, id, patch);
  }
  return getThing(repo, id);
}

export async function deleteThing(repo: Repo, id: string): Promise<Response> {
  await repo.db.batch([
    repo.db.prepare("DELETE FROM links WHERE target_type = 'thing' AND target_id = ?").bind(id),
    repo.db.prepare("DELETE FROM facts WHERE subject_type = 'thing' AND subject_id = ?").bind(id),
    repo.db.prepare("DELETE FROM things WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

// ---- seasonal starter ----

export async function addSeasonalStarter(repo: Repo, tz: string): Promise<Response> {
  const existing = await repo.itemViews(await itemsOf(repo, ["seasonal"], "all"));
  const have = new Set(existing.map((i) => i.title.toLowerCase()));
  const now = new Date();
  let added = 0;
  for (const t of SEASONAL_TEMPLATES) {
    if (have.has(t.title.toLowerCase())) continue;
    const w = firstWindow(t.rrule, now, tz);
    const id = ulid();
    const iso = now.toISOString();
    await repo.db
      .prepare(
        `INSERT INTO items (id, kind, subtype, title_enc, attrs_enc, window_start, window_end, status, recurrence, confidence, created_at, updated_at)
         VALUES (?, 'task', 'seasonal', ?, ?, ?, ?, 'open', ?, 1, ?, ?)`,
      )
      .bind(id, await repo.cipher.encrypt(t.title, `items:${id}:title`), await writeAttrs(repo, id, { weather: t.weather }), w?.window_start ?? null, w?.window_end ?? null, t.rrule, iso, iso)
      .run();
    added++;
  }
  return json({ added });
}

// ---- tips ----

export async function getTips(repo: Repo, tz: string): Promise<Response> {
  return json({ tips: await currentTips(repo, new Date(), tz) });
}

export async function postTip(repo: Repo, req: Request, id: string): Promise<Response> {
  const b = await readJson<{ action?: unknown }>(req);
  if (b.action !== "act" && b.action !== "snooze" && b.action !== "dismiss") throw new HttpError(400, "bad_action");
  if (!(await actOnTip(repo, id, b.action, new Date()))) throw new HttpError(404, "not_found");
  return json({ ok: true });
}

// ---- ideas digest ----

/** Ideas from the last N days (default 7), grouped by meaning using the stored embeddings. */
export async function ideasDigest(repo: Repo, url: URL, tz: string): Promise<Response> {
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7));
  const since = new Date(Date.now() - days * DAY).toISOString();
  const { results } = await repo.db
    .prepare("SELECT * FROM items WHERE subtype = 'idea' AND created_at >= ? ORDER BY created_at LIMIT 200")
    .bind(since)
    .all<ItemRow>();
  const views = await repo.itemViews(results);
  const ids = results.map((r) => r.id);
  const vecs: { id: string; vec: Float32Array }[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results: vs } = await repo.db
      .prepare(`SELECT item_id, vec FROM capture_vectors WHERE item_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ item_id: string; vec: ArrayBuffer }>();
    for (const v of vs) vecs.push({ id: v.item_id, vec: new Float32Array(v.vec instanceof ArrayBuffer ? v.vec : new Uint8Array(v.vec as unknown as number[]).buffer) });
  }
  const clustered = new Set(vecs.map((v) => v.id));
  const groups = clusterByCosine(vecs, 0.78);
  for (const id of ids) if (!clustered.has(id)) groups.push([id]);
  const byId = new Map(views.map((v) => [v.id, v]));
  const open = await repo.db.prepare("SELECT COUNT(*) AS n FROM items WHERE subtype = 'idea' AND status = 'open'").first<{ n: number }>();
  return json({
    days,
    from: civilToIso(addDays(civilOf(new Date(), tz), -days)),
    count: views.length,
    open_total: open?.n ?? 0,
    groups: groups.map((g) => g.map((id) => byId.get(id)).filter(Boolean)),
  });
}
