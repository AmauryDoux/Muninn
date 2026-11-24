// Pure matching of things you own ("the TV", "my car", "spare car key"). No I/O.
import { normalizeMention } from "./people";

export interface ThingRef {
  id: string;
  name: string;
  kind: string;
}

const STOP = new Set(["the", "my", "our", "a", "an", "of", "for", "and"]);

export function thingTokens(s: string): string[] {
  return normalizeMention(s)
    .split(/[\s-]+/)
    .map((t) => t.replace(/s$/, ""))
    .filter((t) => t && !STOP.has(t));
}

/**
 * Best existing thing for a mention: exact normalised name first, then the highest token overlap
 * (Jaccard >= 0.5, so "spare key" matches "spare car key" but "car" alone does not match "car key").
 * Ties are refused (null), so a vague mention creates nothing wrong.
 */
export function matchThing<T extends ThingRef>(things: T[], mention: string): T | null {
  const key = thingTokens(mention).join(" ");
  if (!key) return null;
  const exact = things.filter((t) => thingTokens(t.name).join(" ") === key);
  if (exact.length === 1) return exact[0];
  const a = new Set(key.split(" "));
  let best: T | null = null;
  let bestScore = 0;
  let tie = false;
  for (const t of things) {
    const b = new Set(thingTokens(t.name));
    const inter = [...a].filter((x) => b.has(x)).length;
    const score = inter / (a.size + b.size - inter);
    if (score > bestScore) {
      best = t;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) tie = true;
  }
  return bestScore >= 0.5 && !tie ? best : null;
}
