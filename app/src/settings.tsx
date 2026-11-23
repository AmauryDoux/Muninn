import { useEffect, useState } from "react";
import { api } from "./api";
import { PasswordHint, errText, registerPasskey } from "./auth";
import { ago, setTz } from "./fmt";

interface SettingsResp {
  settings: Record<string, string | null>;
  vapid_public_key: string | null;
  vectorize: boolean;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

export function Settings({ onSignedOut }: { onSignedOut: () => void }) {
  const [s, setS] = useState<SettingsResp | null>(null);
  const [msg, setMsg] = useState("");
  const [passkeys, setPasskeys] = useState<{ id: string; label: string; created_at: string; last_used_at: string | null }[]>([]);
  const [devices, setDevices] = useState<{ id: string; device_label: string | null; created_at: string; last_ok_at: string | null }[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});

  const load = async () => {
    const r = await api<SettingsResp>("/api/settings");
    setS(r);
    setForm(Object.fromEntries(Object.entries(r.settings).map(([k, v]) => [k, v ?? ""])));
    setPasskeys((await api<{ passkeys: typeof passkeys }>("/api/auth/passkeys")).passkeys);
    setDevices((await api<{ devices: typeof devices }>("/api/devices")).devices);
  };
  useEffect(() => {
    load().catch((e) => setMsg(errText(e)));
  }, []);

