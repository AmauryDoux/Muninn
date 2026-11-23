import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import { api, ApiError } from "./api";

export async function passkeyLogin(): Promise<void> {
  const optionsJSON = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/auth/passkey/login/options", { method: "POST", body: {} });
  const response = await startAuthentication({ optionsJSON });
  await api("/api/auth/passkey/login/verify", { body: response });
}

export async function passkeyReauth(): Promise<void> {
  const optionsJSON = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/auth/passkey/reauth/options", { method: "POST", body: {} });
  const response = await startAuthentication({ optionsJSON });
  await api("/api/auth/passkey/reauth/verify", { body: response });
}

export async function registerPasskey(label: string): Promise<void> {
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/passkey/register/options", { method: "POST", body: {} });
  const response = await startRegistration({ optionsJSON });
  await api("/api/auth/passkey/register/verify", { body: { response, label } });
}

export function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message && e.message !== e.code ? e.message : e.code.replace(/_/g, " ");
  if (e instanceof Error) return e.name === "NotAllowedError" ? "Cancelled." : e.message;
  return "Something went wrong.";
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pass !== pass2) return setErr("The passphrases do not match.");
    setBusy(true);
    setErr("");
    try {
      await api("/api/auth/setup", { body: { code: code.trim(), passphrase: pass, tz, name: name.trim() } });
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card auth" onSubmit={submit}>
      <h1>Set up Muninn</h1>
      <p className="muted">Enter the one-time setup code you stored with <code>wrangler secret put SETUP_CODE</code>, and choose a long passphrase as your fallback login. You will add a passkey next.</p>
      <label>
        Setup code
        <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" required />
      </label>
      <label>
        Your name
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" />
      </label>
      <label>
        Passphrase (16+ characters)
        <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" minLength={16} required />
      </label>
      <label>
        Passphrase again
        <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" required />
      </label>
      <p className="muted small">Time zone: {tz}</p>
      {err && <p className="error">{err}</p>}
      <button className="primary" disabled={busy}>
        {busy ? "Setting up…" : "Set up"}
      </button>
    </form>
  );
}

export function Login({ hasPasskey, onDone }: { hasPasskey: boolean; onDone: () => void }) {
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPass, setShowPass] = useState(!hasPasskey);

  async function withPasskey() {
    setBusy(true);
    setErr("");
    try {
      await passkeyLogin();
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function withPass(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api("/api/auth/login", { body: { passphrase: pass } });
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card auth">
      <h1>Muninn</h1>
      {hasPasskey && (
        <button className="primary" onClick={withPasskey} disabled={busy}>
          Sign in with passkey
        </button>
      )}
      {showPass ? (
        <form onSubmit={withPass}>
          <label>
            Passphrase
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" required />
          </label>
          <button disabled={busy}>Sign in</button>
        </form>
      ) : (
        <button className="link" onClick={() => setShowPass(true)}>
          Use passphrase instead
        </button>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

/** Modal for sensitive screens: passkey first, passphrase fallback. */
export function Reauth({ hasPasskey, onClose }: { hasPasskey: boolean; onClose: (ok: boolean) => void }) {
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");

  async function viaPasskey() {
    try {
      await passkeyReauth();
      onClose(true);
    } catch (e) {
      setErr(errText(e));
    }
  }
  async function viaPass(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/api/auth/reauth", { body: { passphrase: pass } });
      onClose(true);
    } catch (e) {
      setErr(errText(e));
    }
  }
  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="card">
        <h2>Confirm it's you</h2>
        <p className="muted">This screen holds sensitive data.</p>
        {hasPasskey && (
          <button className="primary" onClick={viaPasskey}>
            Use passkey
          </button>
        )}
        <form onSubmit={viaPass}>
          <label>
            Passphrase
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
          </label>
          <button>Confirm</button>
        </form>
        {err && <p className="error">{err}</p>}
        <button className="link" onClick={() => onClose(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
