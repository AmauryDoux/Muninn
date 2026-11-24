import { useEffect, useState } from "react";
import { groupItems, type Bucket } from "../../worker/core/group";
import { category, formatAttr, type Attrs } from "../../worker/core/categories";
import { api, type Item, type Person } from "./api";
import { errText } from "./auth";
import { PersonPick, WhenEdit } from "./capture";
import { ago, todayBounds, when } from "./fmt";
import { Icon } from "./icons";
import { Back, Empty, SectionH, Sheet, haptic, peopleChanged } from "./ui";

const LABELS: Record<Bucket, string> = { overdue: "Overdue", today: "Today", upcoming: "Coming up", anytime: "Anytime", snoozed: "Snoozed" };

export function iconFor(item: Pick<Item, "subtype" | "from_reminder" | "kind">): string {
  const c = category(item.subtype);
  if (c) return c.icon;
  if (item.from_reminder) return "bell";
  return item.kind === "event" ? "calendar" : item.kind === "note" ? "known" : "check";
}

export function ItemRow({ item, onChange }: { item: Item; onChange: () => void }) {
  const [menu, setMenu] = useState(false);
  const [done, setDone] = useState(item.status !== "open");
  async function act(action: string, preset?: string) {
    haptic();
    if (action === "done") setDone(true);
    if (action === "reopen") setDone(false);
    setMenu(false);
    try {
      await api(`/api/items/${item.id}/act`, { body: { action, preset } });
    } finally {
      onChange();
    }
  }
  const c = category(item.subtype);
  const w = when(item);
  return (
    <li className={`irow ${done ? "done" : item.status}`}>
      {item.status === "open" ? (
        <button className={done ? "check done" : "check"} aria-label={item.recurrence ? "Done for now" : "Done"} onClick={() => act("done")}>
          <Icon name="check" size={16} />
        </button>
      ) : (
        <button className="check done" aria-label="Reopen" onClick={() => act("reopen")}>
          <Icon name="check" size={16} />
        </button>
      )}
      <a className="body" href={`#/item/${item.id}`}>
        <span className="title">{item.title}</span>
        <span className="meta">
          {c && (
            <span className={`tint g-${c.group}`}>
              <Icon name={c.icon} size={14} />
              {/* Alone, an icon reads as a glitch: name the category when nothing else is shown. */}
              {!w && !item.recurrence_text && !item.for_person && !item.requested_by && !item.place_hint && !item.status_line && <> {c.label}</>}
            </span>
          )}
          {w && <span>{w}</span>}
          {item.recurrence_text && (
            <span>
              <Icon name="repeat" size={13} /> {item.recurrence_text}
            </span>
          )}
          {item.for_person && <span>for {item.for_person.name}</span>}
          {item.requested_by && <span>from {item.requested_by.name}</span>}
          {item.place_hint && <span>{item.place_hint}</span>}
          {item.status_line && <span className={`tone-${item.status_line.tone}`}>{item.status_line.text}</span>}
        </span>
      </a>
      {item.status === "open" && (
        <button className="iconbtn" aria-label="More" onClick={() => setMenu(true)}>
          <Icon name="more" />
        </button>
      )}
      {menu && (
        <Sheet title={item.title} onClose={() => setMenu(false)}>
          <div className="actions">
            <button className="action" onClick={() => act("snooze", "1h")}>
              <Icon name="clock" /> In 1 hour
            </button>
            <button className="action" onClick={() => act("snooze", "evening")}>
              <Icon name="snooze" /> This evening
            </button>
            <button className="action" onClick={() => act("snooze", "tomorrow")}>
              <Icon name="today" /> Tomorrow morning
            </button>
            <button className="action" onClick={() => act("snooze", "next_week")}>
              <Icon name="calendar" /> Next week
            </button>
            <button className="action danger" onClick={() => act("dismiss")}>
              <Icon name="x" /> Drop it
            </button>
          </div>
        </Sheet>
      )}
    </li>
  );
}

export function ItemList({ items, onChange }: { items: Item[]; onChange: () => void }) {
  return (
    <ul className="list list-card">
      {items.map((i) => (
        <ItemRow key={i.id} item={i} onChange={onChange} />
      ))}
    </ul>
  );
}

