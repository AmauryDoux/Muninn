// Signed-in devices, each with its own sign-out, and the passkey-only switch.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { errText } from "./auth";
import { ago } from "./fmt";

interface SessionRow {
  id: string;
  device: string;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

export function Sessions({ hasPasskey, onMsg }: { hasPasskey: boolean; onMsg: (m: string) => void }) {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [pwOn, setPwOn] = useState(true);
  const load = useCallback(() => {
    api<{ sessions: SessionRow[] }>("/api/auth/sessions").then((r) => setRows(r.sessions)).catch(() => {});
    api<{ password_login?: boolean }>("/api/auth/status").then((r) => setPwOn(r.password_login !== false)).catch(() => {});
  }, []);
  useEffect(load, [load]);
  return (
    <>
      <p className="small">Signed in on</p>
      <ul className="plain">
        {rows.map((s) => (
          <li key={s.id}>
            {s.device}{" "}
            <span className="muted small">
              {s.current ? "this device" : `seen ${ago(s.last_seen_at)}`}, since {ago(s.created_at)}
            </span>{" "}
            {!s.current && (
              <button
                className="btn ghost small danger"
                onClick={() =>
                  api(`/api/auth/sessions/${s.id}`, { method: "DELETE" })
                    .then(load)
                    .catch((e) => onMsg(errText(e)))
                }
              >
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
      {hasPasskey && (
        <div className="toggle">
          <div>
            <div>Allow password sign-in</div>
            <div className="muted tiny">
              Off: only your passkey (Face ID) works, so a guessed or leaked password is useless. If you lose every passkey, turn it back on with
              wrangler (see README).
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={pwOn}
            aria-label="Allow password sign-in"
            className={pwOn ? "switch on" : "switch"}
            onClick={() =>
              api("/api/auth/password-login", { body: { enabled: !pwOn } })
                .then(() => {
                  setPwOn(!pwOn);
                  onMsg(pwOn ? "Password sign-in is off." : "Password sign-in is on.");
                })
                .catch((e) => onMsg(errText(e)))
            }
          />
        </div>
      )}
    </>
  );
}
