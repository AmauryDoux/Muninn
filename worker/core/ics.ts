// iCalendar (RFC 5545) feed of dated items, for a calendar subscription on the iPhone. Pure.

export interface IcsItem {
  id: string;
  title: string;
  /** Exact time (appointments): a 30-minute event. */
  dueAt: string | null;
  /** All-day span, local dates, end exclusive. */
  startDate: string | null;
  endDate: string | null;
  updatedAt: string;
}

/** TEXT escaping (RFC 5545 3.3.11). */
export function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Lines longer than 75 octets are folded with CRLF + space, never inside a UTF-8 sequence. */
export function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      len = 0;
    }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (d: string) => d.replace(/-/g, "");

export function buildIcs(items: IcsItem[], host: string, now = new Date()): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Muninn//Muninn//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Muninn", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  for (const it of items) {
    const ev = ["BEGIN:VEVENT", `UID:${it.id}@${host}`, `DTSTAMP:${stamp(now.toISOString())}`, `LAST-MODIFIED:${stamp(new Date(it.updatedAt).toISOString())}`];
    if (it.dueAt) {
      const start = new Date(it.dueAt);
      ev.push(`DTSTART:${stamp(start.toISOString())}`, `DTEND:${stamp(new Date(start.getTime() + 30 * 60_000).toISOString())}`);
    } else if (it.startDate && it.endDate) {
      ev.push(`DTSTART;VALUE=DATE:${day(it.startDate)}`, `DTEND;VALUE=DATE:${day(it.endDate)}`, "TRANSP:TRANSPARENT");
    } else continue;
    ev.push(`SUMMARY:${icsText(it.title)}`, `URL:https://${host}/#/item/${it.id}`, "END:VEVENT");
    lines.push(...ev);
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
