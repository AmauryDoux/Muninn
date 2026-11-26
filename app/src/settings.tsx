import { useEffect, useState } from "react";
import { api } from "./api";
import { CalendarSettings } from "./calsettings";
import { PasswordHint, errText, registerPasskey } from "./auth";
import { ago, setTz } from "./fmt";
import { Health } from "./health";
import { Sessions } from "./sessions";
import { Icon } from "./icons";

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
    <label className="field">
      {label}
      <input type={type} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </label>
  );

  return (
    <div>
      {msg && <p className="notice">{msg}</p>}

      <section className="card">
        <h3>Reminders</h3>
        <button className="btn primary" onClick={enablePush}>
          Turn on reminders on this device
        </button>
        <ul className="plain">
          {devices.map((d) => (
            <li key={d.id}>
              {d.device_label ?? "Device"} <span className="muted small">added {ago(d.created_at)}{d.last_ok_at ? `, last push ${ago(d.last_ok_at)}` : ""}</span>{" "}
              <button className="btn ghost small danger" onClick={() => api(`/api/devices/${d.id}`, { method: "DELETE" }).then(load)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <Toggle
          on={form.push_titles !== "0"}
          label="Show what is due in notifications"
          hint="Notifications are encrypted to your phone; Apple can't read them. To hide them on the lock screen: iPhone Settings, Notifications, Show Previews, When Unlocked."
          onToggle={() => {
            const v = form.push_titles === "0" ? "1" : "0";
            setForm({ ...form, push_titles: v });
            api("/api/settings", { method: "PUT", body: { push_titles: v } }).catch((e) => setMsg(errText(e)));
          }}
        />
      </section>

      <form className="card" onSubmit={save}>
        <h3>Preferences</h3>
        {field("tz", "Time zone (IANA, e.g. Europe/Paris)")}
        <Toggle
          on={form.tz_follow === "1"}
          label="Follow this phone's time zone"
          hint="When you travel, reminders move to local time the next time you open Muninn."
          onToggle={() => setForm({ ...form, tz_follow: form.tz_follow === "1" ? "0" : "1" })}
        />
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
        <button className="btn primary">Save</button>
      </form>

      <CalendarSettings settings={s.settings} onMsg={setMsg} />

      <LifeSettings settings={s.settings} onMsg={setMsg} />

      <Shortcuts onMsg={setMsg} />

      <section className="card">
        <h3>Sign-in</h3>
        <ul className="plain">
          {passkeys.map((p) => (
            <li key={p.id}>
              {p.label} <span className="muted small">added {ago(p.created_at)}{p.last_used_at ? `, used ${ago(p.last_used_at)}` : ""}</span>{" "}
              <button className="btn ghost small danger" onClick={() => api(`/api/auth/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }).then(load).catch((e) => setMsg(errText(e)))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <button className="btn" onClick={addPasskey}>Add a passkey</button>
        <ChangePassword onMsg={setMsg} />
        <Sessions hasPasskey={passkeys.length > 0} onMsg={setMsg} />
        <div className="row">
          <button className="btn" onClick={() => api("/api/auth/logout", { method: "POST", body: {} }).then(onSignedOut)}>Sign out</button>
          <button className="btn danger" onClick={() => confirm("Sign out every device?") && api("/api/auth/logout-all", { method: "POST", body: {} }).then(onSignedOut)}>
            Sign out all devices
          </button>
        </div>
      </section>

      <Health />

      <Usage />

      <section className="card">
        <h3>Your data</h3>
        <p className="muted small">Everything Muninn holds, as JSON. Search uses {s.vectorize ? "Vectorize" : "vectors stored in D1"}.</p>
        <button className="btn" onClick={download}>Export JSON</button>
      </section>
    </div>
  );
}

function Toggle({ on, label, hint, onToggle }: { on: boolean; label: string; hint: string; onToggle: () => void }) {
  return (
    <div className="toggle">
      <div>
        <div>{label}</div>
        <div className="muted tiny">{hint}</div>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className={on ? "switch on" : "switch"} onClick={onToggle} />
    </div>
  );
}

function LifeSettings({ settings, onMsg }: { settings: Record<string, string | null>; onMsg: (m: string) => void }) {
  const [v, setV] = useState({
    currency: settings.currency ?? "USD",
    home_lat: settings.home_lat ?? "",
    home_lon: settings.home_lon ?? "",
    tips_enabled: settings.tips_enabled ?? "1",
    tips_ai: settings.tips_ai ?? "0",
  });
  async function save(patch: Partial<typeof v>) {
    const next = { ...v, ...patch };
    setV(next);
    try {
      const body = Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== ""));
      await api("/api/settings", { method: "PUT", body });
      onMsg("Saved.");
    } catch (e) {
      onMsg(errText(e));
    }
  }
  return (
    <section className="card">
      <h3>Suggestions and life</h3>
      <Toggle on={v.tips_enabled === "1"} label="Proactive suggestions" hint="Built by rules from what you told me; each shows why." onToggle={() => save({ tips_enabled: v.tips_enabled === "1" ? "0" : "1" })} />
      <Toggle on={v.tips_ai === "1"} label="Natural wording" hint="One small AI call a day rewords new tips. Facts and numbers are checked by code." onToggle={() => save({ tips_ai: v.tips_ai === "1" ? "0" : "1" })} />
      <hr />
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          save({ currency: v.currency.toUpperCase() });
        }}
      >
        <label className="field">
          Default currency
          <input value={v.currency} maxLength={3} onChange={(e) => setV({ ...v, currency: e.target.value })} autoCapitalize="characters" />
        </label>
        <button className="btn">Save</button>
      </form>
      <hr />
      <p className="small">Weather cues for seasonal chores (winter tires, frost, heat).</p>
      <p className="muted tiny">Optional. Stored rounded to about 1 km. The forecast comes from Open-Meteo (free, no account), which sees that rounded location once a day.</p>
      <div className="row">
        <button
          className="btn small"
          type="button"
          onClick={() =>
            navigator.geolocation.getCurrentPosition(
              (p) => save({ home_lat: p.coords.latitude.toFixed(2), home_lon: p.coords.longitude.toFixed(2) }),
              () => onMsg("Location was not shared. You can type it instead."),
              { maximumAge: 3600_000, timeout: 10_000 },
            )
          }
        >
          <Icon name="location" size={18} /> Use my location
        </button>
        {v.home_lat && (
          <span className="muted small">
            {v.home_lat}, {v.home_lon}
          </span>
        )}
      </div>
    </section>
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
      <button className="btn ghost small" onClick={() => setOpen(true)}>
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
      <label className="field">
        Username
        <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </label>
      <label className="field">
        New password
        <input name="password" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="new-password" />
      </label>
      <PasswordHint username={username} password={p} />
      <button className="btn primary">Save</button>
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
  last_error?: { at: string; job: string; status: number | null; message: string } | null;
  last_success_at?: string | null;
}

function AiStatus({ u }: { u: UsageResp }) {
  const err = u.last_error;
  const failing = err && (!u.last_success_at || err.at > u.last_success_at);
  const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  if (failing)
    return (
      <p className="ai-error small" role="status">
        <strong>AI is failing.</strong> Last error {when(err.at)} ({JOB_LABELS[err.job] ?? err.job}): {err.status ? `${err.status} ` : ""}
        {err.message.replace(/\.?$/, ".")}
        {err.status === 401 && <> The Anthropic API key is missing or wrong: set it again with wrangler secret put ANTHROPIC_API_KEY.</>}
        {err.status === 429 && <> Rate limit or spend limit reached in the Anthropic Console.</>}
      </p>
    );
  if (u.last_success_at)
    return (
      <p className="ai-ok small" role="status">
        <strong>AI is working.</strong> Last successful call {when(u.last_success_at)}.
      </p>
    );
  return <p className="muted small">No AI calls yet.</p>;
}

const JOB_LABELS: Record<string, string> = {
  parse: "Reading notes",
  answer: "Answering questions",
  advice: "Advice",
  brief: "Morning brief",
  tips: "Suggestion wording",
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
      <label className="field">
        Month
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
      </label>
      {u && (
        <>
          <AiStatus u={u} />
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

interface TokenRow {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

/** Capture-only tokens for an iOS Shortcut: Action button, "Hey Siri, tell Muninn", or the Share sheet. */
function Shortcuts({ onMsg }: { onMsg: (m: string) => void }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const load = () => api<{ tokens: TokenRow[] }>("/api/tokens").then((r) => setTokens(r.tokens));
  useEffect(() => {
    load().catch(() => {});
  }, []);
  const url = `${location.origin}/api/shortcut/capture`;
  async function create() {
    try {
      const r = await api<{ token: string }>("/api/tokens", { body: { label: "iPhone Shortcut" } });
      setFresh(r.token);
      load();
    } catch (e) {
      onMsg(errText(e));
    }
  }
  const [calLink, setCalLink] = useState<string | null>(null);
  const [nudgeKey, setNudgeKey] = useState<string | null>(null);
  async function createNudge() {
    try {
      const r = await api<{ token: string }>("/api/tokens", { body: { scope: "nudge", label: "Arrival" } });
      setNudgeKey(r.token);
      load();
    } catch (e) {
      onMsg(errText(e));
    }
  }
  async function createCalendar() {
    try {
      const r = await api<{ token: string }>("/api/tokens", { body: { scope: "calendar", label: "Calendar" } });
      setCalLink(`webcal://${location.host}/api/calendar/${r.token}.ics`);
      load();
    } catch (e) {
      onMsg(errText(e));
    }
  }
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => onMsg("Copied."), () => onMsg("Copy failed; select the text instead."));
  return (
    <section className="card">
      <h3>Siri, Action button, Share and Calendar</h3>
      <p className="muted small">
        A Shortcut can send a note to Muninn without opening the app. Its key can only add notes: it cannot read, search or change anything.
      </p>
      {fresh ? (
        <div className="notice">
          <p className="small">
            Copy this key now. It is shown only once.
          </p>
          <code className="token">{fresh}</code>
          <div className="row">
            <button className="btn small" onClick={() => copy(fresh)}>Copy key</button>
            <button className="btn small" onClick={() => copy(url)}>Copy address</button>
            <button className="btn ghost small" onClick={() => setFresh(null)}>Done</button>
          </div>
          <ol className="small steps">
            <li>In Shortcuts, make a new shortcut named "Tell Muninn".</li>
            <li>Add "Dictate Text" (or "Receive input from Share Sheet" for sharing text).</li>
            <li>
              Add "Get Contents of URL": the address above, Method POST, Header <code>Authorization</code> = <code>Bearer</code> + space + the key,
              Request Body "File" set to the dictated text.
            </li>
            <li>Add "Get Dictionary Value" for key <code>say</code>, then "Show Notification" (or "Speak Text").</li>
            <li>Settings → Action Button → Shortcut → Tell Muninn. Siri works with "Hey Siri, Tell Muninn".</li>
          </ol>
        </div>
      ) : (
        <button className="btn" onClick={create}>
          Create a Shortcut key
        </button>
      )}
      <hr />
      <p className="small">Calendar: see dated items in the iPhone Calendar app.</p>
      <p className="muted tiny">
        Read-only, titles and dates only. The link is the key, so treat it like a password. If your iPhone syncs subscriptions through iCloud,
        Apple's servers fetch the titles. Revoke it below any time.
      </p>
      {calLink ? (
        <div className="notice">
          <code className="token">{calLink}</code>
          <div className="row">
            <a className="btn primary small" href={calLink}>
              Subscribe
            </a>
            <button className="btn small" onClick={() => copy(calLink)}>Copy link</button>
            <button className="btn ghost small" onClick={() => setCalLink(null)}>Done</button>
          </div>
        </div>
      ) : (
        <button className="btn" onClick={createCalendar}>
          Add to Calendar
        </button>
      )}
      <hr />
      <p className="small">Arrival: "you're at the pharmacy, pick up the prescription".</p>
      {nudgeKey ? (
        <div className="notice">
          <p className="small">Copy this key now. It is shown only once. It can only send a notification to your own devices.</p>
          <code className="token">{nudgeKey}</code>
          <div className="row">
            <button className="btn small" onClick={() => copy(nudgeKey)}>Copy key</button>
            <button className="btn small" onClick={() => copy(`${location.origin}/api/shortcut/arrive`)}>Copy address</button>
            <button className="btn ghost small" onClick={() => setNudgeKey(null)}>Done</button>
          </div>
          <ol className="small steps">
            <li>Shortcuts → Automation → New → Arrive, pick the store, Run Immediately.</li>
            <li>
              Add "Get Contents of URL": the address above, Method POST, Header <code>Authorization</code> = <code>Bearer</code> + space + the key,
              Request Body "File" set to the kind of place, e.g. <code>pharmacy</code> (the same word Muninn shows on the item).
            </li>
          </ol>
        </div>
      ) : (
        <button className="btn" onClick={createNudge}>
          Create an arrival key
        </button>
      )}
      <ul className="plain">
        {tokens.map((t) => (
          <li key={t.id}>
            {t.label} <span className="muted small">made {ago(t.created_at)}{t.last_used_at ? `, used ${ago(t.last_used_at)}` : ", never used"}</span>{" "}
            <button className="btn ghost small danger" onClick={() => api(`/api/tokens/${t.id}`, { method: "DELETE" }).then(load).catch((e) => onMsg(errText(e)))}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
