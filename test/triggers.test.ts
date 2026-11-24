import { describe, expect, it } from "vitest";
import { parseRule } from "../worker/core/rrule";
import { nextFire, daysUntil } from "../worker/core/triggers";
import { civilToIso, parseCivil } from "../worker/core/time";

const d = (s: string) => parseCivil(s)!;
const yearly = parseRule("FREQ=YEARLY")!;
const show = (r: ReturnType<typeof nextFire>) => (r ? { occ: civilToIso(r.occurrence), fire: civilToIso(r.fireOn), late: r.late } : null);

describe("nextFire", () => {
  it("fires 14 days before a birthday", () => {
    expect(show(nextFire({ anchor: d("2000-12-20"), repeat: yearly, offsetDays: -14 }, d("2026-11-24")))).toEqual({ occ: "2026-12-20", fire: "2026-12-06", late: false });
  });

  it("catches up when created inside the lead time, for this year's birthday", () => {
    expect(show(nextFire({ anchor: d("2000-11-29"), repeat: yearly, offsetDays: -14 }, d("2026-11-24")))).toEqual({ occ: "2026-11-29", fire: "2026-11-24", late: true });
  });

  it("moves to next year once the birthday has passed", () => {
    expect(show(nextFire({ anchor: d("2000-11-20"), repeat: yearly, offsetDays: -14 }, d("2026-11-24")))).toEqual({ occ: "2027-11-20", fire: "2027-11-06", late: false });
  });

  it("after firing, schedules the following occurrence", () => {
    const spec = { anchor: d("2000-12-20"), repeat: yearly, offsetDays: -14 };
    expect(show(nextFire(spec, d("2026-12-06"), d("2026-12-20")))).toEqual({ occ: "2027-12-20", fire: "2027-12-06", late: false });
  });

  it("one-off before-reminders stop once the date passed; after-reminders fire late once", () => {
    expect(nextFire({ anchor: d("2026-11-01"), repeat: null, offsetDays: -30 }, d("2026-11-24"))).toBeNull();
    expect(show(nextFire({ anchor: d("2026-12-10"), repeat: null, offsetDays: -30 }, d("2026-11-24")))).toEqual({ occ: "2026-12-10", fire: "2026-11-24", late: true });
    expect(show(nextFire({ anchor: d("2026-09-01"), repeat: null, offsetDays: 30 }, d("2026-11-24")))).toEqual({ occ: "2026-09-01", fire: "2026-11-24", late: true });
    expect(nextFire({ anchor: d("2026-09-01"), repeat: null, offsetDays: 30 }, d("2026-11-24"), d("2026-09-01"))).toBeNull();
  });

  it("monthly nudges skip missed months instead of firing a backlog", () => {
    const spec = { anchor: d("2026-06-15"), repeat: parseRule("FREQ=MONTHLY")!, offsetDays: 0 };
    expect(show(nextFire(spec, d("2026-11-24"), d("2026-07-15")))).toEqual({ occ: "2026-12-15", fire: "2026-12-15", late: false });
  });

  it("positive offsets on a repeating anchor catch up the latest occurrence only", () => {
    const spec = { anchor: d("2026-01-10"), repeat: parseRule("FREQ=MONTHLY")!, offsetDays: 20 };
    expect(show(nextFire(spec, d("2026-11-24")))).toEqual({ occ: "2026-11-10", fire: "2026-11-30", late: false });
  });

  it("daysUntil", () => {
    expect(daysUntil(d("2026-12-25"), d("2026-11-24"))).toBe(31);
    expect(daysUntil(d("2026-03-29"), d("2026-03-28"))).toBe(1); // across a DST change, still exact
  });
});
