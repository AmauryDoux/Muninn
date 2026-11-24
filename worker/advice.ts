// Proactive tips: build the rule input from the database, store candidates, apply the user's feedback.
// Rules live in worker/core/tips.ts (pure, tested). The model only rewords, once a day, and its text is
// discarded unless it keeps every number and name of the code-written draft.
import { wordTips } from "./ai";
import type { Attrs } from "./core/categories";
import { computePatterns } from "./core/patterns";
import { parseOpenMeteo, weatherSignals, type DayForecast } from "./core/seasonal";
import { generateTips, rewordIsFaithful, selectTips, type Because, type RuleFeedback, type TipInput, type TipItem } from "./core/tips";
import { civilOf, civilToIso, localParts, startOfLocalDay } from "./core/time";
import { getSetting, setSetting } from "./lib/settings";
import { ulid } from "./lib/ulid";
import type { ItemRow, Repo } from "./repo";

const DAY = 86_400_000;

async function tipInput(repo: Repo, now: Date, tz: string): Promise<TipInput> {
  const db = repo.db;
  const today = civilOf(now, tz);
  const people = await repo.people();
  const { results: factRows } = await db
    .prepare("SELECT id, subject_type, subject_id, key, value_enc, created_at, review_after FROM facts WHERE active = 1 AND subject_type != 'thing' LIMIT 1000")
    .all<{ id: string; subject_type: string; subject_id: string | null; key: string; value_enc: string; created_at: string; review_after: string | null }>();
  const facts = await Promise.all(factRows.map(async ({ value_enc, ...f }) => ({ ...f, value: await repo.cipher.decrypt(value_enc, `facts:${f.id}:value`) })));
  const since = new Date(now.getTime() - 90 * DAY).toISOString();
  const { results: rows } = await db
    .prepare("SELECT * FROM items WHERE status = 'open' OR (status = 'done' AND updated_at >= ? AND subtype IN ('study_session', 'cert')) ORDER BY created_at DESC LIMIT 1500")
    .bind(since)
    .all<ItemRow>();
  const dayStart = startOfLocalDay(today, tz);
  const items: TipItem[] = await Promise.all(
    rows.map(async (r) => {
      const when = r.due_at ?? r.window_start;
      const overdue = r.due_at ? new Date(r.due_at) < now : r.window_end ? new Date(r.window_end) <= dayStart : false;
      return {
        id: r.id,
        kind: r.kind,
        subtype: r.subtype,
        title: await repo.cipher.decrypt(r.title_enc, `items:${r.id}:title`),
        status: r.status,
        person_id: r.for_person_id,
        requested_by_id: r.requested_by_person_id,
        place_hint: r.place_hint,
        attrs: r.attrs_enc ? (JSON.parse(await repo.cipher.decrypt(r.attrs_enc, `items:${r.id}:attrs`)) as Attrs) : null,
        date: when ? civilToIso(civilOf(new Date(when), tz)) : r.subtype === "study_session" ? civilToIso(civilOf(new Date(r.created_at), tz)) : null,
        overdue: r.status === "open" && overdue,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    }),
  );
  const { results: snoozes } = await db
    .prepare("SELECT item_id, COUNT(*) AS n FROM events WHERE type = 'snooze' AND at >= ? AND item_id IS NOT NULL GROUP BY item_id")
    .bind(new Date(now.getTime() - 60 * DAY).toISOString())
    .all<{ item_id: string; n: number }>();
  const { results: pats } = await db.prepare("SELECT key, value_json FROM patterns WHERE active = 1").all<{ key: string; value_json: string }>();
  const patterns: Record<string, Record<string, unknown>> = {};
  for (const p of pats) {
    try {
      patterns[p.key] = JSON.parse(p.value_json);
    } catch {
      /* skip */
    }
  }
  return {
    today,
    localHour: localParts(now, tz).hour,
    people,
    facts,
    items,
    snoozeCounts: new Map(snoozes.map((s) => [s.item_id, s.n])),
    patterns,
    weather: await cachedWeather(repo),
  };
}

/** Recompute candidate tips and store them. Cheap (no model) unless `reword` is set. */
export async function refreshTips(repo: Repo, now: Date, tz: string, reword: boolean): Promise<void> {
  const db = repo.db;
  const candidates = generateTips(await tipInput(repo, now, tz));
  const { results: existing } = await db.prepare("SELECT id, key, status, snoozed_until FROM tips").all<{ id: string; key: string; status: string; snoozed_until: string | null }>();
  const byKey = new Map(existing.map((e) => [e.key, e]));
  const iso = now.toISOString();
  const seen = new Set<string>();
  const stmts: D1PreparedStatement[] = [];
  const fresh: { id: string; draft: string; keep: string[] }[] = [];
  for (const t of candidates) {
    seen.add(t.key);
    const e = byKey.get(t.key);
    if (e && (e.status === "dismissed" || e.status === "acted")) continue; // the user's answer stands
    if (e && e.status === "snoozed" && e.snoozed_until && e.snoozed_until > iso) continue;
    const id = e?.id ?? ulid();
    const content = await repo.cipher.encrypt(JSON.stringify({ title: t.title, body: t.body, because: t.because, keep: t.keep }), `tips:${id}:content`);
    if (e) {
      stmts.push(
        db.prepare("UPDATE tips SET status = 'active', score = ?, domain = ?, item_id = ?, content_enc = ?, expires_on = ?, snoozed_until = NULL, updated_at = ? WHERE id = ?").bind(t.score, t.domain, t.item_id, content, t.expires, iso, id),
      );
    } else {
      stmts.push(
        db
          .prepare("INSERT INTO tips (id, rule, key, status, score, domain, item_id, content_enc, wording_enc, expires_on, snoozed_until, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, NULL, ?, NULL, ?, ?)")
          .bind(id, t.rule, t.key, t.score, t.domain, t.item_id, content, t.expires, iso, iso),
      );
      fresh.push({ id, draft: `${t.title}. ${t.body}`, keep: t.keep });
    }
  }
  // Tips whose condition no longer holds (the gift got bought, the debt settled) go away.
  for (const e of existing) if (e.status === "active" && !seen.has(e.key)) stmts.push(db.prepare("UPDATE tips SET status = 'expired', updated_at = ? WHERE id = ?").bind(iso, e.id));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));

  if (reword && fresh.length && (await getSetting(db, "tips_ai")) === "1") {
    try {
      const words = await wordTips(repo.env, fresh.slice(0, 8).map(({ id, draft }) => ({ id, draft })));
      for (const f of fresh) {
        const text = words.get(f.id);
        if (text && rewordIsFaithful(f.draft, f.keep, text)) {
          await db.prepare("UPDATE tips SET wording_enc = ? WHERE id = ?").bind(await repo.cipher.encrypt(text, `tips:${f.id}:wording`), f.id).run();
        }
      }
    } catch (e) {
      console.warn("tip wording failed", e instanceof Error ? e.message : e);
    }
  }
  await setSetting(db, "tips_refreshed_at", iso);
}

