// Used only when the parser is unavailable: decide whether a note is really a question, so that
// "What have I got to do today" is answered from the saved list instead of being saved as a to-do.
// Deliberately conservative: a missed question is saved as a note (recoverable), but a capture wrongly
// read as a question would be lost.
import type { RecallOut } from "./schema";

const QUESTION_START =
  /^(what(?:'s| is| are| do| did| have| has| was| were)?\s+(?:on|i|i've|ive|have|do|did|got|left|due|coming|planned|scheduled|my)\b|do i (?:have|need)\b|have i (?:got|any)\b|did i\b|is there (?:anything|something)\b|are there any\b|anything (?:due|on|today|tomorrow)\b|show me\b|list (?:my|what)\b)/i;

export function looksLikeQuestion(text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t || t.length > 300) return false;
  return t.endsWith("?") || QUESTION_START.test(t);
}

const none = { type: "none" as const, date: null, end_date: null, unit: null, offset: null, weekday: null, time: null };
const rel = (unit: "day" | "week" | "month", offset: number) => ({ ...none, type: "relative" as const, unit, offset });

/** A plain filter over open items, scoped by the time words the question uses. */
export function fallbackRecall(text: string): RecallOut {
  const t = text.toLowerCase();
  const scheduled = /\btoday\b|\btonight\b/.test(t)
    ? rel("day", 0)
    : /\btomorrow\b/.test(t)
      ? rel("day", 1)
      : /\bnext week\b/.test(t)
        ? rel("week", 1)
        : /\bthis week\b/.test(t)
          ? rel("week", 0)
          : /\bthis month\b/.test(t)
            ? rel("month", 0)
            : none;
  return { mode: "filter", requested_by: null, for_person: null, created: none, scheduled, status: "open", kind: "any", subtype: "any", topic: null };
}
