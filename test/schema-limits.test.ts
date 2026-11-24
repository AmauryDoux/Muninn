import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { AdviceSchema, AnswerSchema, ParseSchema, TipWordingSchema } from "../worker/core/schema";
import { SCHEMA_LIMITS, schemaComplexity, toParseOutput, WireParseSchema } from "../worker/core/wire";

const jsonOf = (s: unknown) => (zodOutputFormat(s as never) as unknown as { schema: unknown }).schema;

describe("structured-output limits", () => {
  // The API rejects a request whose schema has >16 union params or >24 optional params ("Schema is too complex").
  // Every schema we send must fit, or every call silently falls back.
  for (const [name, s] of [["parse", WireParseSchema], ["answer", AnswerSchema], ["advice", AdviceSchema], ["tips", TipWordingSchema]] as const) {
    it(`${name} fits`, () => {
      const c = schemaComplexity(jsonOf(s));
      expect(c.unions).toBeLessThanOrEqual(SCHEMA_LIMITS.unions);
      expect(c.optional).toBeLessThanOrEqual(SCHEMA_LIMITS.optional);
    });
  }
  it("the internal schema would not fit (why the wire schema exists)", () => {
    expect(schemaComplexity(jsonOf(ParseSchema)).unions).toBeGreaterThan(SCHEMA_LIMITS.unions);
  });
});

const blankMention = { mention: "", relation: "" };
const noTime = { type: "none" as const, date: "", end_date: "", unit: "none" as const, offset: 0, weekday: -1, time: "" };

describe("toParseOutput", () => {
  it("turns sentinels back into nulls", () => {
    const out = toParseOutput({
      intent: "capture",
      recall: null,
      capture: {
        kind: "note", title: "Blue Lego set", details: "", for_person: { mention: "Emma", relation: "daughter" }, requested_by: blankMention,
        when: noTime, place_hint: "", confidence: 0.9, subtype: "gift_idea", attrs: [{ key: "price", value: "40 USD" }],
        thing_name: "", thing_kind: "", repeat: "none", repeat_interval: 1, repeat_months: [], repeat_weekdays: [],
        facts: [{ subject: blankMention, about_thing: false, key: "likes", value: "Lego" }], missing: [], also: [],
      },
    });
    const c = out.capture!;
    expect(c.details).toBeNull();
    expect(c.for_person).toEqual({ mention: "Emma", relation: "daughter" });
    expect(c.requested_by).toBeNull();
    expect(c.when).toEqual({ type: "none", date: null, end_date: null, unit: null, offset: null, weekday: null, time: null });
    expect(c.thing).toBeNull();
    expect(c.recurrence).toBeNull();
    expect(c.subtype).toBe("gift_idea");
    expect(c.facts[0].subject).toBeNull();
  });
  it("keeps weekday 0 (Sunday), offsets, things and recurrence", () => {
    const out = toParseOutput({
      intent: "capture",
      recall: null,
      capture: {
        kind: "task", title: "Change AC filter", details: "", for_person: blankMention, requested_by: blankMention,
        when: { ...noTime, type: "weekday", weekday: 0, offset: 0, time: "09:00" }, place_hint: "null", confidence: 1, subtype: "none", attrs: [],
        thing_name: "AC", thing_kind: "appliance", repeat: "monthly", repeat_interval: 3, repeat_months: [], repeat_weekdays: [],
        facts: [], missing: [], also: [],
      },
    });
    const c = out.capture!;
    expect(c.when).toMatchObject({ type: "weekday", weekday: 0, offset: 0, time: "09:00" });
    expect(c.place_hint).toBeNull();
    expect(c.thing).toEqual({ name: "AC", kind: "appliance" });
    expect(c.recurrence).toEqual({ freq: "monthly", interval: 3, by_month: null, by_weekday: null });
  });
  it("maps recall", () => {
    const out = toParseOutput({
      intent: "recall",
      capture: null,
      recall: { mode: "filter", requested_by: { mention: "wife", relation: "" }, for_person: blankMention, created: { ...noTime, type: "relative", unit: "week", offset: -2 }, scheduled: noTime, status: "any", kind: "any", subtype: "any", topic: "" },
    });
    expect(out.recall).toMatchObject({ requested_by: { mention: "wife", relation: null }, for_person: null, topic: null, created: { type: "relative", unit: "week", offset: -2 } });
  });
});
