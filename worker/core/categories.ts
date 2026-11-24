// The category registry: every roadmap feature is a subtype with typed attributes, a group for the
// Life screen, and the triggers it schedules. Pure: no I/O. Shared by the Worker and the app.
import { addMonths, cmp, parseCivil, civilToIso, type CivilDate } from "./civil";
import { formatMoney, isCurrency, parseMoney, type Money } from "./money";

export type GroupId = "family" | "home" | "money" | "work" | "learning" | "health";
export type FieldType = "text" | "date" | "money" | "number" | "enum" | "url" | "phone";
export type Domain = "none" | "health" | "finance" | "legal";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: readonly string[];
  optionLabels?: Record<string, string>;
  required?: boolean;
  /** Integer bounds for number fields. */
  min?: number;
  max?: number;
  placeholder?: string;
}

export interface Category {
  subtype: string;
  label: string;
  plural: string;
  group: GroupId;
  kind: "task" | "note" | "event";
  icon: string;
  /** Status a new item starts in: records (a service done, a study session) are history, so "done". */
  initialStatus: "open" | "done";
  /** Label for the person link (for_person_id), or null when the category has no person. */
  person: string | null;
  /** True when the item is about a thing you own (TV, car, dishwasher). */
  thing: boolean;
  domain: Domain;
  fields: readonly FieldDef[];
  /** One line for the parser prompt. */
  hint: string;
}

export const GROUPS: { id: GroupId; label: string; icon: string }[] = [
  { id: "family", label: "Family", icon: "heart" },
  { id: "home", label: "Home & car", icon: "home" },
  { id: "money", label: "Money", icon: "coins" },
  { id: "work", label: "Work & ideas", icon: "briefcase" },
  { id: "learning", label: "Learning", icon: "book" },
  { id: "health", label: "Health", icon: "pulse" },
];

const f = (key: string, label: string, type: FieldType, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, type, ...extra });

