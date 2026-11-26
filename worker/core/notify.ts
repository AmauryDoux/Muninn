// Notification text. Pure: the cron passes decrypted titles only when the user allows titles in pushes.

const MAX_TITLE = 60;
const MAX_LISTED = 3;

export interface Notice {
  title: string;
  body: string;
  url: string;
  tag: string;
  badge: number;
}

const clip = (t: string) => (t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "Buy sheets, Call mom and 2 more". */
export function listTitles(titles: string[]): string {
  const shown = titles.slice(0, MAX_LISTED).map(clip);
  const rest = titles.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** One push for every reminder due in this run. One item opens that item; several open Today. */
export function reminderNotice(o: { ids: string[]; titles: string[] | null; ending: boolean; badge: number }): Notice {
  const n = o.ids.length;
  const url = n === 1 ? `/#/item/${o.ids[0]}` : "/?view=today";
  if (o.titles?.length) {
    return { title: o.ending ? "Ending soon" : n === 1 ? "Reminder" : `${n} reminders`, body: listTitles(o.titles), url, tag: "reminder", badge: o.badge };
  }
  return {
    title: "Muninn",
    body: o.ending ? `${plural(n, "item")} ending soon` : `Reminder: ${plural(n, "item")} due`,
    url,
    tag: "reminder",
    badge: o.badge,
  };
}

/** `holiday`: a greeting for today ("Happy Thanksgiving!"), used as the title. Holiday names are not private. */
export function briefNotice(o: { today: number; overdue: number; titles: string[] | null; holiday?: string | null }): Notice {
  const counts = [`${o.today} for today`];
  if (o.overdue) counts.push(`${o.overdue} overdue`);
  const body = o.titles?.length ? `${counts.join(", ")}: ${listTitles(o.titles)}` : counts.join(", ");
  return { title: o.holiday || "Morning brief", body, url: "/?view=brief", tag: "brief", badge: o.today + o.overdue };
}
