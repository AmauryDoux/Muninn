// The only shapes the model may return. Everything is validated before code acts on it.
import { z } from "zod";

export const PersonMentionSchema = z.object({
  mention: z.string().describe("How the person was referred to, as written: 'wife', 'Emma', 'my daughter'."),
  relation: z
    .string()
    .nullable()
    .describe("Relation to the user if known: self, wife, husband, partner, daughter, son, child, mother, father, sister, brother, friend, colleague, boss, neighbor, other."),
});

export const TimeRefSchema = z.object({
  type: z.enum(["none", "date", "range", "relative", "weekday"]),
  date: z.string().nullable().describe("YYYY-MM-DD. For type=date the day; for type=range the first day."),
  end_date: z.string().nullable().describe("YYYY-MM-DD, last day of a range (inclusive)."),
  unit: z.enum(["day", "week", "weekend", "month"]).nullable().describe("For type=relative."),
  offset: z
    .number()
    .int()
    .nullable()
    .describe("type=relative: 0 this, 1 next, -1 last, -2 two ago (days for unit=day). type=weekday: 0 the coming one, 1 the one after."),
  weekday: z.number().int().nullable().describe("type=weekday: 0=Sunday ... 6=Saturday."),
  time: z.string().nullable().describe("HH:MM 24h local time if one was given."),
});

export const CaptureSchema = z.object({
  kind: z.enum(["task", "note", "fact", "event"]),
  title: z.string().describe("Short imperative or noun phrase, 2-8 words, e.g. 'Buy new sheets'."),
  details: z.string().nullable().describe("Anything worth keeping that is not in the title, or null."),
  for_person: PersonMentionSchema.nullable().describe("Who the item is for, if not the user."),
  requested_by: PersonMentionSchema.nullable().describe("Who asked the user to do it, if someone did."),
  when: TimeRefSchema.describe("When it should happen. type=none if no time was said."),
  place_hint: z.string().nullable().describe("Kind of place where it gets done, e.g. 'home goods store', 'pharmacy'. Null if none."),
  confidence: z.number().describe("0 to 1: how sure you are this reading is what the user meant."),
  facts: z
    .array(
      z.object({
        subject: PersonMentionSchema.nullable().describe("Null when the fact is about the user."),
        key: z.string().describe("snake_case, e.g. bed_size, shoe_size, allergies, car_model."),
        value: z.string(),
      }),
    )
    .describe("Durable facts stated in the text, e.g. 'daughter's bed is a full'. Often empty."),
  missing: z
    .array(
      z.object({
        subject: PersonMentionSchema.nullable(),
        key: z.string().describe("snake_case fact key that would be needed to do the task well."),
        question: z.string().describe("One short question to ask the user."),
      }),
    )
    .describe("At most 2 facts that the task needs and the text does not give, e.g. bed_size for buying sheets."),
});

export const RecallSchema = z.object({
  mode: z.enum(["filter", "semantic"]).describe("filter: who/when/status questions. semantic: topic questions."),
  requested_by: PersonMentionSchema.nullable(),
  for_person: PersonMentionSchema.nullable(),
  created: TimeRefSchema.describe("When the item was captured (e.g. '2 weeks ago' is relative week -2). type=none if not asked."),
  scheduled: TimeRefSchema.describe("When the item is due/scheduled. type=none if not asked."),
  status: z.enum(["open", "done", "dropped", "any"]),
  kind: z.enum(["task", "note", "fact", "event", "any"]),
  topic: z.string().nullable().describe("The subject being asked about, for semantic search, e.g. 'my car'."),
});

export const ParseSchema = z.object({
  intent: z
    .enum(["capture", "recall", "advice"])
    .describe("capture: the user tells something to remember or do. recall: the user asks what they captured. advice: the user asks for a suggestion, recommendation or how-to."),
  capture: CaptureSchema.nullable(),
  recall: RecallSchema.nullable(),
});

export const AdviceSchema = z.object({
  answer: z.string().describe("Practical, personal advice in at most 6 short sentences or a short list."),
  cited_ids: z.array(z.string()).describe("Ids of the user's items or facts the advice relies on."),
  sensitive_domain: z
    .enum(["none", "health", "finance", "legal"])
    .describe("health: medical, medication, mental health. finance: money, tax, investing, debt. legal: law, contracts, rights."),
});
export type AdviceOut = z.infer<typeof AdviceSchema>;

export const DISCLAIMERS: Record<"health" | "finance" | "legal", string> = {
  health: "General information, not medical advice. Check with a doctor or pharmacist.",
  finance: "General information, not financial advice.",
  legal: "General information, not legal advice.",
};

export type ParseOutput = z.infer<typeof ParseSchema>;
export type CaptureOut = z.infer<typeof CaptureSchema>;
export type RecallOut = z.infer<typeof RecallSchema>;

export const AnswerSchema = z.object({
  answer: z.string().describe("1 to 3 sentences answering only from the given items."),
  cited_ids: z.array(z.string()).describe("Ids of the items the answer relies on."),
});
export type AnswerOut = z.infer<typeof AnswerSchema>;

export const PARSER_VERSION = "parse-v1";