export const CATEGORIES: readonly Category[] = [
  {
    subtype: "gift_idea", label: "Gift idea", plural: "Gift ideas", group: "family", kind: "note", icon: "gift",
    initialStatus: "open", person: "For", thing: false, domain: "none",
    fields: [f("price", "Price", "money"), f("store", "Where", "text"), f("url", "Link", "url"), f("occasion", "Occasion", "text", { placeholder: "birthday, anniversary" })],
    hint: "something a person likes or wants, worth remembering as a present ('my wife mentioned she likes that blue scarf')",
  },
  {
    subtype: "occasion", label: "Event", plural: "Events", group: "family", kind: "event", icon: "calendar",
    initialStatus: "open", person: "Who", thing: false, domain: "none",
    fields: [f("location", "Where", "text"), f("prep_days", "Remind me days before", "number", { min: 0, max: 90 })],
    hint: "a dated event to prepare for: school event, recital, party, trip",
  },
  {
    subtype: "inventory", label: "Where it is", plural: "Home inventory", group: "home", kind: "note", icon: "key",
    initialStatus: "open", person: null, thing: true, domain: "none",
    fields: [f("location", "Where it is", "text"), f("size", "Size / spec", "text"), f("model", "Model", "text")],
    hint: "where something is kept or its size/spec ('spare car key is in the blue drawer', 'furnace filter is 16x25x1')",
  },
  {
    subtype: "service_record", label: "Service", plural: "Service history", group: "home", kind: "note", icon: "wrench",
    initialStatus: "done", person: null, thing: true, domain: "none",
    fields: [
      f("provider", "Who did it", "text"), f("phone", "Phone", "phone"), f("cost", "Cost", "money"), f("done_on", "Date", "date"),
      f("mileage", "Mileage", "number", { min: 0, max: 5_000_000 }), f("next_due_months", "Next service in (months)", "number", { min: 1, max: 120 }),
    ],
    hint: "a repair or service that was done: who, cost, phone ('Bob fixed the dishwasher for $120, 555-0134')",
  },
  {
    subtype: "seasonal", label: "Seasonal chore", plural: "Seasonal checklist", group: "home", kind: "task", icon: "leaf",
    initialStatus: "open", person: null, thing: false, domain: "none",
    fields: [f("weather", "Weather cue", "enum", { options: ["any", "cold", "frost", "warm", "heat"], optionLabels: { any: "None", cold: "Cold spell", frost: "Frost", warm: "Warm spell", heat: "Heat wave" } })],
    hint: "a chore that comes back each season (winter tires, gutters, AC filter); set recurrence yearly with the month",
  },
  {
    subtype: "debt", label: "Money owed", plural: "Who owes whom", group: "money", kind: "note", icon: "coins",
    initialStatus: "open", person: "Who", thing: false, domain: "finance",
    fields: [
      f("direction", "Direction", "enum", { options: ["they_owe_me", "i_owe_them"], optionLabels: { they_owe_me: "They owe me", i_owe_them: "I owe them" }, required: true }),
      f("amount", "Amount", "money", { required: true }), f("since", "Since", "date"),
    ],
    hint: "money lent or borrowed between the user and someone ('I lent Mike $40'); direction they_owe_me or i_owe_them",
  },
  {
    subtype: "warranty", label: "Purchase", plural: "Warranties & receipts", group: "money", kind: "note", icon: "shield",
    initialStatus: "open", person: null, thing: true, domain: "finance",
    fields: [
      f("store", "Store", "text"), f("bought_on", "Bought on", "date"), f("price", "Price", "money"), f("expires_on", "Warranty ends", "date"),
      f("warranty_months", "Warranty (months)", "number", { min: 1, max: 240 }), f("receipt_ref", "Receipt / order #", "text"),
    ],
    hint: "a purchase with a receipt or warranty ('bought the TV at Best Buy on 3 March, 2-year warranty')",
  },
  {
    subtype: "follow_up", label: "Follow-up", plural: "Meeting follow-ups", group: "work", kind: "task", icon: "reply",
    initialStatus: "open", person: "With", thing: false, domain: "none",
    fields: [f("meeting", "From meeting", "text")],
    hint: "something promised to someone after a meeting or conversation ('boss asked me to send the report Friday')",
  },
  {
    subtype: "idea", label: "Idea", plural: "Ideas inbox", group: "work", kind: "note", icon: "bulb",
    initialStatus: "open", person: null, thing: false, domain: "none",
    fields: [f("tags", "Tags", "text")],
    hint: "a random thought or idea to keep, no action yet ('idea: a CTF writeup series')",
  },
  {
    subtype: "cert", label: "Certification", plural: "Certifications", group: "learning", kind: "note", icon: "award",
    initialStatus: "open", person: null, thing: false, domain: "none",
    fields: [
      f("issuer", "Issuer", "text"), f("earned_on", "Earned on", "date"), f("expires_on", "Expires on", "date"),
      f("cpe_required", "CPE needed", "number", { min: 0, max: 1000 }), f("cpe_done", "CPE done", "number", { min: 0, max: 1000 }),
    ],
    hint: "a certification held or being studied for, with expiry and CPE credits (OSCP, CISSP, eJPT)",
  },
  {
    subtype: "study_session", label: "Study session", plural: "Study log", group: "learning", kind: "note", icon: "flame",
    initialStatus: "done", person: null, thing: false, domain: "none",
    fields: [f("minutes", "Minutes", "number", { min: 1, max: 1440 }), f("topic", "Topic", "text"), f("platform", "Platform / lab", "text", { placeholder: "HTB, PortSwigger, THM" })],
    hint: "time spent studying or on a practice lab ('did 90 minutes of HTB Active Directory labs')",
  },
  {
    subtype: "medication", label: "Medication", plural: "Medication & vitamins", group: "health", kind: "task", icon: "pill",
    initialStatus: "open", person: "For", thing: false, domain: "health",
    fields: [f("dose", "Dose (as prescribed)", "text")],
    hint: "a medication or vitamin to take on a schedule; set recurrence (daily etc.) and time",
  },
  {
    subtype: "appointment", label: "Appointment", plural: "Appointments", group: "health", kind: "event", icon: "stethoscope",
    initialStatus: "open", person: "For", thing: false, domain: "health",
    fields: [f("provider", "Doctor / clinic", "text"), f("phone", "Phone", "phone"), f("reason", "Reason", "text")],
    hint: "a doctor, dentist or other health appointment",
  },
  {
    subtype: "vaccination", label: "Vaccination", plural: "Vaccinations", group: "health", kind: "note", icon: "syringe",
    initialStatus: "done", person: "Who", thing: false, domain: "health",
    fields: [f("vaccine", "Vaccine", "text"), f("given_on", "Given on", "date"), f("booster_years", "Booster after (years)", "number", { min: 1, max: 50 })],
    hint: "a shot that was given ('got my tetanus shot today'); booster_years if known (tetanus 10)",
  },
];