export interface TipView {
  id: string;
  rule: string;
  title: string;
  body: string;
  wording: string | null;
  because: Because[];
  domain: string;
  item_id: string | null;
}

async function feedback(repo: Repo, now: Date): Promise<Record<string, RuleFeedback>> {
  const { results } = await repo.db
    .prepare("SELECT rule, status, COUNT(*) AS n FROM tips WHERE status IN ('acted', 'dismissed') AND updated_at >= ? GROUP BY rule, status")
    .bind(new Date(now.getTime() - 90 * DAY).toISOString())
    .all<{ rule: string; status: string; n: number }>();
  const out: Record<string, RuleFeedback> = {};
  for (const r of results) {
    const f = (out[r.rule] ??= { acted: 0, dismissed: 0 });
    if (r.status === "acted") f.acted = r.n;
    else f.dismissed = r.n;
  }
  return out;
}

/** The tips to show now (at most `max`), refreshed when the stored set is older than 6 hours. */
export async function currentTips(repo: Repo, now: Date, tz: string, max = 3): Promise<TipView[]> {
  if ((await getSetting(repo.db, "tips_enabled")) === "0") return [];
  const last = await getSetting(repo.db, "tips_refreshed_at");
  if (!last || now.getTime() - Date.parse(last) > 6 * 3600_000) await refreshTips(repo, now, tz, false);
  const today = civilToIso(civilOf(now, tz));
  const { results } = await repo.db
    .prepare("SELECT * FROM tips WHERE status = 'active' AND (expires_on IS NULL OR expires_on >= ?) ORDER BY score DESC LIMIT 50")
    .bind(today)
    .all<{ id: string; rule: string; key: string; score: number; domain: string; item_id: string | null; content_enc: string; wording_enc: string | null; expires_on: string }>();
  const picked = selectTips(
    results.map((r) => ({ rule: r.rule, key: r.key, score: r.score, title: "", body: "", because: [], domain: "none" as const, item_id: r.item_id, expires: r.expires_on, keep: [] })),
    { hidden: new Set(), feedback: await feedback(repo, now), max },
  );
  const byKey = new Map(results.map((r) => [r.key, r]));
  return Promise.all(
    picked.map(async (p) => {
      const r = byKey.get(p.key)!;
      const c = JSON.parse(await repo.cipher.decrypt(r.content_enc, `tips:${r.id}:content`)) as { title: string; body: string; because: Because[] };
      return {
        id: r.id,
        rule: r.rule,
        title: c.title,
        body: c.body,
        wording: r.wording_enc ? await repo.cipher.decrypt(r.wording_enc, `tips:${r.id}:wording`) : null,
        because: c.because,
        domain: r.domain,
        item_id: r.item_id,
      };
    }),
  );
}

