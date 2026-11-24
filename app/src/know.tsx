import { formatAttr } from "../../worker/core/categories";
import { useEffect, useState } from "react";
import { api, type Person } from "./api";
import { errText } from "./auth";
import { ago } from "./fmt";

interface Fact {
  id: string;
  subject_type: string;
  subject_id: string | null;
  key: string;
  value: string;
  source: string;
  review_after: string | null;
  created_at: string;
}
interface Pattern {
  id: string;
  key: string;
  value_json: string;
  sample_size: number;
  computed_at: string;
  active: number;
}

const RELATIONS = ["wife", "husband", "partner", "daughter", "son", "child", "mother", "father", "sister", "brother", "friend", "colleague", "boss", "neighbor", "other"];

/** "What I know about you": every fact and pattern with its source and date, each editable or deletable. */
export function Know({ onPeopleChanged }: { onPeopleChanged: () => void }) {
  const [data, setData] = useState<{ people: Person[]; facts: Fact[]; patterns: Pattern[] } | null>(null);
  const [err, setErr] = useState("");
  const load = () =>
    api<{ people: Person[]; facts: Fact[]; patterns: Pattern[] }>("/api/know")
      .then(setData)
      .catch((e) => setErr(errText(e)));
  useEffect(() => {
    load();
  }, []);

  if (!data) return <p className="muted center">{err || "Loading…"}</p>;
  const factsFor = (type: string, id: string | null) => data.facts.filter((f) => f.subject_type === type && f.subject_id === id);
  const reload = () => {
    load();
    onPeopleChanged();
  };

  return (
    <div>
      <h2>What I know about you</h2>
      <section className="card">
        <h3>You</h3>
        <Facts facts={factsFor("me", null)} onChange={load} />
        <AddFact subjectType="me" subjectId={null} onAdded={load} />
      </section>
      {data.people
        .filter((p) => p.relation !== "self")
        .map((p) => (
          <PersonCard key={p.id} person={p} facts={factsFor("person", p.id)} onChange={reload} />
        ))}
      <AddPerson onAdded={reload} />
      <section className="card">
        <h3>Patterns</h3>
        {data.patterns.length ? (
          <ul className="plain">
            {data.patterns.map((p) => (
              <li key={p.id}>
                <strong>{p.key}</strong> {p.value_json} <span className="muted small">from {p.sample_size} data points, {ago(p.computed_at)}</span>{" "}
                <button className="btn ghost small" onClick={() => api(`/api/patterns/${p.id}`, { method: "PATCH", body: { active: !p.active } }).then(load)}>
                  {p.active ? "Switch off" : "Switch on"}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No patterns yet. They need a few weeks of use (v1.1).</p>
        )}
      </section>
    </div>
  );
}

function Facts({ facts, onChange }: { facts: Fact[]; onChange: () => void }) {
  if (!facts.length) return <p className="muted small">Nothing yet.</p>;
  return (
    <ul className="plain facts">
      {facts.map((f) => (
        <li key={f.id}>
          <span>
            <strong>{f.key.replace(/_/g, " ")}</strong>: {/^(\d{4}|-)-\d{2}-\d{2}$/.test(f.value) ? formatAttr({ key: f.key, label: f.key, type: "date" }, f.value) : f.value}
          </span>
          <span className="muted small">
            {f.source}, {ago(f.created_at)}
          </span>
          <button
            className="btn ghost small"
            onClick={async () => {
              const v = prompt(`New value for ${f.key}`, f.value);
              if (v != null && v.trim()) await api(`/api/facts/${f.id}`, { method: "PATCH", body: { value: v.trim() } });
              onChange();
            }}
          >
            Edit
          </button>
          <button className="btn ghost small danger" onClick={() => api(`/api/facts/${f.id}`, { method: "DELETE" }).then(onChange)}>
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}

function AddFact({ subjectType, subjectId, onAdded }: { subjectType: "me" | "person"; subjectId: string | null; onAdded: () => void }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  return (
    <form
      className="row add"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!key.trim() || !value.trim()) return;
        await api("/api/facts", { body: { subject_type: subjectType, subject_id: subjectId, key, value, source: "told" } });
        setKey("");
        setValue("");
        onAdded();
      }}
    >
      <input placeholder="e.g. shoe size" value={key} onChange={(e) => setKey(e.target.value)} />
      <input placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} />
      <button className="btn">Add</button>
    </form>
  );
}

function PersonCard({ person, facts, onChange }: { person: Person; facts: Fact[]; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(person.name);
  const [aliases, setAliases] = useState(person.aliases.join(", "));
  const [relation, setRelation] = useState(person.relation);
  return (
    <section className="card">
      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await api(`/api/people/${person.id}`, {
              method: "PATCH",
              body: { name, relation, aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean) },
            });
            setEditing(false);
            onChange();
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <select value={relation} onChange={(e) => setRelation(e.target.value)}>
            {RELATIONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="aliases, comma separated" />
          <div className="row">
            <button className="btn primary">Save</button>
            <button
              type="button"
              className="btn ghost small danger"
              onClick={async () => {
                if (confirm(`Forget ${person.name} and their facts?`)) {
                  await api(`/api/people/${person.id}`, { method: "DELETE" });
                  onChange();
                }
              }}
            >
              Forget person
            </button>
          </div>
        </form>
      ) : (
        <h3 onClick={() => setEditing(true)}>
          {person.name}
          <span className="muted small">
            {" · "}
            {[person.relation, ...person.aliases.filter((a) => a.toLowerCase() !== person.relation.toLowerCase() && a.toLowerCase() !== person.name.toLowerCase())].join(", ")}
          </span>
        </h3>
      )}
      <Facts facts={facts} onChange={onChange} />
      <AddFact subjectType="person" subjectId={person.id} onAdded={onChange} />
    </section>
  );
}

function AddPerson({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [relation, setRelation] = useState("other");
  return (
    <form
      className="card row add"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        await api("/api/people", { body: { name, relation, aliases: relation !== "other" ? [relation] : [] } });
        setName("");
        onAdded();
      }}
    >
      <input placeholder="Add a person" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={relation} onChange={(e) => setRelation(e.target.value)}>
        {RELATIONS.map((r) => (
          <option key={r}>{r}</option>
        ))}
      </select>
      <button className="btn">Add</button>
    </form>
  );
}
