// Data access. Encrypts on the way in, decrypts on the way out. Callers never see ciphertext.
import type { Env } from "./env";
import type { Person } from "./core/people";
import { statusLine, type Attrs, type StatusLine } from "./core/categories";
import { describeRule, parseRule } from "./core/rrule";
import { civilOf } from "./core/time";
import { Cipher } from "./lib/crypto";
import { ulid } from "./lib/ulid";

export interface ItemRow {
  id: string;
  capture_id: string | null;
  kind: string;
  subtype: string | null;
  title_enc: string;
  details_enc: string | null;
  attrs_enc: string | null;
  for_person_id: string | null;
  requested_by_person_id: string | null;
  window_start: string | null;
  window_end: string | null;
  due_at: string | null;
  status: "open" | "done" | "dropped";
  place_hint: string | null;
  confidence: number | null;
  recurrence: string | null;
  snoozed_until: string | null;
  reminded_start_at: string | null;
  reminded_end_at: string | null;
  created_at: string;
  updated_at: string;
  source_trigger_id?: string | null;
}

export interface ItemView {
  id: string;
  kind: string;
  subtype: string | null;
  title: string;
  details: string | null;
  attrs: Record<string, unknown> | null;
  for_person: { id: string; name: string } | null;
  requested_by: { id: string; name: string } | null;
  window_start: string | null;
  window_end: string | null;
  due_at: string | null;
  status: string;
  place_hint: string | null;
  confidence: number | null;
  snoozed_until: string | null;
  recurrence: string | null;
  recurrence_text: string | null;
  status_line: StatusLine | null;
  thing: { id: string; name: string } | null;
  from_reminder: boolean;
  created_at: string;
  updated_at: string;
}

export class Repo {
  constructor(
    readonly env: Env,
    readonly cipher: Cipher,
    /** The user's time zone, for code-computed status lines. */
    public tz = "UTC",
  ) {}

  get db() {
    return this.env.DB;
  }

  async people(): Promise<Person[]> {
    const { results } = await this.db
      .prepare("SELECT id, name_enc, aliases_enc, relation FROM people ORDER BY created_at")
      .all<{ id: string; name_enc: string; aliases_enc: string; relation: string }>();
    return Promise.all(
      results.map(async (r) => ({
        id: r.id,
        name: await this.cipher.decrypt(r.name_enc, `people:${r.id}:name`),
        aliases: JSON.parse(await this.cipher.decrypt(r.aliases_enc, `people:${r.id}:aliases`)) as string[],
        relation: r.relation,
      })),
    );
  }

  async createPerson(name: string, relation: string, aliases: string[]): Promise<Person> {
    const id = ulid();
    const clean = [...new Set(aliases.map((a) => a.toLowerCase().trim()).filter(Boolean))].slice(0, 20);
    await this.db
      .prepare("INSERT INTO people (id, name_enc, aliases_enc, relation, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(
        id,
        await this.cipher.encrypt(name, `people:${id}:name`),
        await this.cipher.encrypt(JSON.stringify(clean), `people:${id}:aliases`),
        relation,
        new Date().toISOString(),
      )
      .run();
    return { id, name, aliases: clean, relation };
  }

  async updatePerson(p: Person): Promise<void> {
    await this.db
      .prepare("UPDATE people SET name_enc = ?, aliases_enc = ?, relation = ? WHERE id = ?")
      .bind(
        await this.cipher.encrypt(p.name, `people:${p.id}:name`),
        await this.cipher.encrypt(JSON.stringify(p.aliases), `people:${p.id}:aliases`),
        p.relation,
        p.id,
      )
      .run();
  }

