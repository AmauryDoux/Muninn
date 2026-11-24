// Life: every roadmap category in one place, with upcoming dates, balances and the study streak.
import { useCallback, useEffect, useState } from "react";
import { category } from "../../worker/core/categories";
import { formatMoney } from "../../worker/core/money";
import { api, type Item, type Person } from "./api";
import { errText } from "./auth";
import { Icon } from "./icons";
import { AttrsForm, ItemList } from "./items";
import { Back, Empty, PersonInput, SectionH, Sheet, peopleChanged } from "./ui";

interface Summary {
  groups: { id: string; label: string; icon: string; categories: { subtype: string; open: number; total: number }[] }[];
  dates: { fact_id: string; key: string; label: string; who: string | null; date: string; days: number; age: number | null }[];
  balances: { person_id: string | null; name: string; cur: string; minor: number; count: number }[];
  study: { current: number; best: number; todayDone: boolean; weekMinutes: number; daysSinceLast: number | null };
  things: number;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function LifeHome() {
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<Summary>("/api/life")
      .then(setS)
      .catch((e) => setErr(errText(e)));
  }, []);
  if (!s) return <p className="muted center">{err || "Loading…"}</p>;
  return (
    <>
      <SectionH>Coming up</SectionH>
      {s.dates.length ? (
        <div className="dates">
          {s.dates.map((d) => {
            const [, m, day] = d.date.split("-").map(Number);
            return (
              <div key={d.fact_id + d.date} className={d.days <= 14 ? "datecard soon" : "datecard"}>
                <div className="m">{MON[m - 1]}</div>
                <div className="d">{day}</div>
                <div className="w">{d.who ? `${d.who}` : d.label}</div>
                <div className="n">
                  {d.key === "birthday" ? (d.age ? `turns ${d.age}` : "birthday") : d.label.toLowerCase()} · {d.days === 0 ? "today" : `${d.days}d`}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted small">No birthdays or renewals in the next 60 days. Tell me one: "Emma's birthday is March 3".</p>
      )}

      <div className="stats">
        <a className="stat" href="#/life/study_session">
          <Icon name="flame" />
          <div className="v">{s.study.current}</div>
          <div className="l">day study streak{s.study.todayDone ? " · today ✓" : ""}</div>
        </a>
        <a className="stat" href="#/life/debt">
          <Icon name="coins" />
          <div className="v">{s.balances.length ? s.balances.length : "—"}</div>
          <div className="l">{s.balances.length ? `open balance${s.balances.length > 1 ? "s" : ""}` : "nobody owes anybody"}</div>
        </a>
      </div>

      {s.groups.map((g) => (
        <section key={g.id} className={`group g-${g.id}`}>
          <div className="group-h">
            <span className="badge-icon tint-bg">
              <Icon name={g.icon} size={19} />
            </span>
            {g.label}
          </div>
          <div className="tiles">
            {g.categories.map((c) => {
              const cat = category(c.subtype)!;
              return (
                <a key={c.subtype} className="tile" href={`#/life/${c.subtype}`}>
                  <span className="tint">
                    <Icon name={cat.icon} />
                  </span>
                  <span className="name">{cat.plural}</span>
                  <span className="num">{c.total ? (cat.initialStatus === "done" ? `${c.total} logged` : `${c.open} open`) : "Empty"}</span>
                </a>
              );
            })}
            {g.id === "home" && (
              <a className="tile" href="#/things">
                <span className="tint">
                  <Icon name="box" />
                </span>
                <span className="name">Things you own</span>
                <span className="num">{s.things || "Empty"}</span>
              </a>
            )}
            {g.id === "work" && (
              <a className="tile" href="#/digest">
                <span className="tint">
                  <Icon name="inbox" />
                </span>
                <span className="name">Weekly ideas digest</span>
                <span className="num">This week</span>
              </a>
            )}
          </div>
        </section>
      ))}
    </>
  );
}

export function CategoryScreen({ subtype, people, onBack }: { subtype: string; people: Person[]; onBack: () => void }) {
  const cat = category(subtype);
  const [items, setItems] = useState<Item[] | null>(null);
  const [all, setAll] = useState(cat?.initialStatus === "done");
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState("");
  const load = useCallback(
    () =>
      api<{ items: Item[] }>(`/api/life/items?subtype=${subtype}&status=${all ? "all" : "open"}`)
        .then((r) => setItems(r.items))
        .catch((e) => setMsg(errText(e))),
    [subtype, all],
  );
  useEffect(() => {
    load();
  }, [load]);
  if (!cat) return <Empty icon="info">Unknown category.</Empty>;
  return (
    <div className={`g-${cat.group}`}>
      <Back onClick={onBack} label="Life" />
      <div className="row">
        <span className="badge-icon tint-bg">
          <Icon name={cat.icon} size={20} />
        </span>
        <h1 className="largetitle grow">{cat.plural}</h1>
      </div>
      <p className="muted small">Or just say it: "{example(subtype)}"</p>
      <div className="row">
        <div className="seg grow">
          <button className={all ? "" : "on"} onClick={() => setAll(false)}>
            Open
          </button>
          <button className={all ? "on" : ""} onClick={() => setAll(true)}>
            All
          </button>
        </div>
        <button className="btn primary small" onClick={() => setAdding(true)}>
          <Icon name="plus" size={18} /> Add
        </button>
      </div>
      {subtype === "seasonal" && <SeasonalStarter onAdded={load} />}
      {(subtype === "debt" || subtype === "study_session") && <CategoryStats subtype={subtype} key={items?.length ?? 0} />}
      {msg && <p className="error">{msg}</p>}
      <div className="edit">{items == null ? <p className="muted center">Loading…</p> : items.length ? <ItemList items={items} onChange={load} /> : <Empty icon={cat.icon}>Nothing here yet.</Empty>}</div>
      {adding && (
        <Sheet title={`New ${cat.label.toLowerCase()}`} onClose={() => setAdding(false)}>
          <AddForm
            subtype={subtype}
            people={people}
            onDone={(warnings) => {
              setAdding(false);
              setMsg(warnings.length ? `Saved. Some fields were not valid and were skipped: ${warnings.join(", ")}` : "");
              load();
            }}
          />
        </Sheet>
      )}
    </div>
  );
}

function CategoryStats({ subtype }: { subtype: string }) {
  const [s, setS] = useState<Summary | null>(null);
  useEffect(() => {
    api<Summary>("/api/life").then(setS).catch(() => {});
  }, []);
  if (!s) return null;
  if (subtype === "debt") {
    if (!s.balances.length) return null;
    return (
      <div className="card tight edit">
        {s.balances.map((b) => (
          <div key={`${b.person_id}${b.cur}`} className="balance">
            <span>{b.minor > 0 ? `${b.name} owes you` : `You owe ${b.name}`}</span>
            <span className={`amt ${b.minor > 0 ? "tone-ok" : "tone-warn"}`}>{formatMoney({ minor: Math.abs(b.minor), cur: b.cur })}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="stats edit">
      <div className="stat">
        <Icon name="flame" />
        <div className="v">{s.study.current}</div>
        <div className="l">day streak · best {s.study.best}</div>
      </div>
      <div className="stat">
        <Icon name="clock" />
        <div className="v">{Math.round((s.study.weekMinutes / 60) * 10) / 10}h</div>
        <div className="l">studied this week</div>
      </div>
    </div>
  );
}

function example(subtype: string): string {
  return (
    {
      gift_idea: "Sarah mentioned she likes that blue scarf",
      occasion: "Emma's recital is on December 12",
      inventory: "The spare car key is in the blue drawer",
      service_record: "Bob fixed the dishwasher today for $120, 555-0134",
      seasonal: "Clean the gutters every April and November",
      debt: "I lent Mike $40",
      warranty: "Bought the TV at Best Buy today for $499, 2-year warranty",
      follow_up: "Boss asked me to send the report Friday",
      idea: "Idea: write up the AD lab as a blog post",
      cert: "My OSCP expires June 2028, need 40 CPE",
      study_session: "Did 90 minutes of HTB Active Directory labs",
      medication: "Take vitamin D every morning at 8",
      appointment: "Dentist Tuesday at 3pm",
      vaccination: "Got my tetanus shot today",
    } as Record<string, string>
  )[subtype];
}

function AddForm({ subtype, people, onDone }: { subtype: string; people: Person[]; onDone: (warnings: string[]) => void }) {
  const cat = category(subtype)!;
  const [title, setTitle] = useState("");
  const [person, setPerson] = useState("");
  const [thing, setThing] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [repeat, setRepeat] = useState(subtype === "medication" ? "FREQ=DAILY" : "");
  const [step, setStep] = useState<"basics" | "attrs">("basics");
  const [err, setErr] = useState("");
  const dated = cat.kind !== "note";
  async function save(attrs: Record<string, unknown>) {
    try {
      const r = await api<{ warnings: string[] }>("/api/life/items", {
        body: { subtype, title, for_person_name: person.trim() || null, thing_name: thing || null, attrs, date: date || null, time: time || null, recurrence: repeat || null },
      });
      if (person.trim()) peopleChanged();
      onDone(r.warnings);
    } catch (e) {
      setErr(errText(e));
    }
  }
  if (step === "attrs") return <AttrsForm subtype={subtype} initial={{}} onSave={save} submitLabel={`Save ${cat.label.toLowerCase()}`} />;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return setErr("Give it a name.");
        if (cat.fields.length) setStep("attrs");
        else save({});
      }}
    >
      <label className="field">
        {cat.thing ? "What is it" : "Title"}
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={200} placeholder={cat.label} />
      </label>
      {cat.thing && (
        <label className="field">
          Thing it's about (optional)
          <input value={thing} onChange={(e) => setThing(e.target.value)} placeholder="TV, car, dishwasher" />
        </label>
      )}
      {cat.person && (
        <label className="field">
          {cat.person}
          <PersonInput people={people} value={person} onChange={setPerson} placeholder={subtype === "medication" || subtype === "appointment" || subtype === "vaccination" ? "Me, or type a name" : "Type a name"} />
        </label>
      )}
      {dated && (
        <div className="row">
          <label className="field">
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            Time
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
      )}
      {(subtype === "medication" || subtype === "seasonal" || subtype === "follow_up") && (
        <label className="field">
          Repeats
          <select value={repeat} onChange={(e) => setRepeat(e.target.value)}>
            <option value="">Does not repeat</option>
            <option value="FREQ=DAILY">Every day</option>
            <option value="FREQ=WEEKLY">Every week</option>
            <option value="FREQ=MONTHLY">Every month</option>
            <option value="FREQ=MONTHLY;INTERVAL=3">Every 3 months</option>
            <option value="FREQ=MONTHLY;INTERVAL=6">Every 6 months</option>
            <option value="FREQ=YEARLY">Every year</option>
          </select>
        </label>
      )}
      {err && <p className="error">{err}</p>}
      <button className="btn primary block">{cat.fields.length ? "Next" : "Save"}</button>
    </form>
  );
}

function SeasonalStarter({ onAdded }: { onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card notice">
      <p className="small">Add a starter checklist (winter and summer tires, gutters, filters, detectors, outdoor taps). Each one repeats and can be edited.</p>
      <button
        className="btn small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await api("/api/life/seasonal-starter", { method: "POST", body: {} });
          setBusy(false);
          onAdded();
        }}
      >
        <Icon name="leaf" size={18} /> Add starter checklist
      </button>
    </div>
  );
}

// ---- things ----

interface Thing {
  id: string;
  name: string;
  kind: string;
  attrs: Record<string, string>;
  items?: number;
}

export function ThingsScreen({ onBack }: { onBack: () => void }) {
  const [things, setThings] = useState<Thing[] | null>(null);
  const [name, setName] = useState("");
  const load = () => api<{ things: Thing[] }>("/api/things").then((r) => setThings(r.things));
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="g-home">
      <Back onClick={onBack} label="Life" />
      <h1 className="largetitle">Things you own</h1>
      <p className="muted small">Where they are, sizes, models, and their history. Ask "where's the spare key?" any time.</p>
      <form
        className="row edit"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          await api("/api/things", { body: { name } });
          setName("");
          load();
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add a thing (e.g. Furnace)" />
        <button className="btn primary">Add</button>
      </form>
      {things == null ? (
        <p className="muted center">Loading…</p>
      ) : things.length ? (
        <ul className="list list-card edit">
          {things.map((t) => (
            <li key={t.id} className="irow">
              <span className="badge-icon tint-bg">
                <Icon name={t.kind === "key" ? "key" : t.kind === "vehicle" ? "wrench" : "box"} size={18} />
              </span>
              <a className="body" href={`#/thing/${t.id}`}>
                <span className="title">{t.name}</span>
                <span className="meta">{[t.attrs.location, t.attrs.size, t.items ? `${t.items} records` : null].filter(Boolean).join(" · ") || t.kind}</span>
              </a>
              <Icon name="chevronRight" className="chev" size={18} />
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon="box">Nothing yet. Say "the spare car key is in the blue drawer".</Empty>
      )}
    </div>
  );
}

export function ThingDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<{ thing: Thing; items: Item[]; facts: { id: string; key: string; value: string }[] } | null>(null);
  const [edit, setEdit] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(() => api<typeof d>(`/api/things/${id}`).then(setD).catch((e) => setErr(errText(e))), [id]);
  useEffect(() => {
    load();
  }, [load]);
  if (!d) return <p className="muted center">{err || "Loading…"}</p>;
  const fields = ["location", "size", "model", "serial", "notes"];
  return (
    <div className="g-home">
      <Back onClick={onBack} label="Things" />
      <h1 className="largetitle">{d.thing.name}</h1>
      <div className="card tight kv">
        {fields.map((k) => (
          <FieldPair key={k} k={k} v={d.thing.attrs[k]} />
        ))}
        {d.facts
          .filter((f) => !fields.includes(f.key))
          .map((f) => (
            <FieldPair key={f.id} k={f.key} v={f.value} />
          ))}
      </div>
      <button className="btn block" onClick={() => setEdit(true)}>
        Edit details
      </button>
      <SectionH count={d.items.length}>History</SectionH>
      {d.items.length ? <ItemList items={d.items} onChange={load} /> : <p className="muted small">No warranty, service or notes linked yet.</p>}
      <button
        className="btn ghost danger edit"
        onClick={async () => {
          if (!confirm(`Forget ${d.thing.name}? Linked notes stay.`)) return;
          await api(`/api/things/${id}`, { method: "DELETE" });
          onBack();
        }}
      >
        <Icon name="trash" size={18} /> Forget this thing
      </button>
      {edit && (
        <Sheet title={d.thing.name} onClose={() => setEdit(false)}>
          <ThingForm
            thing={d.thing}
            onSave={async (attrs) => {
              await api(`/api/things/${id}`, { method: "PATCH", body: { attrs } });
              setEdit(false);
              load();
            }}
          />
        </Sheet>
      )}
    </div>
  );
}

function FieldPair({ k, v }: { k: string; v: string | undefined }) {
  return (
    <>
      <div className="k">{k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ")}</div>
      <div className="v">{v || "—"}</div>
    </>
  );
}

function ThingForm({ thing, onSave }: { thing: Thing; onSave: (a: Record<string, string | null>) => void }) {
  const keys = ["location", "size", "model", "serial", "notes"];
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(keys.map((k) => [k, thing.attrs[k] ?? ""])));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(Object.fromEntries(keys.map((k) => [k, v[k].trim() || null])));
      }}
    >
      {keys.map((k) => (
        <label key={k} className="field">
          {k[0].toUpperCase() + k.slice(1)}
          <input value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
        </label>
      ))}
      <button className="btn primary block">Save</button>
    </form>
  );
}

// ---- ideas digest ----

export function Digest({ onBack }: { onBack: () => void }) {
  const [days, setDays] = useState(7);
  const [d, setD] = useState<{ count: number; open_total: number; groups: Item[][] } | null>(null);
  const load = useCallback(() => api<typeof d>(`/api/digest?days=${days}`).then(setD), [days]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="g-work">
      <Back onClick={onBack} label="Life" />
      <h1 className="largetitle">Ideas digest</h1>
      <div className="seg edit">
        {[7, 30, 90].map((n) => (
          <button key={n} className={days === n ? "on" : ""} onClick={() => setDays(n)}>
            {n === 7 ? "This week" : `${n} days`}
          </button>
        ))}
      </div>
      {!d ? (
        <p className="muted center">Loading…</p>
      ) : !d.count ? (
        <Empty icon="bulb">No new ideas in this period. Capture one with "idea: …".</Empty>
      ) : (
        <>
          <p className="muted small">
            {d.count} new, {d.open_total} open in total. Related ideas are grouped together.
          </p>
          {d.groups.map((g, i) => (
            <div key={i} className="digest-group">
              {g.length > 1 && <div className="gh">Related · {g.length}</div>}
              <ItemList items={g} onChange={load} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}


