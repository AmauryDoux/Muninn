import { personFromTypedName } from "./capture";
import { rollRecurring } from "../core/recurring";
import { snoozeUntil, type ReminderSettings } from "../core/reminders";
import { syncItemTriggers } from "../engine";
import { addDays, civilOf, parseCivil, resolveTimeRef, startOfLocalDay } from "../core/time";
import { deleteItemFiles } from "./files";
import { HttpError, json, readJson, str } from "../lib/http";
import type { ItemRow, Repo } from "../repo";

const KINDS = new Set(["task", "note", "fact", "event"]);

export async function listItems(repo: Repo, url: URL): Promise<Response> {
  const view = url.searchParams.get("view") ?? "open";
  let rows: ItemRow[];
  if (view === "open") {
    rows = (await repo.db.prepare("SELECT * FROM items WHERE status = 'open' ORDER BY created_at DESC LIMIT 500").all<ItemRow>()).results;
  } else if (view === "done") {
    rows = (
      await repo.db.prepare("SELECT * FROM items WHERE status IN ('done', 'dropped') ORDER BY updated_at DESC LIMIT 100").all<ItemRow>()
    ).results;
  } else if (view === "recent") {
    rows = (await repo.db.prepare("SELECT * FROM items ORDER BY created_at DESC LIMIT 50").all<ItemRow>()).results;
  } else throw new HttpError(400, "bad_view");
  return json({ items: await repo.itemViews(rows) });
}

export async function getItem(repo: Repo, id: string): Promise<Response> {
  const row = await repo.getItemRow(id);
  if (!row) throw new HttpError(404, "not_found");
  return json({ item: (await repo.itemViews([row]))[0] });
}

interface Patch {
  title?: unknown;
  details?: unknown;
  kind?: unknown;
  for_person_id?: unknown;
  requested_by_person_id?: unknown;
  /** Typed names, matched or created; an empty string clears. */
  for_person_name?: unknown;
  requested_by_name?: unknown;
  place_hint?: unknown;
  start_date?: unknown; // YYYY-MM-DD or null to clear
  end_date?: unknown;
  due_at?: unknown; // ISO or null
}