export async function actOnTip(repo: Repo, id: string, action: "act" | "snooze" | "dismiss", now: Date): Promise<boolean> {
  const iso = now.toISOString();
  const res =
    action === "snooze"
      ? await repo.db.prepare("UPDATE tips SET status = 'snoozed', snoozed_until = ?, updated_at = ? WHERE id = ?").bind(new Date(now.getTime() + 7 * DAY).toISOString(), iso, id).run()
      : await repo.db.prepare("UPDATE tips SET status = ?, updated_at = ? WHERE id = ?").bind(action === "act" ? "acted" : "dismissed", iso, id).run();
  if (res.meta.changes) await repo.event(`tip_${action}`, { payload: { tip: id } });
  return res.meta.changes > 0;
}

// ---- patterns (nightly) ----

export async function refreshPatterns(repo: Repo, now: Date, tz: string): Promise<void> {
  const db = repo.db;
  const { results: events } = await db
    .prepare("SELECT at, type, item_id, payload_json FROM events WHERE type IN ('done', 'snooze') AND at >= ? LIMIT 5000")
    .bind(new Date(now.getTime() - 90 * DAY).toISOString())
    .all<{ at: string; type: string; item_id: string | null; payload_json: string | null }>();
  const ids = [...new Set(events.map((e) => e.item_id).filter((x): x is string => !!x))];
  const places = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db.prepare(`SELECT id, place_hint FROM items WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ id: string; place_hint: string | null }>();
    for (const r of results) places.set(r.id, r.place_hint);
  }
  const out = computePatterns(events, (id) => places.get(id) ?? null, now, tz);
  const iso = now.toISOString();
  const stmts = out.map((p) =>
    db
      .prepare(
        `INSERT INTO patterns (id, key, value_json, sample_size, computed_at, active, user_locked) VALUES (?, ?, ?, ?, ?, 1, 0)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, sample_size = excluded.sample_size, computed_at = excluded.computed_at
         WHERE patterns.user_locked = 0`,
      )
      .bind(ulid(), p.key, JSON.stringify(p.value), p.sample, iso),
  );
  if (stmts.length) await db.batch(stmts);
}

// ---- weather (daily, opt-in) ----

/** Fetch a 7-day forecast for the saved home location from Open-Meteo (free, no key). */
export async function refreshWeather(repo: Repo): Promise<void> {
  const lat = Number(await getSetting(repo.db, "home_lat"));
  const lon = Number(await getSetting(repo.db, "home_lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&daily=temperature_2m_min,temperature_2m_max&forecast_days=7&timezone=auto`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`weather ${res.status}`);
  const days = parseOpenMeteo(await res.json());
  if (days.length) await setSetting(repo.db, "weather", JSON.stringify({ at: new Date().toISOString(), days }));
}

export async function cachedWeather(repo: Repo) {
  const raw = await getSetting(repo.db, "weather");
  if (!raw) return null;
  try {
    const w = JSON.parse(raw) as { at: string; days: DayForecast[] };
    if (Date.now() - Date.parse(w.at) > 2 * DAY) return null;
    return weatherSignals(w.days);
  } catch {
    return null;
  }
}

