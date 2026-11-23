import { useEffect, useState } from "react";
import { groupItems, type Bucket } from "../../worker/core/group";
import { api, type Item, type Person } from "./api";
import { errText } from "./auth";
import { PersonPick, WhenEdit } from "./capture";
import { ago, todayBounds, when } from "./fmt";

const LABELS: Record<Bucket, string> = { overdue: "Overdue", today: "Today", upcoming: "Upcoming", anytime: "Anytime", snoozed: "Snoozed" };

export function ItemRow({ item, onChange }: { item: Item; onChange: () => void }) {
  const [menu, setMenu] = useState(false);
  async function act(action: string, preset?: string) {
    await api(`/api/items/${item.id}/act`, { body: { action, preset } });
    setMenu(false);
    onChange();
  }
  const meta = [when(item), item.for_person && `for ${item.for_person.name}`, item.requested_by && `from ${item.requested_by.name}`, item.place_hint]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className={`item ${item.status}`}>
      {item.status === "open" ? (
        <button className="check" aria-label="Done" onClick={() => act("done")} />
      ) : (
        <button className="check done" aria-label="Reopen" onClick={() => act("reopen")} />
      )}
      <a className="body" href={`#/item/${item.id}`}>
        <span className="title">{item.title}</span>
        {meta && <span className="meta">{meta}</span>}
      </a>
      {item.status === "open" && (
        <button className="more" aria-label="More" onClick={() => setMenu(!menu)}>
          ⋯
        </button>
      )}
      {menu && (
        <div className="menu">
          <button onClick={() => act("snooze", "1h")}>1 hour</button>
          <button onClick={() => act("snooze", "evening")}>This evening</button>
          <button onClick={() => act("snooze", "tomorrow")}>Tomorrow</button>
          <button onClick={() => act("snooze", "next_week")}>Next week</button>
          <button className="danger" onClick={() => act("dismiss")}>
            Drop
          </button>
        </div>
      )}
    </li>
  );
}

export function OpenList({ items, onChange, only }: { items: Item[]; onChange: () => void; only?: Bucket[] }) {
  const { start, end } = todayBounds();
  const g = groupItems(items, new Date(), start, end);
  const order: Bucket[] = only ?? ["overdue", "today", "upcoming", "anytime", "snoozed"];
  const shown = order.filter((b) => g[b].length);
  if (!shown.length) return <p className="muted center">Nothing here.</p>;
  return (
    <>
      {shown.map((b) => (
        <section key={b}>
          <h3>{LABELS[b]}</h3>
          <ul className="items">
            {g[b].map((i) => (
              <ItemRow key={i.id} item={i} onChange={onChange} />
            ))}
          </ul>
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
  if (!items.length) return <p className="muted center">Nothing done yet.</p>;
  return (
    <ul className="items">
      {items.map((i) => (
        <ItemRow key={i.id} item={i} onChange={load} />
      ))}
    </ul>
  );
}

export function ItemDetail({ id, people, onBack }: { id: string; people: Person[]; onBack: () => void }) {
  const [item, setItem] = useState<Item | null>(null);
  const [edit, setEdit] = useState<"" | "title" | "details" | "for" | "by" | "when">("");
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
    } catch (e) {
      setErr(errText(e));
    }
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
  return (
    <div className="card detail">
      <button className="link" onClick={onBack}>
        ← Back
      </button>
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
        <h2
          onClick={() => {
            setDraft(item.title);
            setEdit("title");
          }}
        >
          {item.title}
        </h2>
      )}
      <dl>
        <dt>Kind</dt>
        <dd>{item.kind}</dd>
        <dt>When</dt>
        <dd onClick={() => setEdit("when")}>{when(item) ?? "—"}</dd>
        <dt>For</dt>
        <dd onClick={() => setEdit("for")}>{item.for_person?.name ?? "—"}</dd>
        <dt>Asked by</dt>
        <dd onClick={() => setEdit("by")}>{item.requested_by?.name ?? "—"}</dd>
        <dt>Place</dt>
        <dd>{item.place_hint ?? "—"}</dd>
        <dt>Details</dt>
        <dd
          onClick={() => {
            setDraft(item.details ?? "");
            setEdit("details");
          }}
        >
          {item.details ?? "—"}
        </dd>
        <dt>Captured</dt>
        <dd>{ago(item.created_at)}</dd>
        <dt>Status</dt>
        <dd>{item.status}</dd>
      </dl>
      {edit === "details" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            patch({ details: draft || null });
          }}
        >
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} />
          <button className="primary">Save</button>
        </form>
      )}
      {edit === "when" && <WhenEdit item={item} onSave={patch} />}
      {edit === "for" && <PersonPick people={people} value={item.for_person?.id ?? null} onSave={(v) => patch({ for_person_id: v })} />}
      {edit === "by" && <PersonPick people={people} value={item.requested_by?.id ?? null} onSave={(v) => patch({ requested_by_person_id: v })} />}
      {err && <p className="error">{err}</p>}
      <button className="danger link" onClick={remove}>
        Delete for good
      </button>
    </div>
  );
}
