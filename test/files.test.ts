// Receipt photos: sealed in R2, typed by their bytes (not the client's word), removed with their item.
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../worker/env";
import { Cipher } from "../worker/lib/crypto";
import { Repo } from "../worker/repo";
import { deleteFile, getFile, listFiles, sniff, uploadFile } from "../worker/routes/files";
import { deleteItem } from "../worker/routes/items";
import { makeD1 } from "./d1-shim";

const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const ITEM = "01J0000000000000000000000W";
let repo: Repo;
let store: Map<string, Uint8Array>;

beforeEach(async () => {
  store = new Map();
  const bucket = {
    put: async (k: string, v: Uint8Array) => void store.set(k, v),
    get: async (k: string) => (store.has(k) ? { arrayBuffer: async () => store.get(k)!.slice().buffer } : null),
    delete: async (k: string | string[]) => void (Array.isArray(k) ? k : [k]).forEach((x) => store.delete(x)),
  };
  const env = { DB: makeD1(), BACKUPS: bucket } as unknown as Env;
  repo = new Repo(env, await Cipher.fromSecret(KEY), "UTC");
  await env.DB.prepare("INSERT INTO items (id, kind, title_enc, status, created_at, updated_at) VALUES (?, 'note', ?, 'open', 'x', 'x')")
    .bind(ITEM, await repo.cipher.encrypt("TV warranty", `items:${ITEM}:title`))
    .run();
});

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const upload = (body: Uint8Array) => uploadFile(repo, new Request("https://m.test/x", { method: "POST", body: body as Uint8Array<ArrayBuffer> }), ITEM);

describe("files", () => {
  it("stores a photo sealed and serves it back", async () => {
    const r = (await (await upload(jpeg)).json()) as { file: { id: string; content_type: string } };
    expect(r.file.content_type).toBe("image/jpeg");
    const stored = store.get(`files/${r.file.id}`)!;
    expect(Buffer.from(stored).includes(Buffer.from(jpeg))).toBe(false); // not in the clear
    const res = await getFile(repo, r.file.id);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(jpeg);
    const list = (await (await listFiles(repo, ITEM)).json()) as { files: unknown[] };
    expect(list.files).toHaveLength(1);
  });

  it("refuses anything that isn't really an image or PDF", async () => {
    await expect(upload(new TextEncoder().encode("<html><script>alert(1)</script>"))).rejects.toMatchObject({ status: 415 });
    expect(sniff(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
  });

  it("removes the bytes when the file or its item is deleted", async () => {
    const a = (await (await upload(jpeg)).json()) as { file: { id: string } };
    const b = (await (await upload(jpeg)).json()) as { file: { id: string } };
    await deleteFile(repo, a.file.id);
    expect(store.has(`files/${a.file.id}`)).toBe(false);
    await deleteItem(repo, ITEM);
    expect(store.has(`files/${b.file.id}`)).toBe(false);
    expect(await repo.db.prepare("SELECT COUNT(*) AS n FROM files").first()).toEqual({ n: 0 });
  });
});
