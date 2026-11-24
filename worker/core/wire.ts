// The JSON shape actually sent to the model for parsing, and its conversion to the internal ParseOutput.
//
// Why a separate wire shape: structured outputs reject a request whose schemas use more than 16
// union-typed parameters (every `.nullable()` becomes an anyOf) or more than 24 optional ones
// ("Schema is too complex", HTTP 400). The internal schema has ~40 nullable fields, so every parse
// failed and every note fell back to a plain item. The wire shape uses sentinels instead of null
// ("" for no text, "none" in enums, -1 for no number, [] for no list) and keeps only two unions:
// the top-level capture and recall objects. `toParseOutput` restores nulls for the rest of the code.
import { z } from "zod";
import { SUBTYPES } from "./categories";
import type { CaptureOut, ParseOutput, RecallOut } from "./schema";

const Mention = z.object({
  mention: z.string().describe('How the person was referred to, as written: "wife", "Emma". Empty string when nobody (or the user).'),
  relation: z
    .string()
    .describe("Relation to the user if known: self, wife, husband, partner, daughter, son, child, mother, father, sister, brother, friend, colleague, boss, neighbor, other. Empty if unknown."),
});

const TimeRef = z.object({
  type: z.enum(["none", "date", "range", "relative", "weekday"]),
  date: z.string().describe('YYYY-MM-DD for type=date (the day) or range (first day); "" otherwise.'),
  end_date: z.string().describe('YYYY-MM-DD, last day of a range (inclusive); "" otherwise.'),
  unit: z.enum(["none", "day", "week", "weekend", "month"]).describe("For type=relative; none otherwise."),
  offset: z.number().int().describe("type=relative: 0 this, 1 next, -1 last (days for unit=day). type=weekday: 0 the coming one, 1 the one after. 0 otherwise."),
  weekday: z.number().int().describe("type=weekday: 0=Sunday ... 6=Saturday. -1 otherwise."),
  time: z.string().describe('HH:MM 24h local time if one was given, else "".'),
});

const WireCapture = z.object({
  kind: z.enum(["task", "note", "fact", "event"]),
  title: z.string().describe("Short imperative or noun phrase, 2-8 words, e.g. 'Buy new sheets'."),
  details: z.string().describe('Anything worth keeping that is not in the title, else "".'),
  for_person: Mention.describe("Who the item is for or about, if not the user."),
  requested_by: Mention.describe("Who asked the user to do it, if someone did."),
  when: TimeRef.describe("When it should happen. type=none if no time was said."),
  place_hint: z.string().describe('Kind of place where it gets done, e.g. "pharmacy", else "".'),
  confidence: z.number().describe("0 to 1: how sure you are this reading is what the user meant."),
  subtype: z.enum(["none", ...SUBTYPES]).describe("The category when one fits (see the subtype list), else none."),
  attrs: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .describe("Attributes for the subtype, keys from the subtype list only. Dates as YYYY-MM-DD, money as '40 USD'. Often empty."),
  thing_name: z.string().describe('The owned object the note is about ("TV", "car", "spare car key"), else "".'),
  thing_kind: z.string().describe('vehicle, appliance, key, document, device, furniture, other; "" when no thing.'),
  repeat: z.enum(["none", "daily", "weekly", "monthly", "yearly"]).describe("Only when the user says it repeats."),
  repeat_interval: z.number().int().describe("Every N units, 1 by default."),
  repeat_months: z.array(z.number().int()).describe("Months 1-12 for yearly chores, e.g. [10] for every October. Often empty."),
  repeat_weekdays: z.array(z.number().int()).describe("0=Sunday..6=Saturday, weekly only. Often empty."),
  facts: z
    .array(
      z.object({
        subject: Mention.describe('Who the fact is about; mention "" when it is about the user or the thing.'),
        about_thing: z.boolean().describe("True when the fact is about the thing above (its location, size, model)."),
        key: z.string().describe("snake_case, e.g. bed_size, shoe_size, allergies, teacher, likes, birthday, location, filter_size."),
        value: z.string().describe("For date keys (birthday, anniversary, passport_expiry, last_tetanus, ...): YYYY-MM-DD, or --MM-DD when the year is unknown."),
      }),
    )
    .describe("Durable facts stated in the text. Often empty."),
  missing: z
    .array(
      z.object({
        subject: Mention,
        key: z.string().describe("snake_case fact key that would be needed to do the task well."),
        question: z.string().describe("One short question to ask the user."),
      }),
    )
    .describe("At most 2 facts that the task needs and the text does not give."),
});

