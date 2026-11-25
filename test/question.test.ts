import { describe, expect, it } from "vitest";
import { fallbackRecall, looksLikeQuestion } from "../worker/core/question";

describe("looksLikeQuestion (parser-down fallback only)", () => {
  it("catches the questions people type", () => {
    for (const q of [
      "What have I got to do today",
      "Have I got any upcoming things on my calendar?",
      "what's on tomorrow",
      "Do I have anything this week",
      "did I pay the plumber",
      "is there anything due",
      "show me my list",
    ])
      expect(looksLikeQuestion(q), q).toBe(true);
  });
  it("leaves notes alone, even ones starting with a question word", () => {
    for (const n of ["buy milk", "When I get home call mom", "What to get Emma: blue Lego set", "Remind me what the plumber said", "Emma's shoe size is 11", "Where the spare key is: kitchen drawer"])
      expect(looksLikeQuestion(n), n).toBe(false);
  });
  it("scopes by the time words used", () => {
    expect(fallbackRecall("What have I got to do today").scheduled).toMatchObject({ type: "relative", unit: "day", offset: 0 });
    expect(fallbackRecall("anything tomorrow?").scheduled).toMatchObject({ unit: "day", offset: 1 });
    expect(fallbackRecall("Have I got any upcoming things on my calendar?").scheduled.type).toBe("none");
    expect(fallbackRecall("x").status).toBe("open");
  });
});
