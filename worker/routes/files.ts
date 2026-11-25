// Attachments (receipt photos, warranty PDFs) on an item. Bytes are sealed with DATA_KEY and stored in R2; the
// file id is the associated data, so a blob moved to another id fails to open.
import { HttpError, json } from "../lib/http";
import { ulid } from "../lib/ulid";
import type { Repo } from "../repo";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PER_ITEM = 10;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

const key = (id: string) => `files/${id}`;
const aad = (id: string) => `files:${id}`;

function bucket(repo: Repo): R2Bucket {
  if (!repo.env.BACKUPS) throw new HttpError(501, "files_off", "Photos need the R2 bucket. See README, 'Weekly backup and photos'.");
  return repo.env.BACKUPS;
}

/** Checks the first bytes, so the declared type can't smuggle HTML or script. */
export function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  if (String.fromCharCode(...b.slice(0, 5)) === "%PDF-") return "application/pdf";
  return null;
}

export async function listFiles(repo: Repo, itemId: string): Promise<Response> {
  const { results } = await repo.db.prepare("SELECT id, content_type, size, created_at FROM files WHERE item_id = ? ORDER BY created_at").bind(itemId).all();
  return json({ files: results });
}

export async function uploadFile(repo: Repo, req: Request, itemId: string): Promise<Response> {
  const b = bucket(repo);
  if (!(await repo.getItemRow(itemId))) throw new HttpError(404, "not_found");
  const n = await repo.db.prepare("SELECT COUNT(*) AS n FROM files WHERE item_id = ?").bind(itemId).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_PER_ITEM) throw new HttpError(409, "too_many_files", `At most ${MAX_PER_ITEM} files per item.`);
  if (Number(req.headers.get("Content-Length") ?? "0") > MAX_BYTES) throw new HttpError(413, "too_large", "Up to 8 MB.");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new HttpError(413, "too_large", "Up to 8 MB.");
  const type = sniff(bytes);
  if (!type || !TYPES.has(type)) throw new HttpError(415, "unsupported_file", "Use a JPEG, PNG, WebP photo or a PDF.");
  const id = ulid();
  await b.put(key(id), await repo.cipher.sealBytes(bytes, aad(id)));
  await repo.db
    .prepare("INSERT INTO files (id, item_id, content_type, size, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, itemId, type, bytes.length, new Date().toISOString())
    .run();
  return json({ file: { id, content_type: type, size: bytes.length } });
}

export async function getFile(repo: Repo, id: string): Promise<Response> {
  const row = await repo.db.prepare("SELECT content_type FROM files WHERE id = ?").bind(id).first<{ content_type: string }>();
  if (!row) throw new HttpError(404, "not_found");
  const obj = await bucket(repo).get(key(id));
  if (!obj) throw new HttpError(404, "not_found");
  const plain = await repo.cipher.openBytes(new Uint8Array(await obj.arrayBuffer()), aad(id));
  return new Response(plain as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": row.content_type,
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Opened directly (a PDF in a tab), it can't run anything or reach anything.
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

export async function deleteFile(repo: Repo, id: string): Promise<Response> {
  await repo.db.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
  if (repo.env.BACKUPS) await repo.env.BACKUPS.delete(key(id));
  return json({ ok: true });
}

/** R2 cleanup when an item is deleted (the rows go by ON DELETE CASCADE). */
export async function deleteItemFiles(repo: Repo, itemId: string): Promise<void> {
  const { results } = await repo.db.prepare("SELECT id FROM files WHERE item_id = ?").bind(itemId).all<{ id: string }>();
  if (results.length && repo.env.BACKUPS) await repo.env.BACKUPS.delete(results.map((r) => key(r.id)));
}
