// Proactive advice, computed by rules from what the user told Muninn and what it observed.
// Pure: no I/O, no model. The model may later reword a tip, but the facts, numbers and the
// "because" list come from here, so every tip can be traced to the memory it was built on.
import { attrDate, attrMoney, attrNum, attrText, dateFactKind, reviewMonthsFor, type Attrs, type Domain } from "./categories";
import { addDays, addMonths, ageOn, cmp, diffDays, nextAnniversary, parseCivil, parseDateFact, type CivilDate } from "./civil";
import { balances, formatMoney } from "./money";
import { normPlace, WEEKDAYS } from "./patterns";
import { describeWeather, weatherMatches, type WeatherSignals } from "./seasonal";
import { studyStats } from "./streaks";
import { daysUntil } from "./triggers";

export interface TipPerson {
  id: string;
  name: string;
  relation: string;
}
export interface TipFact {
  id: string;
  subject_type: string;
  subject_id: string | null;
  key: string;
  value: string;
  created_at: string; // ISO
  review_after: string | null;
}
export interface TipItem {
  id: string;
  kind: string;
  subtype: string | null;
  title: string;
  status: string;
  person_id: string | null;
  requested_by_id: string | null;
  place_hint: string | null;
  attrs: Attrs | null;
  /** Local date the item is scheduled for (window start or due), or null. */
  date: string | null;
  overdue: boolean;
  created_at: string; // ISO
  updated_at: string; // ISO
}

export interface TipInput {
  today: CivilDate;
  localHour: number;
  people: TipPerson[];
  facts: TipFact[];
  /** Open items, plus items done in the last 90 days (for streaks and history). */
  items: TipItem[];
  snoozeCounts: Map<string, number>;
  patterns: Record<string, Record<string, unknown>>;
  weather: WeatherSignals | null;
}

export interface Because {
  kind: "fact" | "item" | "pattern" | "weather";
  ref: string | null;
  text: string;
}

export interface Tip {
  rule: string;
  /** Dedupe key: a dismissed key never comes back; a new occurrence (next year's birthday) has a new key. */
  key: string;
  title: string;
  body: string;
  because: Because[];
  domain: Domain;
  /** 0..100 before feedback weighting. */
  score: number;
  item_id: string | null;
  /** Local date after which the tip is stale. */
  expires: string;
  /** Strings that any rewording must keep verbatim (names, amounts, dates). */
  keep: string[];
}

