import { describe, expect, it } from "vitest";
import { briefNotice, listTitles, reminderNotice } from "../worker/core/notify";

describe("notification text", () => {
  it("lists up to three titles", () => {
    expect(listTitles(["A"])).toBe("A");
    expect(listTitles(["A", "B"])).toBe("A and B");
    expect(listTitles(["A", "B", "C"])).toBe("A, B and C");
    expect(listTitles(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 more");
    expect(listTitles(["x".repeat(100)])).toHaveLength(60);
  });

  it("one reminder opens that item and names it", () => {
    const n = reminderNotice({ ids: ["01ABC"], titles: ["Call mom"], ending: false, badge: 3 });
    expect(n).toEqual({ title: "Reminder", body: "Call mom", url: "/#/item/01ABC", tag: "reminder", badge: 3 });
  });

  it("several reminders open Today", () => {
    const n = reminderNotice({ ids: ["a", "b"], titles: ["Buy sheets", "Call mom"], ending: false, badge: 2 });
    expect(n.title).toBe("2 reminders");
    expect(n.body).toBe("Buy sheets and Call mom");
    expect(n.url).toBe("/?view=today");
  });

  it("falls back to counts when titles are off", () => {
    expect(reminderNotice({ ids: ["a", "b"], titles: null, ending: false, badge: 0 }).body).toBe("Reminder: 2 items due");
    expect(reminderNotice({ ids: ["a"], titles: null, ending: true, badge: 0 }).body).toBe("1 item ending soon");
    expect(briefNotice({ today: 2, overdue: 1, titles: null }).body).toBe("2 for today, 1 overdue");
  });

  it("the brief names what is due and sets the badge", () => {
    const n = briefNotice({ today: 2, overdue: 1, titles: ["Pay rent", "Dentist", "Call mom"] });
    expect(n.body).toBe("2 for today, 1 overdue: Pay rent, Dentist and Call mom");
    expect(n.badge).toBe(3);
  });
});