const BY_SUBTYPE = new Map(CATEGORIES.map((c) => [c.subtype, c]));
export const SUBTYPES = CATEGORIES.map((c) => c.subtype) as [string, ...string[]];

export function category(subtype: string | null | undefined): Category | null {
  return subtype ? (BY_SUBTYPE.get(subtype) ?? null) : null;
}

export type AttrValue = string | number | Money;
export type Attrs = Record<string, AttrValue>;

const MAX_TEXT = 300;

/**
 * Validate and coerce raw attributes (from the model or a form) against a category.
 * Unknown keys are dropped; bad values are reported and dropped, never stored.
 */
export function coerceAttrs(
  subtype: string,
  raw: Record<string, unknown> | { key: string; value: unknown }[] | null | undefined,
  defaultCur = "USD",
): { attrs: Attrs; errors: string[] } {
  const cat = category(subtype);
  const attrs: Attrs = {};
  const errors: string[] = [];
  if (!cat) return { attrs, errors: ["unknown_subtype"] };
  const pairs = Array.isArray(raw) ? raw.map((p) => [p.key, p.value] as const) : Object.entries(raw ?? {});
  const input = new Map<string, unknown>();
  for (const [k, v] of pairs) if (typeof k === "string") input.set(k.trim().toLowerCase(), v);

  for (const fd of cat.fields) {
    const v = input.get(fd.key);
    if (v === undefined || v === null || v === "") {
      if (fd.required) errors.push(`${fd.key}_required`);
      continue;
    }
    const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : null;
    switch (fd.type) {
      case "text":
      case "phone": {
        if (s == null) {
          errors.push(`${fd.key}_invalid`);
          break;
        }
        const clean = fd.type === "phone" ? s.replace(/[^\d+()\-. x]/g, "").slice(0, 40) : s.slice(0, MAX_TEXT);
        if (clean) attrs[fd.key] = clean;
        break;
      }
      case "url": {
        // Only http(s), so a stored link can never be javascript: or data:.
        try {
          const u = new URL(s ?? "");
          if (u.protocol === "https:" || u.protocol === "http:") attrs[fd.key] = u.href.slice(0, 500);
          else errors.push(`${fd.key}_invalid`);
        } catch {
          errors.push(`${fd.key}_invalid`);
        }
        break;
      }
      case "date": {
        const d = s ? parseCivil(s) : null;
        if (d) attrs[fd.key] = civilToIso(d);
        else errors.push(`${fd.key}_invalid`);
        break;
      }
      case "number": {
        const n = typeof v === "number" ? v : Number((s ?? "").replace(/,/g, ""));
        if (!Number.isFinite(n) || (fd.min != null && n < fd.min) || (fd.max != null && n > fd.max)) errors.push(`${fd.key}_invalid`);
        else attrs[fd.key] = Math.round(n * 100) / 100;
        break;
      }
      case "money": {
        const o = typeof v === "object" && v !== null ? (v as Partial<Money>) : null;
        const m = o
          ? Number.isSafeInteger(o.minor) && (o.minor as number) >= 0 && typeof o.cur === "string" && isCurrency(o.cur)
            ? { minor: o.minor as number, cur: o.cur }
            : null
          : s
            ? parseMoney(s, defaultCur)
            : null;
        if (m) attrs[fd.key] = m;
        else errors.push(`${fd.key}_invalid`);
        break;
      }
      case "enum": {
        if (s && fd.options?.includes(s)) attrs[fd.key] = s;
        else errors.push(`${fd.key}_invalid`);
        break;
      }
    }
  }
  // Derived values: a warranty given as "2 years from purchase" gets an end date.
  if (subtype === "warranty" && !attrs.expires_on && attrs.bought_on && typeof attrs.warranty_months === "number") {
    attrs.expires_on = civilToIso(addMonths(parseCivil(attrs.bought_on as string)!, attrs.warranty_months));
  }
  return { attrs, errors };
}

