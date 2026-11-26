// Settings: which holidays to show, and the Google accounts whose calendars appear in Muninn.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { errText } from "./auth";
import { Icon } from "./icons";
import { Toggle } from "./settings";
import { ago } from "./fmt";

const MODES: [string, string][] = [
  ["all", "All"],
  ["federal", "Federal"],
  ["off", "None"],
];

interface GCal {
  id: string;
  name: string;
  color: string | null;
  enabled: boolean;
  synced_at: string | null;
  events: number;
  error: string | null;
}
interface GAccount {
  id: string;
  email: string;
  status: "ok" | "revoked";
  error: string | null;
  calendars: GCal[];
}
interface GState {
  configured: boolean;
  accounts: GAccount[];
}

/** What came back from Google's consent screen (?google=...), in words. */
const RESULT: Record<string, string> = {
  linked: "Google account linked. Your calendars are loading.",
  denied: "Google sign-in was cancelled. Nothing was linked.",
  missing_scope: "Google didn't grant calendar access. Link again and leave the calendar boxes ticked.",
  expired: "That sign-in took too long. Try linking again.",
  bad_state: "That sign-in link was already used or not started here. Try again from Settings.",
  failed: "Google sign-in failed. Try again.",
};

export function CalendarSettings({ settings, onMsg }: { settings: Record<string, string | null>; onMsg: (m: string) => void }) {
  const [mode, setMode] = useState(settings.holidays ?? "all");
  const [g, setG] = useState<GState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(() => RESULT[new URLSearchParams(location.search).get("google") ?? ""] ?? "");

  const load = useCallback(() => api<GState>("/api/google").then(setG).catch((e) => onMsg(errText(e))), [onMsg]);
  useEffect(() => {
    load();
    // Drop ?google=... so a reload doesn't show the message again.
    if (new URLSearchParams(location.search).has("google")) history.replaceState(null, "", location.pathname + location.hash);
  }, [load]);

  const pick = (v: string) => {
    const was = mode;
    setMode(v);
    api("/api/settings", { method: "PUT", body: { holidays: v } }).catch((e) => {
      setMode(was);
      onMsg(errText(e));
    });
  };
  const link = () => {
    setBusy(true);
    api<{ url: string }>("/api/google/connect", { method: "POST" })
      .then((r) => location.assign(r.url))
      .catch((e) => {
        setBusy(false);
        onMsg(errText(e));
      });
  };
  const sync = () => {
    setBusy(true);
    api<{ fetched: number; errors: number }>("/api/google/sync", { method: "POST" })
      .then((r) => setNote(r.errors ? "Synced, with some errors (see below)." : "Up to date."))
      .then(load)
      .catch((e) => onMsg(errText(e)))
      .finally(() => setBusy(false));
  };
  const toggle = (c: GCal) =>
    api<GState>(`/api/google/calendars/${c.id}`, { method: "PATCH", body: { enabled: !c.enabled } })
      .then(setG)
      .catch((e) => onMsg(errText(e)));
  const unlink = (a: GAccount) => {
    if (!confirmUnlink(a.email)) return;
    api<GState>(`/api/google/accounts/${a.id}`, { method: "DELETE" })
      .then(setG)
      .catch((e) => onMsg(errText(e)));
  };

  return (
    <section className="card" id="calendar">
      <h3>Calendar</h3>
      <p className="muted small">Holidays on Today and in the calendar. "All" adds days like Mother's Day, Halloween and clock changes.</p>
      <div className="seg" role="radiogroup" aria-label="Holidays">
        {MODES.map(([v, label]) => (
          <button key={v} role="radio" aria-checked={mode === v} className={mode === v ? "on" : ""} onClick={() => pick(v)}>
            {label}
          </button>
        ))}
      </div>

      <h4 className="gc-h">Google Calendar</h4>
      {note && <p className="notice small">{note}</p>}
      {g && !g.configured && (
        <p className="muted small">
          Not set up yet. Create a Google OAuth client and add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> as Worker secrets (see the README).
        </p>
      )}
      {g?.accounts.map((a) => (
        <div key={a.id} className="gc-account">
          <div className="row">
            <b className="grow">{a.email}</b>
            <button className="btn ghost small danger" onClick={() => unlink(a)}>
              Unlink
            </button>
          </div>
          {a.status === "revoked" && (
            <p className="error small">
              {a.error ?? "Access expired."}{" "}
              <button className="btn ghost small" onClick={link}>
                Link again
              </button>
            </p>
          )}
          {a.status === "ok" && a.error && <p className="error small">{a.error}</p>}
          {a.calendars.map((c) => (
            <Toggle
              key={c.id}
              on={c.enabled}
              label={c.name}
              hint={c.error ? `Error: ${c.error}` : c.enabled ? (c.synced_at ? `${c.events} events, synced ${ago(c.synced_at)}` : "Waiting for first sync") : /holiday/i.test(c.name) ? "Off: Muninn shows holidays itself" : "Hidden"}
              onToggle={() => toggle(c)}
            />
          ))}
        </div>
      ))}
      {g?.configured && (
        <div className="row">
          <button className="btn primary small" disabled={busy} onClick={link}>
            <Icon name="plus" size={18} /> {g.accounts.length ? "Link another Google account" : "Link Google Calendar"}
          </button>
          {g.accounts.length > 0 && (
            <button className="btn small" disabled={busy} onClick={sync}>
              Sync now
            </button>
          )}
        </div>
      )}
      {g?.configured && <p className="muted tiny">Read-only: Muninn can see your events but never change them. Events from a month back to six months ahead are kept, refreshed about every 15 minutes.</p>}
    </section>
  );
}

function confirmUnlink(email: string): boolean {
  // A plain confirm keeps this small; unlinking is easy to redo.
  return window.confirm(`Unlink ${email}? Its events are removed from Muninn and access is revoked at Google.`);
}
