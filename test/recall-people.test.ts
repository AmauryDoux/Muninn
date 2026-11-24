import { describe, expect, it } from "vitest";
import { matchPerson, normalizeMention, cleanRelation } from "../worker/core/people";
import { buildRecallQuery, cosine } from "../worker/core/recall";
import { zonedToUtc } from "../worker/core/time";

const people = [
  { id: "S", name: "Me", aliases: ["me"], relation: "self" },
  { id: "W", name: "Claire", aliases: ["wife", "claire"], relation: "wife" },
  { id: "D1", name: "Emma", aliases: [], relation: "daughter" },
  { id: "D2", name: "Lea", aliases: [], relation: "daughter" },
];

describe("people", () => {
  it("normalizes mentions", () => {
    expect(normalizeMention("My Wife's")).toBe("wife");
    expect(normalizeMention("  the  Boss! ")).toBe("boss");
  });
  it("matches by alias, name, unique relation", () => {
    expect(matchPerson(people, { mention: "wife", relation: null })?.id).toBe("W");
    expect(matchPerson(people, { mention: "Emma", relation: "daughter" })?.id).toBe("D1");
    expect(matchPerson(people, { mention: "me", relation: null })?.id).toBe("S");
  });
  it("leaves an ambiguous relation unresolved", () => {
    expect(matchPerson(people, { mention: "daughter", relation: "daughter" })).toBeNull();
  });
  it("cleans relations", () => {
    expect(cleanRelation("Daughter")).toBe("daughter");
    expect(cleanRelation("dragon")).toBe("other");
  });
});

describe("buildRecallQuery", () => {
  const TZ = "Europe/Paris";
  const NOW = zonedToUtc(2026, 11, 23, 10, 0, TZ);
  it("is parameterised and never interpolates values", () => {
    const q = buildRecallQuery(
      {
        requestedById: "W'; DROP TABLE items; --",
        forPersonId: null,
        created: { type: "relative", unit: "week", offset: -2, date: null, end_date: null, weekday: null, time: null },
        scheduled: null,
        status: "any",
        kind: "task",
      },
      NOW,
      TZ,
      20,
    );
    expect(q.sql).toBe(
      "SELECT * FROM items WHERE requested_by_person_id = ? AND created_at >= ? AND created_at < ? AND kind = ? ORDER BY created_at DESC LIMIT 20",
    );
    expect(q.params).toEqual(["W'; DROP TABLE items; --", "2026-11-08T23:00:00.000Z", "2026-11-15T23:00:00.000Z", "task"]);
  });
  it("ignores unknown enums and clamps the limit", () => {
    const q = buildRecallQuery({ requestedById: null, forPersonId: null, created: null, scheduled: null, status: "x" as "any", kind: "y" as "any" }, NOW, TZ, 99999);
    expect(q.sql).toBe("SELECT * FROM items ORDER BY created_at DESC LIMIT 200");
  });
});

describe("cosine", () => {
  it("works", () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0);
  });
});

describe("recall by category", () => {
  const none = { type: "none" as const };
  it("filters on a known subtype only", () => {
    const q = buildRecallQuery({ requestedById: null, forPersonId: "P", created: none, scheduled: none, status: "open", kind: "note", subtype: "debt" }, new Date(), "UTC");
    expect(q.sql).toContain("subtype = ?");
    expect(q.sql).not.toContain("kind = ?");
    expect(q.params).toEqual(["P", "open", "debt"]);
    const bad = buildRecallQuery({ requestedById: null, forPersonId: null, created: none, scheduled: none, status: "any", kind: "any", subtype: "x' OR 1=1 --" }, new Date(), "UTC");
    expect(bad.sql).not.toContain("subtype");
  });
});