export function attrDate(a: Attrs | null | undefined, key: string): CivilDate | null {
  const v = a?.[key];
  return typeof v === "string" ? parseCivil(v) : null;
}
export function attrNum(a: Attrs | null | undefined, key: string): number | null {
  const v = a?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
export function attrMoney(a: Attrs | null | undefined, key: string): Money | null {
  const v = a?.[key];
  return typeof v === "object" && v !== null && typeof (v as Money).minor === "number" ? (v as Money) : null;
}
export function attrText(a: Attrs | null | undefined, key: string): string | null {
  const v = a?.[key];
  return typeof v === "string" && v ? v : null;
}

/** Format any attribute value for display. */
export function formatAttr(fd: FieldDef, v: AttrValue): string {
  if (fd.type === "money" && typeof v === "object") return formatMoney(v);
  if (fd.type === "enum" && typeof v === "string") return fd.optionLabels?.[v] ?? v;
  return String(v);
}

export interface ItemFacts {
  title: string;
  status: string;
  created_at: string; // ISO
  window_start_date: string | null; // local YYYY-MM-DD
  person_name: string | null;
}

export interface TriggerPlan {
  /** Stable kind, used to replace triggers when attributes change. */
  kind: string;
  anchor: CivilDate;
  repeat: string | null;
  offsetDays: number;
  /** Item title to create when it fires. Encrypted at rest (it may hold names). */
  title: string;
  /** Skip the fire (and stop) when the source item is no longer open. */
  requireOpen: boolean;
}

function fmtDay(d: CivilDate): string {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.day} ${M[d.month - 1]} ${d.year}`;
}

/** The triggers a categorised item schedules, computed from its attributes. */
export function triggersFor(subtype: string, attrs: Attrs, it: ItemFacts, localToday: CivilDate): TriggerPlan[] {
  const out: TriggerPlan[] = [];
  switch (subtype) {
    case "warranty": {
      const end = attrDate(attrs, "expires_on");
      if (end) out.push({ kind: "warranty_end", anchor: end, repeat: null, offsetDays: -30, title: `Warranty ends ${fmtDay(end)}: ${it.title}`, requireOpen: true });
      break;
    }
    case "debt": {
      const since = attrDate(attrs, "since") ?? parseCivil(it.created_at.slice(0, 10)) ?? localToday;
      const amt = attrMoney(attrs, "amount");
      const who = it.person_name ?? "someone";
      const what = amt ? formatMoney(amt) : "money";
      const title = attrs.direction === "i_owe_them" ? `Pay back ${who} ${what}` : `Check in: ${who} owes you ${what}`;
      // Monthly nudge while it is still open, starting a month after.
      out.push({ kind: "debt_nudge", anchor: addMonths(since, 1), repeat: "FREQ=MONTHLY", offsetDays: 0, title, requireOpen: true });
      break;
    }
    case "cert": {
      const end = attrDate(attrs, "expires_on");
      if (end) {
        out.push({ kind: "cert_expiry_90", anchor: end, repeat: null, offsetDays: -90, title: `${it.title} expires ${fmtDay(end)}: plan renewal`, requireOpen: true });
        out.push({ kind: "cert_expiry_30", anchor: end, repeat: null, offsetDays: -30, title: `${it.title} expires in 30 days`, requireOpen: true });
      }
      break;
    }
    case "service_record": {
      const done = attrDate(attrs, "done_on") ?? parseCivil(it.created_at.slice(0, 10));
      const months = attrNum(attrs, "next_due_months");
      if (done && months) {
        const due = addMonths(done, months);
        out.push({ kind: "service_due", anchor: due, repeat: null, offsetDays: -14, title: `Service due ${fmtDay(due)}: ${it.title}`, requireOpen: false });
      }
      break;
    }
    case "vaccination": {
      const given = attrDate(attrs, "given_on") ?? parseCivil(it.created_at.slice(0, 10));
      const years = attrNum(attrs, "booster_years");
      if (given && years) {
        const due = addMonths(given, Math.round(years * 12));
        const vac = attrText(attrs, "vaccine") ?? it.title;
        out.push({ kind: "booster_due", anchor: due, repeat: null, offsetDays: -30, title: `${vac} booster due ${fmtDay(due)}${it.person_name ? ` (${it.person_name})` : ""}`, requireOpen: false });
      }
      break;
    }
    case "occasion": {
      const day = it.window_start_date ? parseCivil(it.window_start_date) : null;
      const prep = attrNum(attrs, "prep_days") ?? 7;
      if (day && prep > 0) out.push({ kind: "occasion_prep", anchor: day, repeat: null, offsetDays: -prep, title: `Prepare: ${it.title} on ${fmtDay(day)}`, requireOpen: true });
      break;
    }
  }
  return out;
}

// ---- Date facts (birthdays, anniversaries, expiries) ----

export interface DateFactKind {
  key: string;
  label: string;
  yearly: boolean;
  /** [offsetDays, title template]; {who} and {date} are filled in. */
  reminders: [number, string][];
  /** For "last X" facts: the next one is due this many months later (anchor moves). */
  dueAfterMonths?: number;
  domain: Domain;
}

export const DATE_FACTS: readonly DateFactKind[] = [
  { key: "birthday", label: "Birthday", yearly: true, reminders: [[-14, "Gift for {who}'s birthday ({date})"], [0, "{who}'s birthday today"]], domain: "none" },
  { key: "anniversary", label: "Anniversary", yearly: true, reminders: [[-14, "Plan your anniversary ({date})"], [0, "Anniversary today"]], domain: "none" },
  { key: "name_day", label: "Name day", yearly: true, reminders: [[0, "{who}'s name day today"]], domain: "none" },
  { key: "passport_expiry", label: "Passport expires", yearly: false, reminders: [[-180, "Renew {who}'s passport (expires {date})"]], domain: "none" },
  { key: "license_expiry", label: "Driving licence expires", yearly: false, reminders: [[-60, "Renew {who}'s driving licence (expires {date})"]], domain: "none" },
  { key: "car_registration_expiry", label: "Car registration expires", yearly: false, reminders: [[-30, "Renew car registration (expires {date})"]], domain: "none" },
  { key: "insurance_renewal", label: "Insurance renewal", yearly: true, reminders: [[-30, "Insurance renews {date}: compare quotes"]], domain: "finance" },
  { key: "last_tetanus", label: "Last tetanus shot", yearly: false, dueAfterMonths: 120, reminders: [[-30, "Tetanus booster due {date} ({who})"]], domain: "health" },
  { key: "last_dental_checkup", label: "Last dental check-up", yearly: false, dueAfterMonths: 6, reminders: [[0, "Book a dental check-up ({who})"]], domain: "health" },
  { key: "last_eye_exam", label: "Last eye exam", yearly: false, dueAfterMonths: 24, reminders: [[0, "Book an eye exam ({who})"]], domain: "health" },
];

const DATE_FACT_BY_KEY = new Map(DATE_FACTS.map((d) => [d.key, d]));
export function dateFactKind(key: string): DateFactKind | null {
  return DATE_FACT_BY_KEY.get(key) ?? null;
}

/** Triggers for a date fact. Birthdays without a year anchor on 2000 (a leap year, so 29 Feb is valid). */
export function triggersForDateFact(
  key: string,
  value: { year: number | null; month: number; day: number },
  who: string,
): TriggerPlan[] {
  const k = dateFactKind(key);
  if (!k) return [];
  let anchor: CivilDate;
  if (k.yearly) anchor = { year: value.year ?? 2000, month: value.month, day: value.day };
  else {
    if (value.year == null) return [];
    anchor = { year: value.year, month: value.month, day: value.day };
    if (k.dueAfterMonths) anchor = addMonths(anchor, k.dueAfterMonths);
  }
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = k.yearly ? `${anchor.day} ${M[anchor.month - 1]}` : fmtDay(anchor);
  return k.reminders.map(([offset, tpl], i) => ({
    kind: `${key}_${i}`,
    anchor,
    repeat: k.yearly ? "FREQ=YEARLY" : null,
    offsetDays: offset,
    title: tpl.replace("{who}", who).replace("{date}", date),
    requireOpen: false,
  }));
}

/** Facts that go stale as people (mostly kids) change. Returns months until a fact should be re-checked. */
export function reviewMonthsFor(key: string, relation: string | null): number | null {
  const kid = relation === "daughter" || relation === "son" || relation === "child";
  if (/(^|_)(size|sizes)($|_)|shoe|height|weight/.test(key)) return kid ? 6 : 24;
  if (/teacher|class|grade|school/.test(key)) return 12;
  if (/allerg/.test(key)) return 12;
  if (/doctor|dentist|pediatrician|insurance/.test(key)) return 24;
  return null;
}

/** Compare by date, earliest first, nulls last. */
export function byDate(a: CivilDate | null, b: CivilDate | null): number {
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return cmp(a, b);
}

export interface StatusLine {
  text: string;
  tone: "ok" | "warn" | "bad" | "muted";
}

/** A one-line, code-computed status for a categorised item ("Covered until 3 Mar 2027 · 99 days"). */
export function statusLine(subtype: string | null, attrs: Attrs | null, status: string, today: CivilDate): StatusLine | null {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fd = (d: CivilDate) => `${d.day} ${M[d.month - 1]} ${d.year}`;
  const days = (d: CivilDate) => Math.round((Date.UTC(d.year, d.month - 1, d.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000);
  switch (subtype) {
    case "warranty": {
      const end = attrDate(attrs, "expires_on");
      if (!end) return { text: "No warranty end date", tone: "muted" };
      const n = days(end);
      if (n < 0) return { text: `Warranty ended ${fd(end)}`, tone: "muted" };
      return { text: `Covered until ${fd(end)} · ${n} days`, tone: n <= 30 ? "warn" : "ok" };
    }
    case "debt": {
      const amt = attrMoney(attrs, "amount");
      if (!amt) return null;
      if (status !== "open") return { text: `Settled · ${formatMoney(amt)}`, tone: "muted" };
      return attrs?.direction === "i_owe_them" ? { text: `You owe ${formatMoney(amt)}`, tone: "warn" } : { text: `Owes you ${formatMoney(amt)}`, tone: "ok" };
    }
    case "cert": {
      const end = attrDate(attrs, "expires_on");
      const need = attrNum(attrs, "cpe_required");
      const done = attrNum(attrs, "cpe_done") ?? 0;
      const cpe = need ? ` · ${done}/${need} CPE` : "";
      if (!end) return cpe ? { text: cpe.slice(3), tone: "ok" } : null;
      const n = days(end);
      if (n < 0) return { text: `Expired ${fd(end)}${cpe}`, tone: "bad" };
      return { text: `Valid until ${fd(end)}${cpe}`, tone: n <= 90 ? "warn" : "ok" };
    }
    case "service_record": {
      const done = attrDate(attrs, "done_on");
      const months = attrNum(attrs, "next_due_months");
      if (done && months) {
        const due = addMonths(done, months);
        const n = days(due);
        return { text: n < 0 ? `Service overdue since ${fd(due)}` : `Next service ${fd(due)}`, tone: n < 0 ? "bad" : n <= 30 ? "warn" : "ok" };
      }
      return done ? { text: `Done ${fd(done)}`, tone: "muted" } : null;
    }
    case "vaccination": {
      const given = attrDate(attrs, "given_on");
      const years = attrNum(attrs, "booster_years");
      if (given && years) {
        const due = addMonths(given, Math.round(years * 12));
        const n = days(due);
        return { text: n < 0 ? `Booster overdue since ${fd(due)}` : `Booster due ${fd(due)}`, tone: n < 0 ? "bad" : n <= 60 ? "warn" : "ok" };
      }
      return given ? { text: `Given ${fd(given)}`, tone: "muted" } : null;
    }
    case "inventory": {
      const loc = attrText(attrs, "location");
      return loc ? { text: loc, tone: "ok" } : null;
    }
    default:
      return null;
  }
}
