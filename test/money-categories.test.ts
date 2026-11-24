import { describe, expect, it } from "vitest";
import { coerceAttrs, reviewMonthsFor, triggersFor, triggersForDateFact, CATEGORIES, category } from "../worker/core/categories";
import { balances, formatMoney, parseMoney } from "../worker/core/money";
import { civilToIso, parseCivil } from "../worker/core/time";
import { parseDateFact, formatDateFact, nextAnniversary, ageOn, addMonths, diffMonths } from "../worker/core/civil";

const d = (s: string) => parseCivil(s)!;

describe("parseMoney", () => {
  it.each([
    ["$40", 4000, "USD"],
    ["40 USD", 4000, "USD"],
    ["€12,50", 1250, "EUR"],
    ["1,234.56", 123456, "USD"],
    ["1.234,56 EUR", 123456, "EUR"],
    ["1,234", 123400, "USD"],
    ["£7.5", 750, "GBP"],
    ["C$20", 2000, "CAD"],
    ["¥500", 500, "JPY"],
    ["12", 1200, "USD"],
    ["12.345", 1234500, "USD"], // a lone separator before 3 digits is a thousands mark
  ])("%s", (s, minor, cur) => expect(parseMoney(s)).toEqual({ minor, cur }));

  it.each(["", "abc", "-5", "1.2.3,4.5,6x", "1e9", "99999999999", "40 dollars"])("rejects %s", (s) => expect(parseMoney(s)).toBeNull());

  it("uses the default currency", () => expect(parseMoney("9.99", "EUR")).toEqual({ minor: 999, cur: "EUR" }));
  it("formats", () => expect(formatMoney({ minor: 4000, cur: "USD" })).toBe("$40.00"));
});

describe("balances", () => {
  it("nets per person and currency, ignores settled and zero", () => {
    const b = balances([
      { person_id: "mike", direction: "they_owe_me", amount: { minor: 4000, cur: "USD" }, open: true },
      { person_id: "mike", direction: "i_owe_them", amount: { minor: 1500, cur: "USD" }, open: true },
      { person_id: "mike", direction: "they_owe_me", amount: { minor: 9999, cur: "USD" }, open: false },
      { person_id: "ann", direction: "i_owe_them", amount: { minor: 500, cur: "EUR" }, open: true },
      { person_id: "bo", direction: "they_owe_me", amount: { minor: 500, cur: "USD" }, open: true },
      { person_id: "bo", direction: "i_owe_them", amount: { minor: 500, cur: "USD" }, open: true },
    ]);
    expect(b).toEqual([
      { person_id: "mike", cur: "USD", minor: 2500, count: 2 },
      { person_id: "ann", cur: "EUR", minor: -500, count: 1 },
    ]);
  });
});

describe("coerceAttrs", () => {
  it("coerces model key/value pairs and drops unknown keys", () => {
    const r = coerceAttrs("debt", [
      { key: "direction", value: "they_owe_me" },
      { key: "amount", value: "$40" },
      { key: "since", value: "2026-11-01" },
      { key: "evil", value: "<script>" },
    ]);
    expect(r).toEqual({ attrs: { direction: "they_owe_me", amount: { minor: 4000, cur: "USD" }, since: "2026-11-01" }, errors: [] });
  });

  it("reports required and invalid fields without storing them", () => {
    const r = coerceAttrs("debt", { direction: "sideways", since: "2026-02-31" });
    expect(r.attrs).toEqual({});
    expect(r.errors.sort()).toEqual(["amount_required", "direction_invalid", "since_invalid"]);
  });

  it("only keeps http(s) links", () => {
    expect(coerceAttrs("gift_idea", { url: "javascript:alert(1)" }).attrs.url).toBeUndefined();
    expect(coerceAttrs("gift_idea", { url: "data:text/html,x" }).attrs.url).toBeUndefined();
    expect(coerceAttrs("gift_idea", { url: "https://shop.example/scarf" }).attrs.url).toBe("https://shop.example/scarf");
  });

  it("bounds numbers and strips phone junk", () => {
    expect(coerceAttrs("study_session", { minutes: "5000" }).errors).toEqual(["minutes_invalid"]);
    expect(coerceAttrs("service_record", { phone: "555-0134<b>" }).attrs.phone).toBe("555-0134");
  });

  it("accepts money objects from the app but validates them", () => {
    expect(coerceAttrs("warranty", { price: { minor: 49900, cur: "EUR" } }).attrs.price).toEqual({ minor: 49900, cur: "EUR" });
    expect(coerceAttrs("warranty", { price: { minor: -1, cur: "EUR" } }).errors).toEqual(["price_invalid"]);
    expect(coerceAttrs("warranty", { price: { minor: 1, cur: "euro" } }).errors).toEqual(["price_invalid"]);
  });

  it("derives a warranty end date from months", () => {
    expect(coerceAttrs("warranty", { bought_on: "2025-01-31", warranty_months: 13 }).attrs.expires_on).toBe("2026-02-28");
  });

  it("every category is well formed", () => {
    const seen = new Set<string>();
    for (const c of CATEGORIES) {
      expect(seen.has(c.subtype)).toBe(false);
      seen.add(c.subtype);
      expect(category(c.subtype)).toBe(c);
      for (const f of c.fields) if (f.type === "enum") expect(f.options?.length).toBeGreaterThan(0);
    }
  });
});

