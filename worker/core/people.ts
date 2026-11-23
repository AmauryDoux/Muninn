// Pure person matching. No I/O.

export interface Person {
  id: string;
  name: string;
  aliases: string[];
  relation: string;
}

export interface PersonMention {
  mention: string;
  relation: string | null;
}

const SELF = new Set(["me", "i", "myself", "self", "mine"]);

export function normalizeMention(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[’']s\b/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(my|our|the) /, "");
}

export function isSelfMention(m: PersonMention): boolean {
  return SELF.has(normalizeMention(m.mention)) || m.relation === "self";
}

/**
 * Find the person a mention refers to. Order: exact name, alias, then relation
 * (only when exactly one person has that relation, so "kid" with two kids stays unresolved).
 */
export function matchPerson(people: Person[], m: PersonMention): Person | null {
  const key = normalizeMention(m.mention);
  if (!key) return null;
  if (isSelfMention(m)) return people.find((p) => p.relation === "self") ?? null;
  const byName = people.filter((p) => normalizeMention(p.name) === key);
  if (byName.length === 1) return byName[0];
  const byAlias = people.filter((p) => p.aliases.some((a) => normalizeMention(a) === key));
  if (byAlias.length === 1) return byAlias[0];
  for (const rel of [key, m.relation ? normalizeMention(m.relation) : null]) {
    if (!rel) continue;
    const byRel = people.filter((p) => p.relation === rel);
    if (byRel.length === 1) return byRel[0];
  }
  return null;
}

/** Relations the parser may return; anything else is stored as "other". */
export const RELATIONS = [
  "self",
  "wife",
  "husband",
  "partner",
  "daughter",
  "son",
  "child",
  "mother",
  "father",
  "sister",
  "brother",
  "friend",
  "colleague",
  "boss",
  "neighbor",
  "other",
] as const;

export function cleanRelation(r: string | null | undefined): string {
  const n = r ? normalizeMention(r) : "";
  return (RELATIONS as readonly string[]).includes(n) ? n : "other";
}