/** A fix from the confirmation line or the item screen. Logged as a correction event (field names only in clear). */
export async function patchItem(repo: Repo, req: Request, id: string, tz: string): Promise<Response> {
  const row = await repo.getItemRow(id);
  if (!row) throw new HttpError(404, "not_found");
  const p = await readJson<Patch>(req);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set = (col: string, val: string | number | null, label = col, old: unknown = (row as unknown as Record<string, unknown>)[col]) => {
    sets.push(`${col} = ?`);
    params.push(val);
    before[label] = old;
    after[label] = val;
  };

  if (p.title !== undefined) {
    const t = str(p.title, "title", 200).trim();
    if (!t) throw new HttpError(400, "empty_title");
    set("title_enc", await repo.cipher.encrypt(t, `items:${id}:title`), "title", await repo.cipher.decrypt(row.title_enc, `items:${id}:title`));
    after.title = t;
  }
  if (p.details !== undefined) {
    const d = p.details === null ? null : str(p.details, "details", 2000);
    set("details_enc", await repo.cipher.encryptNullable(d || null, `items:${id}:details`), "details", await repo.cipher.decryptNullable(row.details_enc, `items:${id}:details`));
    after.details = d;
  }
  if (p.kind !== undefined) {
    if (typeof p.kind !== "string" || !KINDS.has(p.kind)) throw new HttpError(400, "bad_kind");
    set("kind", p.kind);
  }
  for (const [nameKey, col] of [["for_person_name", "for_person_id"], ["requested_by_name", "requested_by_person_id"]] as const) {
    const v = p[nameKey];
    if (v === undefined || p[col] !== undefined) continue;
    p[col] = v === null || v === "" ? null : ((await personFromTypedName(repo, str(v, nameKey, 80)))?.id ?? null);
  }
  const people = new Set((await repo.people()).map((x) => x.id));
  for (const col of ["for_person_id", "requested_by_person_id"] as const) {
    const v = p[col];
    if (v === undefined) continue;
    if (v !== null && (typeof v !== "string" || !people.has(v))) throw new HttpError(400, "bad_person");
    set(col, v as string | null);
  }
  if (p.place_hint !== undefined) set("place_hint", p.place_hint === null ? null : str(p.place_hint, "place_hint", 100));
  if (p.start_date !== undefined || p.end_date !== undefined || p.due_at !== undefined) {
    if (p.due_at != null) {
      const due = new Date(str(p.due_at, "due_at", 40));
      if (Number.isNaN(due.getTime())) throw new HttpError(400, "bad_due_at");
      set("due_at", due.toISOString());
      set("window_start", due.toISOString());
      set("window_end", startOfLocalDay(addDays(civilOf(due, tz), 1), tz).toISOString());
    } else if (p.start_date === null) {
      set("due_at", null);
      set("window_start", null);
      set("window_end", null);
    } else {
      const sd = str(p.start_date, "start_date", 10);
      const ed = p.end_date == null ? sd : str(p.end_date, "end_date", 10);
      if (!parseCivil(sd) || !parseCivil(ed)) throw new HttpError(400, "bad_date");
      const w = resolveTimeRef({ type: "range", date: sd, end_date: ed }, new Date(), tz)!;
      set("due_at", null);
      set("window_start", w.start.toISOString());
      set("window_end", w.end.toISOString());
    }
    // A new time means the reminders should fire again.
    set("reminded_start_at", null);
    set("reminded_end_at", null);
  }
  if (!sets.length) throw new HttpError(400, "nothing_to_change");
  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  await repo.db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`).bind(...params, id).run();
  // New wording: drop the old search vector; the cron re-embeds the item from its current text within minutes.
  if ((p.title !== undefined || p.details !== undefined) && row.capture_id) {
    await repo.db.prepare("DELETE FROM capture_vectors WHERE capture_id = ?").bind(row.capture_id).run();
  }
  // Dates and people feed category triggers ("prepare 7 days before the recital").
  if (row.subtype) await syncItemTriggers(repo, (await repo.getItemRow(id))!, tz);
  const fields = Object.keys(before).filter((k) => !k.startsWith("reminded_") && k !== "title_enc" && k !== "details_enc");
  await repo.event("correction", {
    itemId: id,
    payload: { fields, enc: await repo.cipher.encrypt(JSON.stringify({ before: pick(before, fields), after: pick(after, fields) }), `events:${id}:correction`) },
  });
  return getItem(repo, id);
}

function pick(o: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}

const SNOOZES = new Set(["1h", "evening", "tomorrow", "next_week"]);

export async function actOnItem(repo: Repo, req: Request, id: string, rs: ReminderSettings): Promise<Response> {
  const row = await repo.getItemRow(id);
  if (!row) throw new HttpError(404, "not_found");
  const body = await readJson<{ action?: unknown; preset?: unknown; nudge_type?: unknown }>(req);
  const now = new Date();
  const iso = now.toISOString();
  const nudge = typeof body.nudge_type === "string" ? body.nudge_type.slice(0, 40) : null;
  // What an undo restores: only status and scheduling columns, no content.
  const prev: Record<string, string | null> = Object.fromEntries(UNDO_COLUMNS.map((c) => [c, row[c] as string | null]));
  switch (body.action) {
    case "done": {
      // A recurring item (pills, filters, seasonal chores) moves to its next occurrence instead of closing.
      const next = row.recurrence && row.status === "open" ? rollRecurring(row, row.recurrence, now, rs.tz) : null;
      if (next) {
        await repo.db
          .prepare("UPDATE items SET window_start = ?, window_end = ?, due_at = ?, snoozed_until = NULL, reminded_start_at = NULL, reminded_end_at = NULL, updated_at = ? WHERE id = ?")
          .bind(next.window_start, next.window_end, next.due_at, iso, id)
          .run();
      } else await repo.db.prepare("UPDATE items SET status = 'done', updated_at = ? WHERE id = ?").bind(iso, id).run();
      await repo.event("done", { itemId: id, nudgeType: nudge, payload: { recurring: !!next, prev } });
      break;
    }
    case "dismiss":
      await repo.db.prepare("UPDATE items SET status = 'dropped', updated_at = ? WHERE id = ?").bind(iso, id).run();
      await repo.event("dismiss", { itemId: id, nudgeType: nudge, payload: { prev } });
      break;
    case "reopen":
      await repo.db.prepare("UPDATE items SET status = 'open', updated_at = ? WHERE id = ?").bind(iso, id).run();
      await repo.event("reopen", { itemId: id });
      // A reopened warranty or debt needs its reminders back.
      if (row.subtype) await syncItemTriggers(repo, { ...row, status: "open" }, rs.tz);
      break;
    case "snooze": {
      if (typeof body.preset !== "string" || !SNOOZES.has(body.preset)) throw new HttpError(400, "bad_preset");
      const until = snoozeUntil(body.preset as "1h", now, rs);
      await repo.db
        .prepare("UPDATE items SET snoozed_until = ?, reminded_start_at = NULL, updated_at = ? WHERE id = ?")
        .bind(until.toISOString(), iso, id)
        .run();
      await repo.event("snooze", { itemId: id, nudgeType: nudge, payload: { preset: body.preset, prev } });
      break;
    }
    case "undo": {
      // Puts back the item as it was before the last done, dismiss or snooze, if that was in the last 10 minutes.
      const last = await repo.db
        .prepare("SELECT id, type, payload_json FROM events WHERE item_id = ? AND type IN ('done', 'dismiss', 'snooze') AND at >= ? ORDER BY at DESC LIMIT 1")
        .bind(id, new Date(now.getTime() - UNDO_WINDOW_MS).toISOString())
        .first<{ id: string; type: string; payload_json: string | null }>();
      const before = last?.payload_json ? (JSON.parse(last.payload_json) as { prev?: Record<string, string | null> }).prev : undefined;
      if (!last || !before) throw new HttpError(409, "nothing_to_undo", "Too late to undo.");
      await repo.db
        .prepare(`UPDATE items SET ${UNDO_COLUMNS.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...UNDO_COLUMNS.map((c) => before[c] ?? null), iso, id)
        .run();
      // The undone event no longer counts (tips learn from done/dismiss/snooze).
      await repo.db.prepare("UPDATE events SET type = ? WHERE id = ?").bind(`${last.type}_undone`, last.id).run();
      if (row.subtype) await syncItemTriggers(repo, (await repo.getItemRow(id))!, rs.tz);
      break;
    }
    case "act":
      // Opened from a nudge and acted on, without completing.
      await repo.event("act", { itemId: id, nudgeType: nudge });
      break;
    default:
      throw new HttpError(400, "bad_action");
  }
  return getItem(repo, id);
}

const UNDO_WINDOW_MS = 10 * 60_000;
const UNDO_COLUMNS = ["status", "window_start", "window_end", "due_at", "snoozed_until", "reminded_start_at", "reminded_end_at"] as const;

/** Hard delete, for things that should not be kept at all. Needs a fresh check. */
export async function deleteItem(repo: Repo, id: string): Promise<Response> {
  const row = await repo.getItemRow(id);
  if (!row) throw new HttpError(404, "not_found");
  await deleteItemFiles(repo, id);
  const stmts = [repo.db.prepare("DELETE FROM items WHERE id = ?").bind(id), repo.db.prepare("DELETE FROM events WHERE item_id = ?").bind(id)];
  if (row.capture_id) {
    stmts.push(repo.db.prepare("DELETE FROM capture_vectors WHERE capture_id = ?").bind(row.capture_id));
    stmts.push(repo.db.prepare("DELETE FROM captures WHERE id = ?").bind(row.capture_id));
  }
  await repo.db.batch(stmts);
  if (row.capture_id && repo.env.VECTORIZE) await repo.env.VECTORIZE.deleteByIds([row.capture_id]);
  return json({ ok: true });
}
