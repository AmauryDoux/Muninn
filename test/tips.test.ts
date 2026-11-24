import { describe, expect, it } from "vitest";
import { generateTips, rewordIsFaithful, ruleWeight, selectTips, type TipInput, type TipItem } from "../worker/core/tips";
import { parseCivil } from "../worker/core/time";

const today = parseCivil("2026-11-24")!;
const item = (o: Partial<TipItem>): TipItem => ({
  id: "i1",
  kind: "note",
  subtype: null,
  title: "x",
  status: "open",
  person_id: null,
  requested_by_id: null,
  place_hint: null,
  attrs: null,
  date: null,
  overdue: false,
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
  ...o,
});
const base = (o: Partial<TipInput> = {}): TipInput => ({
  today,
  localHour: 12,
  people: [
    { id: "emma", name: "Emma", relation: "daughter" },
    { id: "sarah", name: "Sarah", relation: "wife" },
    { id: "mike", name: "Mike", relation: "friend" },
    { id: "boss", name: "Dana", relation: "boss" },
  ],
  facts: [],
  items: [],
  snoozeCounts: new Map(),
  patterns: {},
  weather: null,
  ...o,
});
const fact = (id: string, subject_id: string | null, key: string, value: string, created_at = "2026-03-01T10:00:00Z") => ({
  id,
  subject_type: subject_id ? "person" : "me",
  subject_id,
  key,
  value,
  created_at,
  review_after: null,
});
const byRule = (x: TipInput) => Object.fromEntries(generateTips(x).map((t) => [t.rule, t]));

describe("date_prep", () => {
  it("surfaces saved gift ideas before a birthday, with the reasons", () => {
    const t = byRule(
      base({
        facts: [fact("f1", "emma", "birthday", "2018-12-06")],
        items: [item({ id: "g1", subtype: "gift_idea", title: "Blue Lego set", person_id: "emma" }), item({ id: "g2", subtype: "gift_idea", title: "Old idea", person_id: "emma", status: "done" })],
      }),
    ).date_prep;
    expect(t.title).toBe("Emma's birthday is in 12 days (turns 8)");
    expect(t.body).toBe("Ideas you saved: Blue Lego set.");
    expect(t.because.map((b) => b.ref)).toEqual(["f1", "g1"]);
    expect(t.because[0].text).toContain("you told me on 1 Mar 2026");
    expect(t.key).toBe("date_prep:f1:2026");
  });
  it("falls back to what the person likes, then to a prompt", () => {
    const likes = byRule(base({ facts: [fact("f1", "sarah", "birthday", "--12-01"), fact("f2", "sarah", "likes", "blue scarves")] })).date_prep;
    expect(likes.body).toBe("No gift saved yet. You told me Sarah likes blue scarves.");
    const none = byRule(base({ facts: [fact("f1", "sarah", "birthday", "--12-01")] })).date_prep;
    expect(none.body).toContain("No gift ideas saved for Sarah yet");
  });
  it("uses the partner for the user's own anniversary, and skips far or own birthdays", () => {
    expect(byRule(base({ facts: [fact("f1", null, "anniversary", "2015-11-30")] })).date_prep.title).toBe("Your anniversary is in 6 days");
    expect(byRule(base({ facts: [fact("f1", null, "birthday", "1990-11-30")] })).date_prep).toBeUndefined();
    expect(byRule(base({ facts: [fact("f1", "emma", "birthday", "2018-12-20")] })).date_prep).toBeUndefined();
  });
});

