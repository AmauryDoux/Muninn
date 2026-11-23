import { useCallback, useEffect, useRef, useState } from "react";
import { api, flushQueue, queuedCount, setAuthHandlers, type Item, type Person } from "./api";
import { Login, Reauth, Setup, errText, registerPasskey } from "./auth";
import { CaptureBox } from "./capture";
import { setTz } from "./fmt";
import { DoneList, ItemDetail, OpenList } from "./items";
import { Know } from "./know";
import { Settings } from "./settings";

interface Status {
  setup_done: boolean;
  signed_in: boolean;
  has_passkey: boolean;
}
type Tab = "home" | "upcoming" | "done" | "know" | "settings";

function useHash(): string {
  const [h, setH] = useState(location.hash);
  useEffect(() => {
    const on = () => setH(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return h;
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [reauth, setReauth] = useState<((ok: boolean) => void) | null>(null);
  const refreshStatus = useCallback(() => {
    api<Status>("/api/auth/status")
      .then(setStatus)
      .catch((e) => setErr(errText(e)));
  }, []);
  useEffect(refreshStatus, [refreshStatus]);

  useEffect(() => {
    setAuthHandlers(
      () => new Promise<boolean>((resolve) => setReauth(() => resolve)),
      () => setStatus((s) => (s ? { ...s, signed_in: false } : s)),
    );
  }, []);

  if (!status) return <p className="muted center">{err || "…"}</p>;
  if (!status.setup_done) return <Setup onDone={refreshStatus} />;
  if (!status.signed_in) return <Login hasPasskey={status.has_passkey} onDone={refreshStatus} />;
  return (
    <>
      <Main hasPasskey={status.has_passkey} onSignedOut={refreshStatus} onPasskeyAdded={refreshStatus} />
      {reauth && (
        <Reauth
          hasPasskey={status.has_passkey}
          onClose={(ok) => {
            reauth(ok);
            setReauth(null);
          }}
        />
      )}
    </>
  );
}

function Main({ hasPasskey, onSignedOut, onPasskeyAdded }: { hasPasskey: boolean; onSignedOut: () => void; onPasskeyAdded: () => void }) {
  const initial = new URLSearchParams(location.search).get("view");
  const [tab, setTab] = useState<Tab>(initial === "upcoming" ? "upcoming" : "home");
  const [items, setItems] = useState<Item[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [brief, setBrief] = useState<{ summary: string; date: string } | null>(null);
  const [queued, setQueued] = useState(queuedCount());
  const hash = useHash();
  const loaded = useRef(false);

  const loadItems = useCallback(() => api<{ items: Item[] }>("/api/items?view=open").then((r) => setItems(r.items)), []);
  const loadPeople = useCallback(() => api<{ people: Person[] }>("/api/people").then((r) => setPeople(r.people)), []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    api<{ settings: Record<string, string | null> }>("/api/settings").then((r) => setTz(r.settings.tz));
    loadItems();
    loadPeople();
    api<{ summary: string; date: string }>("/api/brief").then(setBrief).catch(() => {});
    const flush = () =>
      flushQueue().then((n) => {
        setQueued(queuedCount());
        if (n) loadItems();
      });
    flush();
    addEventListener("online", flush);
    return () => removeEventListener("online", flush);
  }, [loadItems, loadPeople]);

  const itemId = hash.match(/^#\/item\/([0-9A-Z]{26})$/)?.[1];

  return (
    <div className="app">
      <header>
        <img src="/icons/raven.svg" alt="" width={28} height={28} />
        <span>Muninn</span>
        {queued > 0 && <span className="badge">{queued} waiting</span>}
      </header>
      <main>
        {itemId ? (
          <ItemDetail
            id={itemId}
            people={people}
            onBack={() => {
              history.back();
              loadItems();
            }}
          />
        ) : (
          <>
            {tab === "home" && (
              <>
                {!hasPasskey && <PasskeyNudge onAdded={onPasskeyAdded} />}
                <CaptureBox
                  people={people}
                  onCaptured={() => {
                    loadItems();
                    loadPeople();
                    setQueued(queuedCount());
                  }}
                />
                {brief && <p className="brief">{brief.summary}</p>}
                <OpenList items={items} onChange={loadItems} only={["overdue", "today", "anytime"]} />
              </>
            )}
            {tab === "upcoming" && <OpenList items={items} onChange={loadItems} only={["upcoming", "snoozed"]} />}
            {tab === "done" && <DoneList />}
            {tab === "know" && <Know onPeopleChanged={loadPeople} />}
            {tab === "settings" && <Settings onSignedOut={onSignedOut} />}
          </>
        )}
      </main>
      <nav>
        {(
          [
            ["home", "Today"],
            ["upcoming", "Upcoming"],
            ["done", "Done"],
            ["know", "Known"],
            ["settings", "Settings"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            className={tab === t && !itemId ? "on" : ""}
            onClick={() => {
              if (itemId) history.back();
              setTab(t);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function PasskeyNudge({ onAdded }: { onAdded: () => void }) {
  const [err, setErr] = useState("");
  return (
    <div className="card notice">
      <p>Add a passkey so you can sign in with Face ID instead of the passphrase.</p>
      <button
        className="primary"
        onClick={() =>
          registerPasskey(/iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : "This device")
            .then(onAdded)
            .catch((e) => setErr(errText(e)))
        }
      >
        Add passkey
      </button>
      {err && <p className="error">{err}</p>}
    </div>
  );
}
