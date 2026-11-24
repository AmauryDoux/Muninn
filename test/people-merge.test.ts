// People cleanup: merging a duplicate moves everything to the kept person, and no reminder points at a person who
// no longer exists (that would make the trigger's task fail its foreign key when it fires).
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../worker/env";
import { Cipher } from "../worker/lib/crypto";
import { Repo } from "../worker/repo";
import { addFactSmart, fireTriggers } from "../worker/engine";
import { createLifeItem } from "../worker/routes/life";
import { deletePerson, mergePerson } from "../worker/routes/profile";
import { makeD1 } from "./d1-shim";

const TZ = "UTC";
const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
let repo: Repo;
const post = (body: unknown) => new Request("https://m.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(async () => {
  repo = new Repo({ DB: makeD1() } as unknown as Env, await Cipher.fromSecret(KEY), TZ);
});

async function triggerPeople(): Promise<(string | null)[]> {
  const { results } = await repo.db.prepare("SELECT id, payload_enc FROM triggers").all<{ id: string; payload_enc: string }>();
  return Promise.all(results.map(async (t) => (JSON.parse(await repo.cipher.decrypt(t.payload_enc, `triggers:${t.id}:payload`)) as { person_id: string | null }).person_id));
}

describe("merge people", () => {
  it("moves items, facts and reminders to the kept person and keeps the old name as an alias", async () => {
    const emma = await repo.createPerson("Emma", "daughter", []);
    const dup = await repo.createPerson("My daughter", "daughter", ["daughter"]);
    await addFactSmart(repo, { subjectType: "person", subjectId: dup.id, key: "birthday", value: "--12-08", source: "told" }, TZ);
    await createLifeItem(repo, post({ subtype: "gift_idea", title: "Blue Lego set", for_person_id: dup.id }), TZ);

    const r = (await (await mergePerson(repo, post({ into: emma.id }), dup.id, TZ)).json()) as { person: { aliases: string[] }; moved_items: number };
    expect(r.moved_items).toBe(1);
    expect(r.person.aliases).toEqual(expect.arrayContaining(["daughter", "my daughter"]));
    expect((await repo.people()).map((p) => p.id)).not.toContain(dup.id);
    const item = await repo.db.prepare("SELECT for_person_id FROM items").first<{ for_person_id: string }>();
    expect(item!.for_person_id).toBe(emma.id);
    const fact = await repo.db.prepare("SELECT subject_id FROM facts WHERE key = 'birthday'").first<{ subject_id: string }>();
    expect(fact!.subject_id).toBe(emma.id);
    const ids = await triggerPeople();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id === emma.id)).toBe(true);
    // Firing every trigger works (no dangling person).
    await repo.db.prepare("UPDATE triggers SET next_fire_at = '2000-01-01T00:00:00.000Z'").run();
    await expect(fireTriggers(repo, new Date(), TZ)).resolves.toBeGreaterThan(0);
  });

  it("refuses to merge into itself or merge yourself away", async () => {
    const a = await repo.createPerson("A", "friend", []);
    await expect(mergePerson(repo, post({ into: a.id }), a.id, TZ)).rejects.toMatchObject({ status: 400 });
  });

  it("deleting a person rebuilds item reminders so none points at them", async () => {
    const mike = await repo.createPerson("Mike", "friend", []);
    await addFactSmart(repo, { subjectType: "person", subjectId: mike.id, key: "birthday", value: "--12-08", source: "told" }, TZ);
    await createLifeItem(repo, post({ subtype: "gift_idea", title: "Book", for_person_id: mike.id }), TZ);
    await deletePerson(repo, mike.id, TZ);
    expect((await triggerPeople()).includes(mike.id)).toBe(false);
    await repo.db.prepare("UPDATE triggers SET next_fire_at = '2000-01-01T00:00:00.000Z'").run();
    await expect(fireTriggers(repo, new Date(), TZ)).resolves.toBeGreaterThanOrEqual(0);
  });
});
