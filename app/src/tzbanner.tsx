// Travelling: reminders follow the saved time zone, so offer this phone's zone when it differs, or follow it
// automatically when the user chose that.
import { useState } from "react";
import { api } from "./api";
import { errText } from "./auth";
import { setTz } from "./fmt";

export function deviceTz(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Called once settings are loaded. Returns the zone to offer, or null (same zone, or switched automatically). */
export async function checkTz(settings: Record<string, string | null>): Promise<string | null> {
  const here = deviceTz();
  if (!here || !settings.tz || here === settings.tz) return null;
  if (settings.tz_follow === "1") {
    try {
      await api("/api/settings", { method: "PUT", body: { tz: here } });
      setTz(here);
      return null;
    } catch {
      return here;
    }
  }
  return here;
}

export function TzBanner({ zone, saved, onDone }: { zone: string; saved: string; onDone: () => void }) {
  const [err, setErr] = useState("");
  const save = (body: Record<string, string>) =>
    api("/api/settings", { method: "PUT", body })
      .then(() => {
        if (body.tz) setTz(body.tz);
        onDone();
      })
      .catch((e) => setErr(errText(e)));
  return (
    <div className="card notice">
      <p className="small">
        This phone is on <b>{zone.replace(/_/g, " ")}</b> time, but reminders use <b>{saved.replace(/_/g, " ")}</b>.
      </p>
      <div className="row">
        <button className="btn primary small" onClick={() => save({ tz: zone })}>
          Use {zone.split("/").pop()?.replace(/_/g, " ")}
        </button>
        <button className="btn small" onClick={() => save({ tz: zone, tz_follow: "1" })}>
          Always follow my phone
        </button>
        <button className="btn ghost small" onClick={onDone}>
          Keep
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}
