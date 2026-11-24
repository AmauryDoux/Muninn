import { describe, expect, it } from "vitest";
import { buildIcs, fold, icsText } from "../worker/core/ics";

describe("iCalendar feed", () => {
  it("escapes text and folds long lines without splitting characters", () => {
    const bs = "\\";
    expect(icsText(`a,b;c${bs}d\ne`)).toBe(`a${bs},b${bs};c${bs}${bs}d${bs}ne`);
    const long = "SUMMARY:" + "é".repeat(60);
    const folded = fold(long);
    for (const l of folded.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("writes timed and all-day events, and skips undated ones", () => {
    const ics = buildIcs(
      [
        { id: "A", title: "Dentist", dueAt: "2026-12-01T15:00:00.000Z", startDate: null, endDate: null, updatedAt: "2026-11-24T00:00:00.000Z" },
        { id: "B", title: "Winter tires, garage", dueAt: null, startDate: "2026-12-05", endDate: "2026-12-07", updatedAt: "2026-11-24T00:00:00.000Z" },
        { id: "C", title: "Someday", dueAt: null, startDate: null, endDate: null, updatedAt: "2026-11-24T00:00:00.000Z" },
      ],
      "m.test",
      new Date("2026-11-24T12:00:00Z"),
    );
    expect(ics).toContain("DTSTART:20261201T150000Z\r\nDTEND:20261201T153000Z");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261205\r\nDTEND;VALUE=DATE:20261207");
    expect(ics).toContain("SUMMARY:Winter tires\\, garage");
    expect(ics).not.toContain("Someday");
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});
