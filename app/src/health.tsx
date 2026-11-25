// Is Muninn working? Answerable from the phone, without wrangler tail.
import { useEffect, useState } from "react";
import { api } from "./api";
import { errText } from "./auth";
import { ago } from "./fmt";

interface HealthResp {
  cron_last_run: string | null;
  push: { configured: boolean; devices: number; last_delivered_at: string | null; failed_7d: number };
  ai: { spent_month_usd: number; budget_usd: number; errors_7d: number };
  search: { vectorize: boolean; items_without_vector: number };
  backup: { configured: boolean; last_at: string | null };
}

type Tone = "ok" | "warn" | "bad";
const usd = (n: number) => `$${n.toFixed(2)}`;

export function healthRows(h: HealthResp, now = Date.now()): [string, string, Tone][] {
  const cronAge = h.cron_last_run ? now - Date.parse(h.cron_last_run) : Infinity;
  const push = h.push;
  const rows: [string, string, Tone][] = [
    ["Background jobs", h.cron_last_run ? `ran ${ago(h.cron_last_run)}` : "never ran", cronAge < 15 * 60_000 ? "ok" : cronAge < 3600_000 ? "warn" : "bad"],
    [
      "Notifications",
      !push.configured ? "not set up on the server" : !push.devices ? "no device" : push.last_delivered_at ? `delivered ${ago(push.last_delivered_at)}` : "none delivered yet",
      !push.configured || !push.devices || push.failed_7d ? "warn" : "ok",
    ],
  ];
  if (push.failed_7d) rows.push(["Undelivered pushes (7 days)", String(push.failed_7d), "warn"]);
  const spent = h.ai.spent_month_usd;
  rows.push(["AI this month", `${usd(spent)} of ${usd(h.ai.budget_usd)}`, spent >= h.ai.budget_usd ? "bad" : spent > 0.8 * h.ai.budget_usd ? "warn" : "ok"]);
  rows.push(["AI errors (7 days)", String(h.ai.errors_7d), h.ai.errors_7d ? "warn" : "ok"]);
  const waiting = h.search.items_without_vector ? `, ${h.search.items_without_vector} items waiting` : "";
  rows.push(["Search", (h.search.vectorize ? "Vectorize" : "D1") + waiting, "ok"]);
  rows.push(["Weekly backup", !h.backup.configured ? "off (R2 not bound)" : h.backup.last_at ? ago(h.backup.last_at) : "none yet", h.backup.configured ? "ok" : "warn"]);
  return rows;
}

export function Health() {
  const [h, setH] = useState<HealthResp | null>(null);
  const [budget, setBudget] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    api<HealthResp>("/api/health")
      .then((r) => {
        setH(r);
        setBudget(r.ai.budget_usd.toFixed(2));
      })
      .catch(() => setH(null));
  }, []);
  if (!h) return null;
  return (
    <section className="card">
      <h3>Health</h3>
      <table className="usage">
        <tbody>
          {healthRows(h).map(([k, v, tone]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className={`tone-${tone}`}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          api("/api/settings", { method: "PUT", body: { ai_budget_usd: budget } })
            .then(() => setNote("Saved."))
            .catch((err) => setNote(errText(err)));
        }}
      >
        <label className="field">
          Monthly AI budget (USD)
          <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <button className="btn">Save</button>
      </form>
      <p className="muted tiny">Past the budget, notes are still saved, just without AI reading them. Set a limit in the Anthropic console too.</p>
      {note && <p className="small">{note}</p>}
    </section>
  );
}
