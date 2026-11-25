import { describe, expect, it } from "vitest";
import { whenText } from "../worker/brief";

// The brief model gets each item's date as text so it copies dates instead of inventing them from titles
// (it once said "comedy show tickets for 1 December" for an item due Sun 6 Dec).
describe("whenText", () => {
  const tz = "America/Chicago";
  it("a timed item shows its local day and time", () => {
    expect(whenText({ due_at: "2026-12-06T19:00:00.000Z", window_start: "2026-12-06T19:00:00.000Z", window_end: "2026-12-07T06:00:00.000Z" }, tz)).toBe("Sun 6 Dec 13:00");
  });
  it("a day window shows one day; its exclusive end is not shown as an extra day", () => {
    expect(whenText({ due_at: null, window_start: "2026-12-01T06:00:00.000Z", window_end: "2026-12-02T06:00:00.000Z" }, tz)).toBe("Tue 1 Dec");
  });
  it("a range shows first and last day", () => {
    expect(whenText({ due_at: null, window_start: "2026-11-25T06:00:00.000Z", window_end: "2026-12-02T06:00:00.000Z" }, tz)).toBe("Wed 25 Nov to Tue 1 Dec");
  });
  it("no date: null", () => {
    expect(whenText({ due_at: null, window_start: null, window_end: null }, tz)).toBeNull();
  });
});