export function OpenList({ items, onChange, only, emptyText }: { items: Item[]; onChange: () => void; only?: Bucket[]; emptyText?: string }) {
  const { start, end } = todayBounds();
  const g = groupItems(items, new Date(), start, end);
  const order: Bucket[] = only ?? ["overdue", "today", "upcoming", "anytime", "snoozed"];
  const shown = order.filter((b) => g[b].length);
  if (!shown.length) return <Empty icon="check">{emptyText ?? "All clear."}</Empty>;
  return (
    <>
      {shown.map((b) => (
        <section key={b}>
          <SectionH count={g[b].length}>
            <span className={b === "overdue" ? "tone-bad" : undefined}>{LABELS[b]}</span>
          </SectionH>
          <ItemList items={g[b]} onChange={onChange} />
        </section>
      ))}
    </>
  );
}

export function DoneList() {
  const [items, setItems] = useState<Item[] | null>(null);
  const load = () => api<{ items: Item[] }>("/api/items?view=done").then((r) => setItems(r.items));
  useEffect(() => {
    load();
  }, []);
  if (!items) return <p className="muted center">Loading…</p>;
  if (!items.length) return <Empty icon="check">Nothing done yet.</Empty>;
  return <ItemList items={items} onChange={load} />;
}

export function ItemDetail({ id, people, onBack }: { id: string; people: Person[]; onBack: () => void }) {
  const [item, setItem] = useState<Item | null>(null);
  const [edit, setEdit] = useState<"" | "title" | "details" | "for" | "by" | "when" | "attrs">("");
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    api<{ item: Item }>(`/api/items/${id}`)
      .then((r) => setItem(r.item))
      .catch((e) => setErr(errText(e)));
  }, [id]);

  async function patch(body: Record<string, unknown>) {
    try {
      const r = await api<{ item: Item }>(`/api/items/${id}`, { method: "PATCH", body });
      setItem(r.item);
      setEdit("");
      if ("for_person_name" in body || "requested_by_name" in body) peopleChanged();
    } catch (e) {
      setErr(errText(e));
    }
  }
  async function act(action: string) {
    haptic();
    const r = await api<{ item: Item }>(`/api/items/${id}/act`, { body: { action } });
    setItem(r.item);
  }
  async function remove() {
    if (!confirm("Delete this item and its original note for good?")) return;
    try {
      await api(`/api/items/${id}`, { method: "DELETE" });
      onBack();
    } catch (e) {
      setErr(errText(e));
    }
  }

  if (!item) return <p className="muted center">{err || "Loading…"}</p>;
  const c = category(item.subtype);
  const attrs = (item.attrs ?? {}) as Attrs;
  return (
    <div className="detail">
      <Back onClick={onBack} />
      <div className="row">
        {c && (
          <span className={`badge-icon tint-bg g-${c.group}`}>
            <Icon name={c.icon} size={20} />
          </span>
        )}
        <span className="muted small">{c?.label ?? item.kind}</span>
      </div>
      {edit === "title" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            patch({ title: draft });
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
        </form>
      ) : (
        <h1
          className="largetitle"
          onClick={() => {
            setDraft(item.title);
            setEdit("title");
          }}
        >
          {item.title}
        </h1>
      )}
      {item.status_line && <p className={`tone-${item.status_line.tone}`}>{item.status_line.text}</p>}

      <div className="card tight kv">
        <div className="k">When</div>
        <div className="v tap" onClick={() => setEdit("when")}>
          {when(item) ?? "—"}
          {item.recurrence_text ? ` · ${item.recurrence_text}` : ""}
        </div>
        {(c ? c.person : true) && (
          <>
            <div className="k">{c?.person ?? "For"}</div>
            <div className="v tap" onClick={() => setEdit("for")}>
              {item.for_person?.name ?? "—"}
            </div>
          </>
        )}
        {(!c || c.subtype === "follow_up" || item.requested_by) && (
          <>
            <div className="k">Asked by</div>
            <div className="v tap" onClick={() => setEdit("by")}>
              {item.requested_by?.name ?? "—"}
            </div>
          </>
        )}
        {item.thing && (
          <>
            <div className="k">About</div>
            <div className="v">
              <a href={`#/thing/${item.thing.id}`}>{item.thing.name}</a>
            </div>
          </>
        )}
        {c?.fields
          .filter((f) => attrs[f.key] != null)
          .map((f) => (
            <FieldRow key={f.key} label={f.label} value={formatAttr(f, attrs[f.key])} url={f.type === "url" ? String(attrs[f.key]) : null} phone={f.type === "phone" ? String(attrs[f.key]) : null} />
          ))}
        {item.place_hint && (
          <>
            <div className="k">Place</div>
            <div className="v">{item.place_hint}</div>
          </>
        )}
        <div className="k">Details</div>
        <div
          className="v tap"
          onClick={() => {
            setDraft(item.details ?? "");
            setEdit("details");
          }}
        >
          {item.details ?? "—"}
        </div>
        <div className="k">Captured</div>
        <div className="v">{ago(item.created_at)}</div>
      </div>
      {c && (
        <button className="btn block" onClick={() => setEdit("attrs")}>
          Edit {c.label.toLowerCase()} details
        </button>
      )}

      {edit === "details" && (
        <Sheet title="Details" onClose={() => setEdit("")}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              patch({ details: draft || null });
            }}
          >
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} autoFocus />
            <button className="btn primary block">Save</button>
          </form>
        </Sheet>
      )}
      {edit === "when" && (
        <Sheet title="When" onClose={() => setEdit("")}>
          <WhenEdit item={item} onSave={patch} />
        </Sheet>
      )}
      {edit === "for" && (
        <Sheet title={c?.person ?? "For"} onClose={() => setEdit("")}>
          <PersonPick people={people} value={item.for_person?.name ?? null} onSave={(v) => patch({ for_person_name: v ?? "" })} />
        </Sheet>
      )}
      {edit === "by" && (
        <Sheet title="Asked by" onClose={() => setEdit("")}>
          <PersonPick people={people} value={item.requested_by?.name ?? null} onSave={(v) => patch({ requested_by_name: v ?? "" })} />
        </Sheet>
      )}
      {edit === "attrs" && c && (
        <Sheet title={`${c.label} details`} onClose={() => setEdit("")}>
          <AttrsForm
            subtype={c.subtype}
            initial={attrs}
            onSave={async (a) => {
              try {
                const r = await api<{ item: Item }>(`/api/life/items/${id}`, { method: "PATCH", body: { attrs: a } });
                setItem(r.item);
                setEdit("");
              } catch (e) {
                setErr(errText(e));
              }
            }}
          />
        </Sheet>
      )}
      {err && <p className="error">{err}</p>}
      <div className="stack">
        {item.status === "open" ? (
          <button className="btn primary block" onClick={() => act("done")}>
            <Icon name="check" /> {item.recurrence ? "Done for this time" : item.subtype === "debt" ? "Mark settled" : "Mark done"}
          </button>
        ) : (
          <button className="btn block" onClick={() => act("reopen")}>
            Reopen
          </button>
        )}
        <button className="btn ghost danger" onClick={remove}>
          <Icon name="trash" size={18} /> Delete for good
        </button>
      </div>
    </div>
  );
}

