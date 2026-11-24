import { useCallback, useEffect, useRef, useState } from "react";
import { api, flushQueue, queuedCount, setAuthHandlers, type Item, type Person, type Tip } from "./api";
import { Login, Reauth, Setup, errText, registerPasskey } from "./auth";
import { CaptureBox } from "./capture";
import { setTz } from "./fmt";
import { Icon } from "./icons";
import { DoneList, ItemDetail, OpenList } from "./items";
import { Know } from "./know";
import { CategoryScreen, Digest, LifeHome, ThingDetail, ThingsScreen } from "./life";
import { Settings } from "./settings";
import { Tips } from "./tips";

interface Status {
  setup_done: boolean;
  signed_in: boolean;
  has_passkey: boolean;
  needs_username: boolean;
}
type Tab = "home" | "upcoming" | "life" | "know" | "settings";

const TABS: [Tab, string, string][] = [
  ["home", "Today", "today"],
  ["upcoming", "Upcoming", "calendar"],
  ["life", "Life", "life"],
  ["know", "Memory", "known"],
  ["settings", "Settings", "settings"],
];

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

  if (!status) return <p className="muted center">{err || ""}</p>;
  if (!status.setup_done) return <Setup onDone={refreshStatus} />;
  if (!status.signed_in) return <Login hasPasskey={status.has_passkey} needsUsername={status.needs_username} onDone={refreshStatus} />;
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

interface Brief {
  summary: string;
  date: string;
  today: Item[];
  overdue: Item[];
  tips: Tip[];
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function Main({ hasPasskey, onSignedOut, onPasskeyAdded }: { hasPasskey: boolean; onSignedOut: () => void; onPasskeyAdded: () => void }) {
  const initial = new URLSearchParams(location.search).get("view");
  const [tab, setTab] = useState<Tab>(initial === "upcoming" ? "upcoming" : initial === "life" ? "life" : "home");
  const [items, setItems] = useState<Item[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [queued, setQueued] = useState(queuedCount());
  const hash = useHash();
  const loaded = useRef(false);

  const loadItems = useCallback(() => api<{ items: Item[] }>("/api/items?view=open").then((r) => setItems(r.items)), []);
  const loadPeople = useCallback(() => api<{ people: Person[] }>("/api/people").then((r) => setPeople(r.people)), []);
  const loadBrief = useCallback(() => api<Brief>("/api/brief").then(setBrief).catch(() => {}), []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    api<{ settings: Record<string, string | null> }>("/api/settings").then((r) => setTz(r.settings.tz));
    loadItems();
    loadPeople();
    loadBrief();
    if (initial === "digest") location.hash = "#/digest";
    const flush = () =>
      flushQueue().then((n) => {
        setQueued(queuedCount());
        if (n) loadItems();
      });
    flush();
    addEventListener("online", flush);
    // Coming back to the app (it stays alive in the iOS app switcher): refresh.
    const vis = () => document.visibilityState === "visible" && (loadItems(), loadBrief());
    document.addEventListener("visibilitychange", vis);
    return () => {
      removeEventListener("online", flush);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [loadItems, loadPeople, loadBrief, initial]);

  const route = hash.match(/^#\/(item|life|thing)\/([0-9A-Za-z_]{2,40})$/);
  const sub = route ? { kind: route[1], id: route[2] } : hash === "#/things" ? { kind: "things", id: "" } : hash === "#/digest" ? { kind: "digest", id: "" } : null;
  const back = () => {
    if (history.length > 1) history.back();
    else location.hash = "";
    loadItems();
  };

  const counts = { overdue: brief?.overdue.length ?? 0, today: brief?.today.length ?? 0 };
  const titles: Record<Tab, string> = { home: greeting(), upcoming: "Upcoming", life: "Life", know: "Memory", settings: "Settings" };
  const showComposer = !sub && (tab === "home" || tab === "upcoming" || tab === "life");
  const now = new Date();

  return (
    <div className="app">
      <header className="topbar">
        <div className="row1">
          <img className="logo" src="/icons/raven.svg" alt="" width={30} height={30} />
          <span className="brand">Muninn</span>
          <span className="spacer" />
          {queued > 0 && <span className="badge">{queued} waiting</span>}
        </div>
        {!sub && (
          <>
            <h1 className="largetitle">{titles[tab]}</h1>
            {tab === "home" && <p className="subtitle">{now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>}
          </>
        )}
      </header>
      <main className={showComposer ? "" : "no-composer"}>
        {sub?.kind === "item" ? (
          <ItemDetail id={sub.id} people={people} onBack={back} />
        ) : sub?.kind === "life" ? (
          <CategoryScreen subtype={sub.id} people={people} onBack={back} />
        ) : sub?.kind === "thing" ? (
          <ThingDetail id={sub.id} onBack={back} />
        ) : sub?.kind === "things" ? (
          <ThingsScreen onBack={back} />
        ) : sub?.kind === "digest" ? (
          <Digest onBack={back} />
        ) : (
          <>
            {tab === "home" && (
              <>
                {!hasPasskey && <PasskeyNudge onAdded={onPasskeyAdded} />}
                {brief && (
                  <section className="card">
                    <p className="brief">{brief.summary}</p>
                    <div className="brief-meta">
                      <span>
                        <b>{counts.today}</b> today
                      </span>
                      {counts.overdue > 0 && (
                        <span className="tone-bad">
                          <b>{counts.overdue}</b> overdue
                        </span>
                      )}
                    </div>
                  </section>
                )}
                {brief && <Tips tips={brief.tips} onChange={loadBrief} />}
                <OpenList items={items} onChange={() => (loadItems(), loadBrief())} only={["overdue", "today", "anytime"]} emptyText="Nothing due. Tell me what's on your mind." />
              </>
            )}
            {tab === "upcoming" && (
              <>
                <OpenList items={items} onChange={loadItems} only={["upcoming", "snoozed"]} emptyText="Nothing scheduled ahead." />
                <DoneSection />
              </>
            )}
            {tab === "life" && <LifeHome />}
            {tab === "know" && <Know onPeopleChanged={loadPeople} />}
            {tab === "settings" && <Settings onSignedOut={onSignedOut} />}
          </>
        )}
      </main>
      {showComposer && (
        <CaptureBox
          people={people}
          onCaptured={() => {
            loadItems();
            loadPeople();
            loadBrief();
            setQueued(queuedCount());
          }}
        />
      )}
      <nav className="tabbar" aria-label="Sections">
        {TABS.map(([t, label, icon]) => (
          <button
            key={t}
            className={tab === t && !sub ? "on" : ""}
            aria-current={tab === t && !sub ? "page" : undefined}
            onClick={() => {
              if (sub) location.hash = "";
              setTab(t);
              scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            <Icon name={icon} size={24} />
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function DoneSection() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn ghost edit" onClick={() => setOpen(!open)}>
        {open ? "Hide done" : "Show done"}
      </button>
      {open && <DoneList />}
    </>
  );
}

function PasskeyNudge({ onAdded }: { onAdded: () => void }) {
  const [err, setErr] = useState("");
  return (
    <div className="card notice">
      <p className="small">Add a passkey so you can sign in with Face ID instead of your password.</p>
      <button
        className="btn primary small"
        onClick={() =>
          registerPasskey(/iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : "This device")
            .then(onAdded)
            .catch((e) => setErr(errText(e)))
        }
      >
        <Icon name="lock" size={18} /> Add passkey
      </button>
      {err && <p className="error">{err}</p>}
    </div>
  );
}