  async itemView(r: ItemRow, peopleById: Map<string, Person>, thingOf: Map<string, { id: string; name: string }> = new Map()): Promise<ItemView> {
    const person = (id: string | null) => {
      const p = id ? peopleById.get(id) : null;
      return p ? { id: p.id, name: p.name } : null;
    };
    const attrs = r.attrs_enc ? (JSON.parse(await this.cipher.decrypt(r.attrs_enc, `items:${r.id}:attrs`)) as Record<string, unknown>) : null;
    const rule = r.recurrence ? parseRule(r.recurrence) : null;
    return {
      id: r.id,
      kind: r.kind,
      subtype: r.subtype,
      title: await this.cipher.decrypt(r.title_enc, `items:${r.id}:title`),
      details: await this.cipher.decryptNullable(r.details_enc, `items:${r.id}:details`),
      attrs,
      recurrence: r.recurrence,
      recurrence_text: rule ? describeRule(rule) : null,
      status_line: statusLine(r.subtype, attrs as Attrs | null, r.status, civilOf(new Date(), this.tz)),
      thing: thingOf.get(r.id) ?? null,
      from_reminder: !!r.source_trigger_id,
      for_person: person(r.for_person_id),
      requested_by: person(r.requested_by_person_id),
      window_start: r.window_start,
      window_end: r.window_end,
      due_at: r.due_at,
      status: r.status,
      place_hint: r.place_hint,
      confidence: r.confidence,
      snoozed_until: r.snoozed_until,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  async itemViews(rows: ItemRow[]): Promise<ItemView[]> {
    const byId = new Map((await this.people()).map((p) => [p.id, p]));
    const thingOf = new Map<string, { id: string; name: string }>();
    // Thing names for items about one (warranty, service, inventory). Chunked to stay under D1's bound-parameter limit.
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const { results } = await this.db
        .prepare(
          `SELECT l.item_id, t.id, t.name_enc FROM links l JOIN things t ON t.id = l.target_id
           WHERE l.target_type = 'thing' AND l.item_id IN (${chunk.map(() => "?").join(",")})`,
        )
        .bind(...chunk)
        .all<{ item_id: string; id: string; name_enc: string }>();
      for (const t of results) thingOf.set(t.item_id, { id: t.id, name: await this.cipher.decrypt(t.name_enc, `things:${t.id}:name`) });
    }
    return Promise.all(rows.map((r) => this.itemView(r, byId, thingOf)));
  }

  async getItemRow(id: string): Promise<ItemRow | null> {
    return this.db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<ItemRow>();
  }

  async event(type: string, opts: { itemId?: string | null; nudgeType?: string | null; payload?: unknown } = {}): Promise<void> {
    await this.db
      .prepare("INSERT INTO events (id, at, type, item_id, nudge_type, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(
        ulid(),
        new Date().toISOString(),
        type,
        opts.itemId ?? null,
        opts.nudgeType ?? null,
        opts.payload === undefined ? null : JSON.stringify(opts.payload),
      )
      .run();
  }

  async activeFactKeys(): Promise<{ subject_type: string; subject_id: string | null; key: string }[]> {
    const { results } = await this.db
      .prepare("SELECT subject_type, subject_id, key FROM facts WHERE active = 1")
      .all<{ subject_type: string; subject_id: string | null; key: string }>();
    return results;
  }

  async addFact(f: {
    subjectType: "person" | "me" | "thing";
    subjectId: string | null;
    key: string;
    value: string;
    source: "told" | "asked" | "observed";
    reviewAfter?: string | null;
  }): Promise<string> {
    const id = ulid();
    // A new value for the same subject and key replaces the old one (kept inactive, for history).
    await this.db.batch([
      this.db
        .prepare("UPDATE facts SET active = 0 WHERE subject_type = ? AND subject_id IS ? AND key = ? AND active = 1")
        .bind(f.subjectType, f.subjectId, f.key),
      this.db
        .prepare(
          "INSERT INTO facts (id, subject_type, subject_id, key, value_enc, source, confidence, review_after, created_at, active) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1)",
        )
        .bind(
          id,
          f.subjectType,
          f.subjectId,
          f.key,
          await this.cipher.encrypt(f.value, `facts:${id}:value`),
          f.source,
          f.reviewAfter ?? null,
          new Date().toISOString(),
        ),
    ]);
    return id;
  }
}