describe("other rules", () => {
  it("snooze habit uses the completion-hour pattern", () => {
    const t = byRule(base({ items: [item({ id: "d", title: "Call dentist", kind: "task" })], snoozeCounts: new Map([["d", 4]]), patterns: { done_hour: { hour: 19 } } })).snooze_habit;
    expect(t.title).toBe('You\'ve snoozed "Call dentist" 4 times');
    expect(t.body).toContain("19:00");
    expect(t.because.map((b) => b.kind)).toEqual(["item", "pattern"]);
  });
  it("stale kids' sizes, not adults'", () => {
    const r = byRule(base({ facts: [fact("s1", "emma", "shoe_size", "31"), fact("s2", "sarah", "shoe_size", "38")] }));
    expect(r.stale_fact.title).toBe("Check Emma's details");
    expect(r.stale_fact.because).toHaveLength(1);
  });
  it("warranty ending is labelled finance", () => {
    const t = byRule(base({ items: [item({ id: "w", subtype: "warranty", title: "TV", attrs: { expires_on: "2026-12-10", store: "Best Buy" } })] })).warranty_ending;
    expect(t).toMatchObject({ title: "TV: warranty ends in 16 days", domain: "finance" });
    expect(t.body).toContain("Best Buy");
  });
  it("debts net per person and wait 30 days before nudging", () => {
    const debt = (id: string, dir: string, minor: number, since: string) =>
      item({ id, subtype: "debt", person_id: "mike", title: `debt ${id}`, attrs: { direction: dir, amount: { minor, cur: "USD" }, since } });
    const t = byRule(base({ items: [debt("a", "they_owe_me", 4000, "2026-10-01"), debt("b", "i_owe_them", 1000, "2026-11-20")] })).debt_aging;
    expect(t).toMatchObject({ title: "Mike owes you $30.00", domain: "finance" });
    expect(t.body).toContain("7 weeks");
    expect(byRule(base({ items: [debt("a", "they_owe_me", 4000, "2026-11-10")] })).debt_aging).toBeUndefined();
  });
  it("groups errands by place and mentions the usual day", () => {
    const t = byRule(
      base({
        items: [
          item({ id: "1", kind: "task", title: "Buy sheets", place_hint: "Home goods store" }),
          item({ id: "2", kind: "task", title: "Buy frames", place_hint: "home goods store" }),
          item({ id: "3", kind: "task", title: "Buy milk", place_hint: "grocery" }),
        ],
        patterns: { errand_day: { name: "Saturday" } },
      }),
    ).errand_group;
    expect(t.title).toBe("2 things need a home goods store");
    expect(t.body).toBe("Buy sheets and Buy frames. One trip covers them, maybe Saturday as usual.");
  });
  it("pattern-based batching only with enough spread", () => {
    expect(byRule(base({ patterns: { errand_trips: { per_week: 4, days_per_week: 3 }, errand_day: { name: "Saturday" } } })).errand_batching.body).toBe(
      "They're spread over 3 days a week. Grouping them on Saturday could save about 2 trips a week.",
    );
    expect(byRule(base({ patterns: { errand_trips: { per_week: 4, days_per_week: 1 } } })).errand_batching).toBeUndefined();
  });
  it("follow-up for the boss due tomorrow", () => {
    const t = byRule(base({ items: [item({ id: "f", subtype: "follow_up", kind: "task", title: "Send the report", requested_by_id: "boss", date: "2026-11-25" })] })).follow_up_due;
    expect(t.title).toBe('Dana expects "Send the report" tomorrow');
  });
  it("study streak in the evening, gap otherwise, CPE pace", () => {
    const sess = (date: string) => item({ id: date, subtype: "study_session", status: "done", date, attrs: { minutes: 60 } });
    expect(byRule(base({ localHour: 19, items: [sess("2026-11-22"), sess("2026-11-23")] })).study_streak.title).toBe("Keep your 2-day study streak");
    expect(byRule(base({ localHour: 10, items: [sess("2026-11-22"), sess("2026-11-23")] })).study_streak).toBeUndefined();
    expect(byRule(base({ items: [sess("2026-11-10")] })).study_gap.title).toBe("14 days since your last study session");
    const cpe = byRule(base({ items: [item({ id: "c", subtype: "cert", title: "CISSP", attrs: { cpe_required: 40, cpe_done: 10, expires_on: "2027-05-24" } })] })).cert_cpe;
    expect(cpe.title).toBe("CISSP: 30 CPE to go");
    expect(cpe.body).toBe("That's about 5 a month until 24 May 2027.");
  });
  it("weather cue only near the scheduled date", () => {
    const w = { cold: true, frost: false, warm: false, heat: false, meanMin: 3, minMin: 1, maxMax: 9, days: 7 };
    const tires = (date: string) => item({ id: "t", subtype: "seasonal", kind: "task", title: "Put winter tires on", date, attrs: { weather: "cold" } });
    expect(byRule(base({ weather: w, items: [tires("2026-10-01")] })).weather.body).toBe("The forecast says lows average 3°C this week.");
    expect(byRule(base({ weather: w, items: [tires("2027-06-01")] })).weather).toBeUndefined();
  });
});

describe("selection and feedback", () => {
  const t = (rule: string, key: string, score: number) => ({ rule, key, score, title: "", body: "", because: [], domain: "none" as const, item_id: null, expires: "2026-12-01", keep: [] });
  it("weights by feedback, mutes ignored rules, one per rule, drops hidden", () => {
    expect(ruleWeight(undefined)).toBeCloseTo(2 / 3);
    expect(ruleWeight({ acted: 0, dismissed: 3 })).toBe(0);
    expect(ruleWeight({ acted: 4, dismissed: 1 })).toBeCloseTo(6 / 8);
    const out = selectTips([t("a", "a1", 90), t("a", "a2", 80), t("b", "b1", 70), t("c", "c1", 99), t("d", "d1", 50)], {
      hidden: new Set(["d1"]),
      feedback: { c: { acted: 0, dismissed: 3 } },
    });
    expect(out.map((x) => x.key)).toEqual(["a1", "b1"]);
  });
  it("allows two date tips", () => {
    expect(selectTips([t("date_prep", "x", 90), t("date_prep", "y", 80)], { hidden: new Set(), feedback: {} })).toHaveLength(2);
  });
});

describe("rewordIsFaithful", () => {
  it("keeps numbers and names, rejects links", () => {
    const draft = "Emma's birthday is in 12 days (turns 8). Ideas you saved: Blue Lego set.";
    expect(rewordIsFaithful(draft, ["Emma", "Blue Lego set"], "In 12 days Emma turns 8. You saved the Blue Lego set.")).toBe(true);
    expect(rewordIsFaithful(draft, ["Emma", "Blue Lego set"], "In 2 weeks Emma turns 8. You saved the Blue Lego set.")).toBe(false);
    expect(rewordIsFaithful(draft, ["Emma", "Blue Lego set"], "In 12 days she turns 8, get the blue Lego set.")).toBe(false);
    expect(rewordIsFaithful(draft, [], "12 8 see https://x.example")).toBe(false);
  });
});
