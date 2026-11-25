// Photos and receipts on an item. Photos are shrunk on the phone (max 2000 px, JPEG) before upload.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";
import { errText } from "./auth";
import { Icon } from "./icons";

interface FileRow {
  id: string;
  content_type: string;
  size: number;
}

const MAX_SIDE = 2000;

async function shrink(file: File): Promise<Blob> {
  if (file.type === "application/pdf" || !file.type.startsWith("image/")) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", 0.85));
  } catch {
    return file; // the server checks the type anyway
  }
}

export function Attachments({ itemId }: { itemId: string }) {
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(
    () =>
      api<{ files: FileRow[] }>(`/api/items/${itemId}/files`)
        .then((r) => setFiles(r.files))
        .catch(() => setFiles([])),
    [itemId],
  );
  useEffect(() => {
    load();
  }, [load]);

  async function add(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    setErr("");
    try {
      for (const f of Array.from(list)) {
        const blob = await shrink(f);
        await api(`/api/items/${itemId}/files`, { method: "POST", raw: blob, contentType: blob.type || "application/octet-stream" });
      }
      await load();
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "files_off" ? "Photos need the R2 bucket on the server (see README)." : errText(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <section className="card">
      <h3>Photos and receipts</h3>
      <div className="thumbs">
        {files?.map((f) => (
          <div key={f.id} className="thumbwrap">
            <a className={f.content_type === "application/pdf" ? "thumb pdf" : "thumb"} href={`/api/files/${f.id}`} target="_blank" rel="noopener">
              {f.content_type === "application/pdf" ? "PDF" : <img src={`/api/files/${f.id}`} alt="Attachment" loading="lazy" />}
            </a>
            <button
              className="thumbdel"
              aria-label="Remove"
              onClick={() =>
                confirm("Remove this photo or PDF?") &&
                api(`/api/files/${f.id}`, { method: "DELETE" })
                  .then(load)
                  .catch((e) => setErr(errText(e)))
              }
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
        <button className="thumb add" disabled={busy} onClick={() => input.current?.click()} aria-label="Add photo or PDF">
          {busy ? <span className="spinner" /> : <Icon name="plus" />}
        </button>
      </div>
      <input ref={input} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => add(e.target.files)} />
      {err && <p className="error">{err}</p>}
    </section>
  );
}
