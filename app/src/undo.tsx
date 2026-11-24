// "Done. Undo" for a few seconds after done, snooze or drop: one mis-tap must not hide an item.
import { useEffect, useState } from "react";
import { api } from "./api";

interface Offer {
  itemId: string;
  text: string;
  onChange: () => void;
  key: number;
}

let show: ((o: Offer | null) => void) | null = null;
let seq = 0;

const LABELS: Record<string, string> = { done: "Done", snooze: "Snoozed", dismiss: "Dropped" };

/** Offer to undo the action just taken on an item. */
export function offerUndo(itemId: string, action: string, onChange: () => void): void {
  const text = LABELS[action];
  if (text) show?.({ itemId, text, onChange, key: ++seq });
}

export function UndoToast() {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    show = (o) => {
      setErr("");
      setOffer(o);
    };
    return () => {
      show = null;
    };
  }, []);
  useEffect(() => {
    if (!offer) return;
    const t = setTimeout(() => setOffer((o) => (o?.key === offer.key ? null : o)), 6000);
    return () => clearTimeout(t);
  }, [offer]);
  if (!offer) return null;
  return (
    <div className="toast" role="status">
      <span>{err || offer.text}</span>
      {!err && (
        <button
          className="btn ghost small"
          onClick={() =>
            api(`/api/items/${offer.itemId}/act`, { body: { action: "undo" } })
              .then(() => {
                setOffer(null);
                offer.onChange();
              })
              .catch(() => setErr("Too late to undo."))
          }
        >
          Undo
        </button>
      )}
    </div>
  );
}
