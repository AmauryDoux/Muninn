// Weekly review screen: summary, then done, slipped, coming up, and what's still open with people.
import { useCallback, useEffect, useState } from "react";
import { api, type Item } from "./api";
import { ItemList } from "./items";
import { Back, Empty, SectionH } from "./ui";

interface Review {
  week_start: string;
  summary: string;
  counts: { done: number; slipped: number; coming: number; ideas: number; debts: number; follow_ups: number };
  done: Item[];
  slipped: Item[];
  coming: Item[];
  open_with_people: Item[];
}

export function ReviewScreen({ onBack }: { onBack: () => void }) {
  const [r, setR] = useState<Review | null>(null);
  const load = useCallback(() => api<Review>("/api/review").then(setR), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div>
      <Back onClick={onBack} />
      <h1 className="largetitle">Your week</h1>
      {!r ? (
        <p className="muted center">Loading…</p>
      ) : (
        <>
          <section className="card">
            <p className="brief">{r.summary}</p>
          </section>
          {r.slipped.length > 0 && (
            <>
              <SectionH count={r.counts.slipped}>Slipped</SectionH>
              <ItemList items={r.slipped} onChange={load} />
            </>
          )}
          <SectionH count={r.counts.coming}>Next 7 days</SectionH>
          {r.coming.length ? <ItemList items={r.coming} onChange={load} /> : <Empty icon="calendar">Nothing scheduled.</Empty>}
          {r.open_with_people.length > 0 && (
            <>
              <SectionH count={r.counts.debts + r.counts.follow_ups}>Open with people</SectionH>
              <ItemList items={r.open_with_people} onChange={load} />
            </>
          )}
          <SectionH count={r.counts.done}>Done this week</SectionH>
          {r.done.length ? <ItemList items={r.done} onChange={load} /> : <Empty icon="check">Nothing ticked off yet.</Empty>}
          {r.counts.ideas > 0 && (
            <p className="small">
              <a href="#/digest">{r.counts.ideas} new idea{r.counts.ideas === 1 ? "" : "s"} this week →</a>
            </p>
          )}
        </>
      )}
    </div>
  );
}