  async function enablePush() {
    setMsg("");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        return setMsg(isStandalone() ? "This browser does not support web push." : "On iPhone, add Muninn to the Home Screen first (Share → Add to Home Screen), then open it from there.");
      }
      if (!s?.vapid_public_key) return setMsg("Push is not configured on the server (VAPID_PUBLIC_KEY is empty).");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return setMsg("Notifications are blocked. Allow them in the phone's settings.");
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(s.vapid_public_key) }));
      const label = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "Computer";
      await api("/api/push/subscribe", { body: { ...sub.toJSON(), device_label: label } });
      const r = await api<{ sent: number }>("/api/push/test", { method: "POST", body: {} });
      setMsg(r.sent ? "Reminders are on. A test notification is on its way." : "Subscribed, but the test push did not go through. Check the Worker logs.");
      load();
    } catch (e) {
      setMsg(errText(e));
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ""));
      const r = await api<SettingsResp>("/api/settings", { method: "PUT", body });
      setTz(r.settings.tz);
      setMsg("Saved.");
    } catch (e) {
      setMsg(errText(e));
    }
  }

  async function addPasskey() {
    try {
      await registerPasskey(/iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : "This device");
      setMsg("Passkey added.");
      load();
    } catch (e) {
      setMsg(errText(e));
    }
  }

  async function download() {
    try {
      // Fetch through api() so a stale check triggers the reauth prompt first.
      const text = await api<string>("/api/export");
      const blob = new Blob([typeof text === "string" ? text : JSON.stringify(text, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `muninn-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setMsg(errText(e));
    }
  }

  if (!s) return <p className="muted center">{msg || "Loading…"}</p>;
  const field = (k: string, label: string, type = "text") => (
    <label>
      {label}
      <input type={type} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </label>
  );

  return (
    <div>
      <h2>Settings</h2>
      {msg && <p className="notice">{msg}</p>}

      <section className="card">
        <h3>Reminders</h3>
        <button className="primary" onClick={enablePush}>
          Turn on reminders on this device
        </button>
        <ul className="plain">
          {devices.map((d) => (
            <li key={d.id}>
              {d.device_label ?? "Device"} <span className="muted small">added {ago(d.created_at)}{d.last_ok_at ? `, last push ${ago(d.last_ok_at)}` : ""}</span>{" "}
              <button className="link danger" onClick={() => api(`/api/devices/${d.id}`, { method: "DELETE" }).then(load)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <form className="card" onSubmit={save}>
        <h3>Preferences</h3>
        {field("tz", "Time zone (IANA, e.g. Europe/Paris)")}
        <div className="row">
          {field("quiet_start", "Quiet from", "time")}
          {field("quiet_end", "Quiet until", "time")}
        </div>
        <div className="row">
          {field("brief_time", "Morning brief", "time")}
          {field("daily_cap", "Max pushes a day", "number")}
        </div>
        <div className="row">
          {field("start_hour", "All-day reminders at", "time")}
          {field("evening_hour", "Evening reminders at", "time")}
        </div>
        <button className="primary">Save</button>
      </form>

      <section className="card">
        <h3>Sign-in</h3>
        <ul className="plain">
          {passkeys.map((p) => (
            <li key={p.id}>
              {p.label} <span className="muted small">added {ago(p.created_at)}{p.last_used_at ? `, used ${ago(p.last_used_at)}` : ""}</span>{" "}
              <button className="link danger" onClick={() => api(`/api/auth/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }).then(load).catch((e) => setMsg(errText(e)))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <button onClick={addPasskey}>Add a passkey</button>
        <ChangePassword onMsg={setMsg} />
        <div className="row">
          <button onClick={() => api("/api/auth/logout", { method: "POST", body: {} }).then(onSignedOut)}>Sign out</button>
          <button className="danger" onClick={() => confirm("Sign out every device?") && api("/api/auth/logout-all", { method: "POST", body: {} }).then(onSignedOut)}>
            Sign out all devices
          </button>
        </div>
      </section>

      <Usage />

      <section className="card">
        <h3>Your data</h3>
        <p className="muted small">Everything Muninn holds, as JSON. Search uses {s.vectorize ? "Vectorize" : "vectors stored in D1"}.</p>
        <button onClick={download}>Export JSON</button>
      </section>
    </div>
  );
}

function ChangePassword({ onMsg }: { onMsg: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [p, setP] = useState("");
  useEffect(() => {
    if (open) api<{ username: string | null }>("/api/auth/username").then((r) => setUsername(r.username ?? ""));
  }, [open]);
  if (!open)
    return (
      <button className="link" onClick={() => setOpen(true)}>
        Change username or password
      </button>
    );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api("/api/auth/password", { body: { username, password: p } });
          onMsg("Saved. Your password manager should offer to update it.");
          setOpen(false);
        } catch (x) {
          onMsg(errText(x));
        }
      }}
    >
      <label>
        Username
        <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </label>
      <label>
        New password
        <input name="password" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="new-password" />
      </label>
      <PasswordHint username={username} password={p} />
      <button className="primary">Save</button>
    </form>
  );
}
interface UsageResp {
  month: string;
  calls: number;
  usd: number;
  input_tokens: number;
  output_tokens: number;
  by_job: Record<string, { calls: number; usd: number; model: string; input_tokens: number; output_tokens: number }>;
}

const JOB_LABELS: Record<string, string> = {
  parse: "Reading notes",
  answer: "Answering questions",
  advice: "Advice",
  brief: "Morning brief",
  embed: "Search index (free)",
  transcribe: "Voice (free tier)",
};

/** AI calls this month, per feature, with estimated cost. */
function Usage() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [u, setU] = useState<UsageResp | null>(null);
  useEffect(() => {
    api<UsageResp>(`/api/usage?month=${month}`).then(setU).catch(() => setU(null));
  }, [month]);
  return (
    <section className="card">
      <h3>AI usage</h3>
      <label>
        Month
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
      </label>
      {u && (
        <>
          <p>
            <strong>${u.usd.toFixed(2)}</strong> <span className="muted small">estimated, {u.calls} calls</span>
          </p>
          <table className="usage">
            <tbody>
              {Object.entries(u.by_job)
                .sort((a, b) => b[1].usd - a[1].usd)
                .map(([job, j]) => (
                  <tr key={job}>
                    <td>{JOB_LABELS[job] ?? job}</td>
                    <td className="num">{j.calls}</td>
                    <td className="num">${j.usd.toFixed(3)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