function FieldRow({ label, value, url, phone }: { label: string; value: string; url: string | null; phone: string | null }) {
  return (
    <>
      <div className="k">{label}</div>
      <div className="v">
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer nofollow">
            {new URL(url).hostname}
          </a>
        ) : phone ? (
          <a href={`tel:${phone.replace(/[^\d+]/g, "")}`}>{value}</a>
        ) : (
          value
        )}
      </div>
    </>
  );
}

/** A form generated from the category registry. Money is entered as text ("$40", "12,50 EUR"). */
export function AttrsForm({ subtype, initial, onSave, submitLabel = "Save" }: { subtype: string; initial: Attrs; onSave: (a: Record<string, unknown>) => void; submitLabel?: string }) {
  const c = category(subtype)!;
  const [v, setV] = useState<Record<string, string>>(() =>
    Object.fromEntries(c.fields.map((f) => [f.key, initial[f.key] == null ? "" : f.type === "money" ? formatAttr(f, initial[f.key]) : String(initial[f.key])])),
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(Object.fromEntries(Object.entries(v).filter(([, x]) => x.trim() !== "")));
      }}
    >
      {c.fields.map((f) => (
        <label className="field" key={f.key}>
          {f.label}
          {f.required ? " *" : ""}
          {f.type === "enum" ? (
            <select value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}>
              <option value="">—</option>
              {f.options!.map((o) => (
                <option key={o} value={o}>
                  {f.optionLabels?.[o] ?? o}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={f.type === "date" ? "date" : f.type === "number" ? "number" : f.type === "url" ? "url" : f.type === "phone" ? "tel" : "text"}
              inputMode={f.type === "money" ? "decimal" : f.type === "number" ? "numeric" : undefined}
              value={v[f.key]}
              placeholder={f.placeholder ?? (f.type === "money" ? "e.g. 40 or 40 EUR" : undefined)}
              onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
            />
          )}
        </label>
      ))}
      <button className="btn primary block">{submitLabel}</button>
    </form>
  );
}
