import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { MIN_PASSWORD, PASSWORD_RULES, passwordProblem, passwordStrength } from "../../worker/core/password";
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

const STRENGTH = ["Too short", "OK. Longer is stronger.", "Good", "Strong"];

export function PasswordHint({ username, password }: { username: string; password: string }) {
  if (!password) return <p className="muted small">{PASSWORD_RULES}</p>;
  const problem = passwordProblem(username, password);
  const s = passwordStrength(password);
  return (
    <p className={`small strength s${problem ? 0 : s}`} aria-live="polite">
      {problem ?? STRENGTH[s]}
    </p>
  );
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pass !== pass2) return setErr("The passwords do not match.");
    setBusy(true);
    setErr("");
    try {
      await api("/api/auth/setup", { body: { code: code.trim(), username: username.trim(), password: pass, tz, name: name.trim() } });
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth" onSubmit={submit} method="post" action="/login">
      <img className="logo-xl" src="/icons/raven.svg" alt="" width={96} height={96} />
      <h1>Set up Muninn</h1>
      <p className="muted">Enter the setup code you stored with <code>wrangler secret put SETUP_CODE</code>, then pick a username and password. You will add a passkey (Face ID) next.</p>
      <label className="field">
        Setup code
        <input name="setup-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoCapitalize="characters" required />
      </label>
      <label className="field">
        Your first name
        <input name="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" />
      </label>
      <label className="field">
        Username
        <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
      </label>
      <label className="field">
        Password
        <input name="password" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" minLength={MIN_PASSWORD} required />
      </label>
      <PasswordHint username={username} password={pass} />
      <label className="field">
        Confirm password
        <input name="password-confirm" type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" required />
      </label>
      <p className="muted small">Time zone: {tz}</p>
      {err && <p className="error">{err}</p>}
      <button className="btn primary" disabled={busy}>
        {busy ? "Setting up…" : "Create account"}
      </button>
    </form>
  );
}

export function Login({ hasPasskey, needsUsername, onDone }: { hasPasskey: boolean; needsUsername: boolean; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

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

  async function withPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api("/api/auth/login", { body: { username: username.trim(), password: pass } });
      onDone();
    } catch (e) {
      setErr(errText(e).replace("bad credentials", "Wrong username or password."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <img className="logo-xl" src="/icons/raven.svg" alt="" width={96} height={96} />
      <h1>Muninn</h1>
      <p className="muted">Your private memory.</p>
      {hasPasskey && (
        <>
          <button className="btn primary" onClick={withPasskey} disabled={busy}>
            Sign in with passkey
          </button>
          <p className="muted small center">or</p>
        </>
      )}
      <form onSubmit={withPassword} method="post" action="/login">
        {needsUsername && <p className="notice small">Usernames are new. Choose one now and sign in with your current passphrase as the password; you can change the password in Settings.</p>}
        <label className="field">
          Username
          <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
        </label>
        <label className="field">
          Password
          <input name="password" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" required />
        </label>
        <button className={hasPasskey ? "btn" : "btn primary"} disabled={busy}>
          Sign in
        </button>
      </form>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

/** Modal for sensitive screens: passkey first, password fallback. */
export function Reauth({ hasPasskey, onClose }: { hasPasskey: boolean; onClose: (ok: boolean) => void }) {
  const [pass, setPass] = useState("");
  const [username, setUsername] = useState("");
  useEffect(() => {
    // Lets the password manager match the saved login.
    api<{ username: string | null }>("/api/auth/username").then((r) => setUsername(r.username ?? "")).catch(() => {});
  }, []);
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
      await api("/api/auth/reauth", { body: { password: pass } });
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
          <button className="btn primary" onClick={viaPasskey}>
            Use passkey
          </button>
        )}
        <form onSubmit={viaPass}>
          <input type="text" name="username" value={username} autoComplete="username" readOnly hidden />
          <label className="field">
            Password
            <input name="password" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
          </label>
          <button className="btn">Confirm</button>
        </form>
        {err && <p className="error">{err}</p>}
        <button className="btn ghost small" onClick={() => onClose(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
