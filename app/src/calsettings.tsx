// Settings: which holidays to show, and the Google accounts whose calendars appear in Muninn.
import { useState } from "react";
import { api } from "./api";
import { errText } from "./auth";

const MODES: [string, string][] = [
  ["all", "All"],
  ["federal", "Federal"],
  ["off", "None"],
];

export function CalendarSettings({ settings, onMsg }: { settings: Record<string, string | null>; onMsg: (m: string) => void }) {
  const [mode, setMode] = useState(settings.holidays ?? "all");
  const pick = (v: string) => {
    const was = mode;
    setMode(v);
    api("/api/settings", { method: "PUT", body: { holidays: v } }).catch((e) => {
      setMode(was);
      onMsg(errText(e));
    });
  };
  return (
    <section className="card">
      <h3>Calendar</h3>
      <p className="muted small">Holidays on Today and in the calendar. "All" adds days like Mother's Day, Halloween and clock changes.</p>
      <div className="seg" role="radiogroup" aria-label="Holidays">
        {MODES.map(([v, label]) => (
          <button key={v} role="radio" aria-checked={mode === v} className={mode === v ? "on" : ""} onClick={() => pick(v)}>
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