describe("dates", () => {
  it("parses date facts with or without a year", () => {
    expect(parseDateFact("2019-03-03")).toEqual({ year: 2019, month: 3, day: 3 });
    expect(parseDateFact("--02-29")).toEqual({ year: null, month: 2, day: 29 });
    expect(parseDateFact("--02-30")).toBeNull();
    expect(parseDateFact("March 3")).toBeNull();
    expect(formatDateFact({ year: null, month: 7, day: 4 })).toBe("--07-04");
  });
  it("anniversaries and ages", () => {
    expect(civilToIso(nextAnniversary({ month: 2, day: 29 }, d("2026-03-01")))).toBe("2027-02-28");
    expect(ageOn(d("2018-12-20"), d("2026-12-19"))).toBe(7);
    expect(ageOn(d("2018-12-20"), d("2026-12-20"))).toBe(8);
  });
  it("month arithmetic clamps", () => {
    expect(civilToIso(addMonths(d("2026-03-31"), -1))).toBe("2026-02-28");
    expect(diffMonths(d("2026-01-31"), d("2026-02-28"))).toBe(1);
    expect(diffMonths(d("2026-01-30"), d("2026-02-27"))).toBe(0);
  });
});

describe("triggersFor", () => {
  const it0 = { title: "TV", status: "open", created_at: "2026-11-24T10:00:00Z", window_start_date: null, person_name: "Mike" };
  it("warranty: 30 days before the end", () => {
    const t = triggersFor("warranty", { expires_on: "2027-03-01" }, it0, d("2026-11-24"));
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: "warranty_end", offsetDays: -30, repeat: null, requireOpen: true });
    expect(civilToIso(t[0].anchor)).toBe("2027-03-01");
  });
  it("debt: monthly nudge while open, wording by direction", () => {
    const owe = triggersFor("debt", { direction: "they_owe_me", amount: { minor: 4000, cur: "USD" }, since: "2026-11-01" }, it0, d("2026-11-24"));
    expect(owe[0]).toMatchObject({ kind: "debt_nudge", repeat: "FREQ=MONTHLY", title: "Check in: Mike owes you $40.00" });
    expect(civilToIso(owe[0].anchor)).toBe("2026-12-01");
    expect(triggersFor("debt", { direction: "i_owe_them", amount: { minor: 500, cur: "USD" } }, it0, d("2026-11-24"))[0].title).toBe("Pay back Mike $5.00");
  });
  it("service, booster and event prep", () => {
    expect(civilToIso(triggersFor("service_record", { done_on: "2026-01-15", next_due_months: 12 }, it0, d("2026-11-24"))[0].anchor)).toBe("2027-01-15");
    expect(civilToIso(triggersFor("vaccination", { given_on: "2026-11-24", booster_years: 10 }, it0, d("2026-11-24"))[0].anchor)).toBe("2036-11-24");
    expect(triggersFor("occasion", {}, { ...it0, window_start_date: "2026-12-12" }, d("2026-11-24"))[0]).toMatchObject({ offsetDays: -7 });
    expect(triggersFor("idea", {}, it0, d("2026-11-24"))).toEqual([]);
  });
  it("birthday facts: yearly, two reminders; last tetanus: booster 10 years on", () => {
    const b = triggersForDateFact("birthday", { year: null, month: 12, day: 20 }, "Emma");
    expect(b.map((t) => [t.offsetDays, t.title, t.repeat])).toEqual([
      [-14, "Gift for Emma's birthday (20 Dec)", "FREQ=YEARLY"],
      [0, "Emma's birthday today", "FREQ=YEARLY"],
    ]);
    const t = triggersForDateFact("last_tetanus", { year: 2019, month: 5, day: 2 }, "you");
    expect(civilToIso(t[0].anchor)).toBe("2029-05-02");
    expect(triggersForDateFact("last_tetanus", { year: null, month: 5, day: 2 }, "you")).toEqual([]);
    expect(triggersForDateFact("favourite_color", { year: 2020, month: 1, day: 1 }, "x")).toEqual([]);
  });
  it("kids' sizes go stale faster than adults'", () => {
    expect(reviewMonthsFor("shoe_size", "daughter")).toBe(6);
    expect(reviewMonthsFor("shoe_size", "wife")).toBe(24);
    expect(reviewMonthsFor("teacher", "son")).toBe(12);
    expect(reviewMonthsFor("favourite_food", "son")).toBeNull();
  });
});
