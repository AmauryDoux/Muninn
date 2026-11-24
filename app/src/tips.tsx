// Proactive tips: each shows why ("because you told me ...") and has act / later / dismiss.
import { useState } from "react";
import { api, type Tip } from "./api";
import { Icon } from "./icons";
import { DOMAIN_NOTE, Disclaimer, haptic } from "./ui";

export function Tips({ tips, onChange }: { tips: Tip[]; onChange: () => void }) {
  if (!tips.length) return null;
  return (
    <div className="tips" aria-label="Suggestions">
      {tips.map((t) => (
        <TipCard key={t.id} tip={t} onChange={onChange} />
      ))}
    </div>
  );
}

function TipCard({ tip, onChange }: { tip: Tip; onChange: () => void }) {
  const [why, setWhy] = useState(false);
  const [gone, setGone] = useState(false);
  async function act(action: "act" | "snooze" | "dismiss") {
    haptic();
    setGone(true);
    try {
      await api(`/api/tips/${tip.id}`, { body: { action } });
    } finally {
      onChange();
    }
    if (action === "act" && tip.item_id) location.hash = `#/item/${tip.item_id}`;
  }
  if (gone) return null;
  return (
    <article className="card tip hero">
      <div className="kicker">
        <Icon name="sparkle" size={14} /> Suggestion
      </div>
      {!tip.wording && <p className="t">{tip.title}</p>}
      <p className="b">{tip.wording ?? tip.body}</p>
      {why && (
        <ul className="because">
          {tip.because.map((b, i) => (
            <li key={i}>
              <Icon name="known" size={14} />
              <span>Because {b.text}</span>
            </li>
          ))}
        </ul>
      )}
      {tip.domain !== "none" && DOMAIN_NOTE[tip.domain] && <Disclaimer text={DOMAIN_NOTE[tip.domain]} />}
      <div className="row">
        <button className="btn small primary" onClick={() => act("act")}>
          {tip.item_id ? "Open" : "Got it"}
        </button>
        <button className="btn small" onClick={() => setWhy(!why)} aria-expanded={why}>
          Why?
        </button>
        <span className="grow" />
        <button className="iconbtn" aria-label="Remind me next week" onClick={() => act("snooze")}>
          <Icon name="snooze" size={20} />
        </button>
        <button className="iconbtn" aria-label="Not useful, don't show again" onClick={() => act("dismiss")}>
          <Icon name="x" size={20} />
        </button>
      </div>
    </article>
  );
}