const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d: CivilDate) => `${d.day} ${M[d.month - 1]}`;
const iso = (d: CivilDate) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
const told = (f: TipFact) => {
  const d = parseCivil(f.created_at.slice(0, 10));
  return d ? ` (you told me on ${day(d)} ${d.year})` : "";
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const KIDS = new Set(["daughter", "son", "child"]);
const PARTNER = new Set(["wife", "husband", "partner"]);

/** Urgency in 0..1 for something `d` days away (today = 1, a month out = small). */
function urgency(d: number): number {
  return d <= 0 ? 1 : 1 / (1 + d / 7);
}

type Rule = (x: TipInput, ctx: Ctx) => Tip[];
interface Ctx {
  person: Map<string, TipPerson>;
  open: TipItem[];
}

const datePrep: Rule = (x, { person, open }) => {
  const out: Tip[] = [];
  for (const f of x.facts) {
    const kind = dateFactKind(f.key);
    if (!kind?.yearly || (f.key !== "birthday" && f.key !== "anniversary")) continue;
    const df = parseDateFact(f.value);
    if (!df) continue;
    const next = nextAnniversary(df, x.today);
    const d = daysUntil(next, x.today);
    if (d > 21) continue;
    // Whose gift: the person; for the user's own anniversary, their partner.
    const subject = f.subject_type === "person" && f.subject_id ? person.get(f.subject_id) : null;
    const recipient = subject ?? (f.key === "anniversary" ? [...person.values()].find((p) => PARTNER.has(p.relation)) : null);
    if (!recipient && f.key === "birthday") continue; // the user's own birthday: no gift prep
    const name = recipient?.name ?? "your partner";
    const what = f.key === "birthday" ? `${subject?.name ?? name}'s birthday` : "your anniversary";
    const age = f.key === "birthday" && df.year ? ageOn({ year: df.year, month: df.month, day: df.day }, next) : null;
    const ideas = open.filter((i) => i.subtype === "gift_idea" && recipient && i.person_id === recipient.id);
    const likes = recipient ? x.facts.filter((g) => g.subject_type === "person" && g.subject_id === recipient.id && /like|favou?rite|want|wish|into|love/.test(g.key)) : [];
    const because: Because[] = [{ kind: "fact", ref: f.id, text: `${what} is ${day(next)}${told(f)}` }];
    let body: string;
    if (ideas.length) {
      body = `Ideas you saved: ${list(ideas.slice(0, 3).map((i) => i.title))}.`;
      for (const i of ideas.slice(0, 3)) because.push({ kind: "item", ref: i.id, text: `you noted "${i.title}" for ${name}` });
    } else if (likes.length) {
      body = `No gift saved yet. You told me ${name} likes ${list(likes.slice(0, 3).map((l) => l.value))}.`;
      for (const l of likes.slice(0, 3)) because.push({ kind: "fact", ref: l.id, text: `${name}: ${l.key.replace(/_/g, " ")} = ${l.value}${told(l)}` });
    } else {
      body = `No gift ideas saved for ${name} yet. When they mention something they like, tell me and I'll keep it for this.`;
    }
    const when = d === 0 ? "is today" : d === 1 ? "is tomorrow" : `is in ${d} days`;
    out.push({
      rule: "date_prep",
      key: `date_prep:${f.id}:${next.year}`,
      title: `${what[0].toUpperCase()}${what.slice(1)} ${when}${age ? ` (turns ${age})` : ""}`,
      body,
      because,
      domain: "none",
      score: 60 + 40 * urgency(d - 3),
      item_id: ideas[0]?.id ?? null,
      expires: iso(next),
      keep: [name, ...ideas.slice(0, 3).map((i) => i.title)],
    });
  }
  return out;
};

const snoozeHabit: Rule = (x, { open }) => {
  const out: Tip[] = [];
  const dh = x.patterns.done_hour as { hour?: number } | undefined;
  for (const it of open) {
    const n = x.snoozeCounts.get(it.id) ?? 0;
    if (n < 3) continue;
    const better = typeof dh?.hour === "number" ? ` You usually get things done around ${String(dh.hour).padStart(2, "0")}:00; want to move it there?` : " Pick a time that works, break it into a smaller first step, or drop it.";
    const because: Because[] = [{ kind: "item", ref: it.id, text: `you snoozed "${it.title}" ${n} times` }];
    if (typeof dh?.hour === "number") because.push({ kind: "pattern", ref: "done_hour", text: `most of your completions happen around ${dh.hour}:00` });
    out.push({
      rule: "snooze_habit",
      key: `snooze_habit:${it.id}:${Math.floor(n / 3)}`,
      title: `You've snoozed "${it.title}" ${n} times`,
      body: better.trim(),
      because,
      domain: "none",
      score: 40 + Math.min(30, n * 5),
      item_id: it.id,
      expires: iso(addMonths(x.today, 1)),
      keep: [it.title],
    });
  }
  return out;
};

const staleFacts: Rule = (x, { person }) => {
  const byPerson = new Map<string, TipFact[]>();
  for (const f of x.facts) {
    if (f.subject_type !== "person" || !f.subject_id) continue;
    const p = person.get(f.subject_id);
    if (!p || !KIDS.has(p.relation)) continue;
    const months = reviewMonthsFor(f.key, p.relation);
    if (!months) continue;
    const created = parseCivil(f.created_at.slice(0, 10));
    const due = f.review_after ? parseCivil(f.review_after.slice(0, 10)) : created ? addMonths(created, months) : null;
    if (!due || cmp(due, x.today) > 0) continue;
    byPerson.set(p.id, [...(byPerson.get(p.id) ?? []), f]);
  }
  const out: Tip[] = [];
  for (const [pid, fs] of byPerson) {
    const p = person.get(pid)!;
    const keys = fs.map((f) => `${f.key.replace(/_/g, " ")} (${f.value})`);
    out.push({
      rule: "stale_fact",
      key: `stale_fact:${pid}:${fs.map((f) => f.id).sort().join(",")}`,
      title: `Check ${p.name}'s details`,
      body: `Kids change fast. These are getting old: ${list(keys.slice(0, 4))}. Still right?`,
      because: fs.slice(0, 4).map((f) => ({ kind: "fact" as const, ref: f.id, text: `${p.name}: ${f.key.replace(/_/g, " ")} = ${f.value}${told(f)}` })),
      domain: "none",
      score: 35,
      item_id: null,
      expires: iso(addMonths(x.today, 2)),
      keep: [p.name],
    });
  }
  return out;
};

const warrantyEnding: Rule = (x, { open }) =>
  open
    .filter((i) => i.subtype === "warranty")
    .flatMap((i) => {
      const end = attrDate(i.attrs, "expires_on");
      if (!end) return [];
      const d = daysUntil(end, x.today);
      if (d < 0 || d > 45) return [];
      const store = attrText(i.attrs, "store");
      return [
        {
          rule: "warranty_ending",
          key: `warranty_ending:${i.id}`,
          title: `${i.title}: warranty ends ${d === 0 ? "today" : `in ${d} days`}`,
          body: `If anything is wrong with it, claim before ${day(end)}${store ? ` (bought at ${store})` : ""}. Afterwards repairs are on you.`,
          because: [{ kind: "item" as const, ref: i.id, text: `you logged the warranty for "${i.title}" ending ${day(end)} ${end.year}` }],
          domain: "finance" as Domain,
          score: 50 + 40 * urgency(d),
          item_id: i.id,
          expires: iso(end),
          keep: [i.title],
        },
      ];
    });

const debtAging: Rule = (x, { open, person }) => {
  const debts = open
    .filter((i) => i.subtype === "debt")
    .map((i) => ({ i, amount: attrMoney(i.attrs, "amount"), since: attrDate(i.attrs, "since") ?? parseCivil(i.created_at.slice(0, 10)) }))
    .filter((d): d is { i: TipItem; amount: NonNullable<ReturnType<typeof attrMoney>>; since: CivilDate } => !!d.amount && !!d.since);
  const out: Tip[] = [];
  for (const b of balances(debts.map((d) => ({ person_id: d.i.person_id, direction: d.i.attrs?.direction === "i_owe_them" ? "i_owe_them" : "they_owe_me", amount: d.amount, open: true })))) {
    const mine = debts.filter((d) => d.i.person_id === b.person_id && d.amount.cur === b.cur);
    const oldest = mine.reduce((a, d) => (cmp(d.since, a) < 0 ? d.since : a), mine[0].since);
    const age = diffDays(oldest, x.today);
    const theyOwe = b.minor > 0;
    if (age < (theyOwe ? 30 : 14)) continue;
    const who = (b.person_id && person.get(b.person_id)?.name) || "Someone";
    const amt = formatMoney({ minor: Math.abs(b.minor), cur: b.cur });
    const weeks = Math.floor(age / 7);
    out.push({
      rule: "debt_aging",
      key: `debt_aging:${b.person_id ?? "none"}:${b.cur}:${Math.abs(b.minor)}:${Math.floor(weeks / 4)}`,
      title: theyOwe ? `${who} owes you ${amt}` : `You owe ${who} ${amt}`,
      body: theyOwe
        ? `It's been ${plural(weeks, "week")}. A light "no rush, but…" message usually does it.`
        : `It's been ${plural(weeks, "week")}. Settling small debts quickly keeps things easy.`,
      because: mine.slice(0, 4).map((d) => ({ kind: "item" as const, ref: d.i.id, text: `"${d.i.title}" on ${day(d.since)}` })),
      domain: "finance",
      score: 30 + Math.min(40, weeks * 3),
      item_id: mine[0].i.id,
      expires: iso(addMonths(x.today, 1)),
      keep: [who, amt],
    });
  }
  return out;
};

const errandGroup: Rule = (x, { open }) => {
  const groups = new Map<string, TipItem[]>();
  for (const i of open) {
    if (i.kind !== "task") continue;
    const p = normPlace(i.place_hint);
    if (p) groups.set(p, [...(groups.get(p) ?? []), i]);
  }
  const ed = x.patterns.errand_day as { name?: string } | undefined;
  const out: Tip[] = [];
  for (const [place, items] of groups) {
    if (items.length < 2) continue;
    const because: Because[] = items.slice(0, 5).map((i) => ({ kind: "item" as const, ref: i.id, text: `"${i.title}" needs a ${place}` }));
    if (ed?.name) because.push({ kind: "pattern", ref: "errand_day", text: `you usually run errands on ${ed.name}` });
    out.push({
      rule: "errand_group",
      key: `errand_group:${place}:${items.map((i) => i.id).sort().join(",")}`,
      title: `${items.length} things need a ${place}`,
      body: `${list(items.slice(0, 4).map((i) => i.title))}. One trip covers them${ed?.name ? `, maybe ${ed.name} as usual` : ""}.`,
      because,
      domain: "none",
      score: 30 + items.length * 8,
      item_id: items[0].id,
      expires: iso(addMonths(x.today, 1)),
      keep: items.slice(0, 4).map((i) => i.title),
    });
  }
  return out;
};

const errandBatching: Rule = (x) => {
  const t = x.patterns.errand_trips as { per_week?: number; days_per_week?: number } | undefined;
  const ed = x.patterns.errand_day as { name?: string } | undefined;
  if (!t?.per_week || !t.days_per_week || t.per_week < 3 || t.days_per_week < 2.5) return [];
  const save = Math.max(1, Math.round(t.days_per_week - 1));
  const dayName = ed?.name ?? WEEKDAYS[6];
  return [
    {
      rule: "errand_batching",
      key: `errand_batching:${x.today.year}-${x.today.month}`,
      title: `About ${t.per_week} store runs a week`,
      body: `They're spread over ${t.days_per_week} days a week. Grouping them on ${dayName} could save about ${plural(save, "trip")} a week.`,
      because: [{ kind: "pattern", ref: "errand_trips", text: `in the last 4 weeks you completed errands on about ${t.days_per_week} different days a week` }],
      domain: "none",
      score: 30,
      item_id: null,
      expires: iso(addMonths(x.today, 1)),
      keep: [dayName],
    },
  ];
};

const overduePile: Rule = (x, { open }) => {
  const od = open.filter((i) => i.overdue && i.kind === "task");
  if (od.length < 5) return [];
  return [
    {
      rule: "overdue_pile",
      key: `overdue_pile:${iso(x.today)}`,
      title: `${od.length} things are overdue`,
      body: "Five minutes of triage helps: do one now, give each of the rest a new day, and drop what no longer matters.",
      because: od.slice(0, 3).map((i) => ({ kind: "item" as const, ref: i.id, text: `"${i.title}" is overdue` })),
      domain: "none",
      score: 45 + Math.min(30, od.length * 2),
      item_id: null,
      expires: iso(x.today),
      keep: [],
    },
  ];
};

const followUpDue: Rule = (x, { open, person }) =>
  open
    .filter((i) => i.subtype === "follow_up" && i.date)
    .flatMap((i) => {
      const d = daysUntil(parseCivil(i.date!)!, x.today);
      if (d < 0 || d > 2) return [];
      const by = (i.requested_by_id && person.get(i.requested_by_id)) || (i.person_id && person.get(i.person_id)) || null;
      return [
        {
          rule: "follow_up_due",
          key: `follow_up_due:${i.id}:${i.date}`,
          title: `${by ? `${by.name} expects ` : ""}"${i.title}" ${d === 0 ? "today" : d === 1 ? "tomorrow" : "in 2 days"}`,
          body: "Block 30 minutes for it now, or send a short heads-up if it will slip.",
          because: [{ kind: "item" as const, ref: i.id, text: `you noted "${i.title}"${by ? ` for ${by.name}` : ""}, due ${day(parseCivil(i.date!)!)}` }],
          domain: "none" as Domain,
          score: 55 + 30 * urgency(d) + (by && (by.relation === "boss" || by.relation === "colleague") ? 10 : 0),
          item_id: i.id,
          expires: i.date!,
          keep: [i.title, ...(by ? [by.name] : [])],
        },
      ];
    });

const study: Rule = (x) => {
  const sessions = x.items
    .filter((i) => i.subtype === "study_session")
    .map((i) => ({ date: i.date ?? i.created_at.slice(0, 10), minutes: attrNum(i.attrs, "minutes") ?? 30 }));
  const certs = x.items.filter((i) => i.subtype === "cert" && i.status === "open");
  if (!sessions.length && !certs.length) return [];
  const s = studyStats(sessions, x.today);
  const out: Tip[] = [];
  if (s.current >= 2 && !s.todayDone && x.localHour >= 17) {
    out.push({
      rule: "study_streak",
      key: `study_streak:${iso(x.today)}`,
      title: `Keep your ${s.current}-day study streak`,
      body: "Even one 20-minute lab today keeps it going.",
      because: [{ kind: "pattern", ref: null, text: `you logged study sessions ${s.current} days in a row` }],
      domain: "none",
      score: 50,
      item_id: null,
      expires: iso(x.today),
      keep: [],
    });
  } else if (s.daysSinceLast != null && s.daysSinceLast >= 7) {
    out.push({
      rule: "study_gap",
      key: `study_gap:${s.last}`,
      title: `${s.daysSinceLast} days since your last study session`,
      body: certs.length ? `Short, regular sessions beat cramming for ${certs[0].title}. Book one tonight?` : "Short, regular sessions beat cramming. Book one tonight?",
      because: [{ kind: "pattern", ref: null, text: `your last logged session was on ${day(parseCivil(s.last!)!)}` }],
      domain: "none",
      score: 35 + Math.min(25, s.daysSinceLast),
      item_id: null,
      expires: iso(addMonths(x.today, 1)),
      keep: certs.length ? [certs[0].title] : [],
    });
  }
  for (const c of certs) {
    const need = attrNum(c.attrs, "cpe_required");
    const done = attrNum(c.attrs, "cpe_done") ?? 0;
    const end = attrDate(c.attrs, "expires_on");
    if (!need || !end || done >= need) continue;
    const d = daysUntil(end, x.today);
    if (d < 0 || d > 365) continue;
    const left = need - done;
    const months = Math.max(1, Math.ceil(d / 30));
    out.push({
      rule: "cert_cpe",
      key: `cert_cpe:${c.id}:${done}`,
      title: `${c.title}: ${left} CPE to go`,
      body: `That's about ${Math.ceil(left / months)} a month until ${day(end)} ${end.year}.`,
      because: [{ kind: "item", ref: c.id, text: `you logged ${done} of ${need} CPE for ${c.title}, expiring ${day(end)} ${end.year}` }],
      domain: "none",
      score: 35 + 40 * urgency(d / 4),
      item_id: c.id,
      expires: iso(addMonths(x.today, 1)),
      keep: [c.title, String(left)],
    });
  }
  return out;
};

const weather: Rule = (x, { open }) => {
  if (!x.weather) return [];
  const w = x.weather;
  return open
    .filter((i) => i.subtype === "seasonal")
    .flatMap((i) => {
      const cue = attrText(i.attrs, "weather");
      if (!cue || !weatherMatches(cue, w)) return [];
      // Only when it is due within 45 days or already overdue, so "winter tires" doesn't fire in a cold June.
      if (i.date && daysUntil(parseCivil(i.date)!, x.today) > 45) return [];
      const why = describeWeather(cue, w);
      return [
        {
          rule: "weather",
          key: `weather:${i.id}:${x.today.year}-${x.today.month}`,
          title: `Good week for: ${i.title}`,
          body: `The forecast says ${why}.`,
          because: [
            { kind: "weather" as const, ref: null, text: `forecast for your home: ${why}` },
            { kind: "item" as const, ref: i.id, text: `"${i.title}" is on your seasonal checklist` },
          ],
          domain: "none" as Domain,
          score: 60,
          item_id: i.id,
          expires: iso(addDays(x.today, 14)),
          keep: [i.title],
        },
      ];
    });
};

export const RULES: Record<string, Rule> = {
  date_prep: datePrep,
  snooze_habit: snoozeHabit,
  stale_fact: staleFacts,
  warranty_ending: warrantyEnding,
  debt_aging: debtAging,
  errand_group: errandGroup,
  errand_batching: errandBatching,
  overdue_pile: overduePile,
  follow_up_due: followUpDue,
  study: study,
  weather: weather,
};

export function generateTips(x: TipInput): Tip[] {
  const ctx: Ctx = { person: new Map(x.people.map((p) => [p.id, p])), open: x.items.filter((i) => i.status === "open") };
  const out: Tip[] = [];
  for (const rule of Object.values(RULES)) out.push(...rule(x, ctx));
  return out;
}

export interface RuleFeedback {
  acted: number;
  dismissed: number;
}

/**
 * Feedback weight per rule: the mean of a Beta(acted + 2, dismissed + 1) prior, i.e. starts at 2/3 and
 * moves with the user's taps. A rule dismissed 3+ times without a single act in the window is muted (0).
 */
export function ruleWeight(fb: RuleFeedback | undefined): number {
  const a = fb?.acted ?? 0;
  const d = fb?.dismissed ?? 0;
  if (d >= 3 && a === 0) return 0;
  return (a + 2) / (a + d + 3);
}

/**
 * Pick what to show: drop dismissed and snoozed keys, weight by feedback, keep at most one tip per rule
 * (two for dates, since two birthdays can be close), and return the best `max`.
 */
export function selectTips(tips: Tip[], opts: { hidden: Set<string>; feedback: Record<string, RuleFeedback>; max?: number }): (Tip & { weighted: number })[] {
  const max = opts.max ?? 3;
  const perRule = new Map<string, number>();
  const ranked = tips
    .filter((t) => !opts.hidden.has(t.key))
    .map((t) => ({ ...t, weighted: Math.round(t.score * ruleWeight(opts.feedback[t.rule]) * 100) / 100 }))
    .filter((t) => t.weighted > 0)
    .sort((a, b) => b.weighted - a.weighted || a.key.localeCompare(b.key));
  const out: (Tip & { weighted: number })[] = [];
  for (const t of ranked) {
    const n = perRule.get(t.rule) ?? 0;
    if (n >= (t.rule === "date_prep" ? 2 : 1)) continue;
    perRule.set(t.rule, n + 1);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Guard for model rewording: the new text must keep every number and every `keep` string of the draft,
 * add no links, and stay short. Otherwise the code-written draft is used.
 */
export function rewordIsFaithful(draft: string, keep: string[], text: string): boolean {
  if (!text || text.length > 320 || /https?:|www\./i.test(text)) return false;
  const nums = draft.match(/\d+(?:[.,]\d+)?/g) ?? [];
  for (const n of nums) if (!text.includes(n)) return false;
  const lower = text.toLowerCase();
  for (const k of keep) if (k && !lower.includes(k.toLowerCase())) return false;
  return true;
}