const WireRecall = z.object({
  mode: z.enum(["filter", "semantic"]).describe("filter: who/when/status questions. semantic: topic questions."),
  requested_by: Mention,
  for_person: Mention,
  created: TimeRef.describe("When the item was captured ('2 weeks ago' is relative week -2). type=none if not asked."),
  scheduled: TimeRef.describe("When the item is due/scheduled. type=none if not asked."),
  status: z.enum(["open", "done", "dropped", "any"]),
  kind: z.enum(["task", "note", "fact", "event", "any"]),
  subtype: z.enum(["any", ...SUBTYPES]).describe("Category asked about ('who owes me money' = debt), else any."),
  topic: z.string().describe('The subject being asked about, for semantic search, e.g. "my car", else "".'),
});

export const WireParseSchema = z.object({
  intent: z
    .enum(["capture", "recall", "advice"])
    .describe("capture: the user tells something to remember or do. recall: the user asks what they captured. advice: the user asks for a suggestion, recommendation or how-to."),
  capture: WireCapture.nullable(),
  recall: WireRecall.nullable(),
});
export type WireParse = z.infer<typeof WireParseSchema>;

type WMention = z.infer<typeof Mention>;
type WTime = z.infer<typeof TimeRef>;

const str = (s: string | undefined | null) => {
  const t = (s ?? "").trim();
  return t && t.toLowerCase() !== "null" && t.toLowerCase() !== "none" ? t : null;
};
const mention = (m: WMention | undefined | null) => (m && str(m.mention) ? { mention: str(m.mention)!, relation: str(m.relation) } : null);
const time = (t: WTime): CaptureOut["when"] => ({
  type: t.type,
  date: str(t.date),
  end_date: str(t.end_date),
  unit: t.unit === "none" ? null : t.unit,
  offset: t.type === "relative" || t.type === "weekday" ? t.offset : null,
  weekday: t.type === "weekday" && t.weekday >= 0 && t.weekday <= 6 ? t.weekday : null,
  time: str(t.time),
});

export function toParseOutput(w: WireParse): ParseOutput {
  const c = w.capture;
  const capture: CaptureOut | null = c
    ? {
        kind: c.kind,
        title: c.title,
        details: str(c.details),
        for_person: mention(c.for_person),
        requested_by: mention(c.requested_by),
        when: time(c.when),
        place_hint: str(c.place_hint),
        confidence: c.confidence,
        subtype: c.subtype,
        attrs: c.attrs,
        thing: str(c.thing_name) ? { name: str(c.thing_name)!, kind: str(c.thing_kind) ?? "other" } : null,
        recurrence:
          c.repeat === "none"
            ? null
            : {
                freq: c.repeat,
                interval: c.repeat_interval > 1 ? c.repeat_interval : null,
                by_month: c.repeat_months.length ? c.repeat_months : null,
                by_weekday: c.repeat_weekdays.length ? c.repeat_weekdays : null,
              },
        facts: c.facts.map((f) => ({ subject: f.about_thing ? null : mention(f.subject), about_thing: f.about_thing, key: f.key, value: f.value })),
        missing: c.missing.map((m) => ({ subject: mention(m.subject), key: m.key, question: m.question })),
      }
    : null;
  const r = w.recall;
  const recall: RecallOut | null = r
    ? {
        mode: r.mode,
        requested_by: mention(r.requested_by),
        for_person: mention(r.for_person),
        created: time(r.created),
        scheduled: time(r.scheduled),
        status: r.status,
        kind: r.kind,
        subtype: r.subtype,
        topic: str(r.topic),
      }
    : null;
  return { intent: w.intent, capture, recall };
}

/** Structured-output limits per request (Anthropic docs): unions and optional params across all strict schemas. */
export const SCHEMA_LIMITS = { unions: 16, optional: 24 } as const;

/** Counts union-typed and optional parameters in a JSON schema, the way the API's limits count them. */
export function schemaComplexity(schema: unknown): { unions: number; optional: number } {
  let unions = 0;
  let optional = 0;
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    if (Array.isArray(o.anyOf) || Array.isArray(o.oneOf) || Array.isArray(o.type)) unions++;
    if (o.properties && typeof o.properties === "object") {
      const req = new Set(Array.isArray(o.required) ? (o.required as string[]) : []);
      optional += Object.keys(o.properties).filter((k) => !req.has(k)).length;
    }
    Object.values(o).forEach(walk);
  };
  walk(schema);
  return { unions, optional };
}
