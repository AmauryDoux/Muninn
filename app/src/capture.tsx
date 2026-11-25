import { useCallback, useEffect, useRef, useState } from "react";
import { api, capture, type Because, type CaptureResult, type GapQuestion, type Item, type Person } from "./api";
import { errText } from "./auth";
import { localDate, when } from "./fmt";
import { Icon } from "./icons";
import { Disclaimer, PersonInput, haptic, peopleChanged } from "./ui";

type SR = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
function speechRecognition(): (new () => SR) | null {
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function grow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(140, el.scrollHeight)}px`;
}

/** One box for both telling and asking. */
export function CaptureBox({ people, onCaptured }: { people: Person[]; onCaptured: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState<"" | "speech" | "record">("");
  const [result, setResult] = useState<CaptureResult | { type: "queued" } | null>(null);
  const [err, setErr] = useState("");
  const [source, setSource] = useState<"text" | "voice">("text");
  const rec = useRef<{ stop: () => void } | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const form = useRef<HTMLFormElement | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const close = useCallback(() => {
    setResult(null);
    setErr("");
  }, []);
  const open = !!(result || err);

  // The result sheet sits just above the composer, whatever height the composer has grown to.
  useEffect(() => {
    const f = form.current;
    if (!f || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty("--composer-h", `${Math.round(f.getBoundingClientRect().height)}px`));
    ro.observe(f);
    return () => ro.disconnect();
  }, []);

  // Dismiss: a tap anywhere outside the sheet and the composer, or Escape. The tap still reaches what it was on.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || panel.current?.contains(t) || form.current?.contains(t)) return;
      if ((t as Element).closest?.(".sheet, .sheet-backdrop, .modal, .toast")) return;
      close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", down, true);
    addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      removeEventListener("keydown", key);
    };
  }, [open, close]);

  // Swipe down on the sheet to dismiss it (only from the top, so scrolling inside it still works).
  const swipe = useRef<{ y: number; top: number } | null>(null);

  async function submit(t = text, src = source) {
    const v = t.trim();
    if (!v) return;
    haptic();
    setBusy(true);
    setErr("");
    try {
      const r = await capture(v, src);
      setResult(r);
      setText("");
      if (area.current) area.current.style.height = "";
      setSource("text");
      if (r.type === "capture") onCaptured();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function recordAudio() {
    // Fallback: record, then transcribe with Whisper on the Worker.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ["audio/webm", "audio/mp4", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => chunks.push(e.data);
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setListening("");
      const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
      setBusy(true);
      try {
        const r = await api<{ text: string }>("/api/transcribe", { raw: blob, contentType: blob.type.split(";")[0] });
        if (r.text) {
          setText(r.text);
          setSource("voice");
        } else setErr("I didn't catch that.");
      } catch (e) {
        setErr(errText(e));
      } finally {
        setBusy(false);
      }
    };
    mr.start();
    setListening("record");
    rec.current = { stop: () => mr.state !== "inactive" && mr.stop() };
    setTimeout(() => rec.current?.stop(), 60_000); // one minute max
  }

  function mic() {
    setErr("");
    if (listening) {
      rec.current?.stop();
      return;
    }
    const Ctor = speechRecognition();
    if (!Ctor) {
      recordAudio().catch((e) => setErr(errText(e)));
      return;
    }
    const sr = new Ctor();
    sr.lang = "en-US";
    sr.interimResults = false;
    sr.continuous = false;
    let got = false;
    sr.onresult = (e) => {
      got = true;
      const t = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join(" ");
      setText(t);
      setSource("voice");
    };
    sr.onerror = (e) => {
      // Installed iOS web apps often fail here; fall back to recording.
      if (e.error !== "aborted" && e.error !== "no-speech") {
        setListening("");
        recordAudio().catch((x) => setErr(errText(x)));
      }
    };
    sr.onend = () => {
      if (!got) setListening((l) => (l === "speech" ? "" : l));
      else setListening("");
    };
    sr.start();
    setListening("speech");
    rec.current = sr;
  }

  return (
    <>
      {open && (
        <div
          className="composer-panel"
          ref={panel}
          onTouchStart={(e) => (swipe.current = { y: e.touches[0].clientY, top: panel.current?.scrollTop ?? 0 })}
          onTouchEnd={(e) => {
            const s = swipe.current;
            swipe.current = null;
            if (s && s.top <= 0 && e.changedTouches[0].clientY - s.y > 60) close();
          }}
        >
          <div className="panel-bar">
            <span className="grabber" />
            <button type="button" className="iconbtn" aria-label="Close" onClick={close}>
              <Icon name="x" size={18} />
            </button>
          </div>
          {err && (
            <div className="card">
              <p className="error">{err}</p>
            </div>
          )}
          {result?.type === "queued" && (
            <div className="card">
              <p className="muted">Couldn't reach Muninn. Saved on this phone; it sends by itself later.</p>
              <button className="btn ghost" onClick={() => setResult(null)}>
                OK
              </button>
            </div>
          )}
          {result?.type === "capture" && result.ai_error && (
            <p className="ai-error small" role="alert">
              The AI could not read this ({result.ai_error}), so it was saved as a plain note. Check Settings → AI usage.
            </p>
          )}
          {result?.type === "capture" && result.updated && result.capture_id && (
            <UpdatedCard
              key={`u-${result.capture_id}`}
              item={result.item}
              captureId={result.capture_id}
              done={result.updated.done}
              onDone={close}
              onNewItem={(item) => {
                setResult({ type: "capture", item, also: [], question: null });
                onCaptured();
              }}
              onChanged={onCaptured}
            />
          )}
          {result?.type === "capture" && !result.updated && (
            <ConfirmCard key={result.item.id} item={result.item} question={result.question} people={people} onDone={close} onChanged={onCaptured} />
          )}
          {result?.type === "capture" && !!result.also?.length && (
            <div className="card">
              <p className="small">
                Also added:{" "}
                {result.also.map((i, n) => (
                  <span key={i.id}>
                    {n > 0 && ", "}
                    <a href={`#/item/${i.id}`}>{i.title}</a>
                    {when(i) ? ` (${when(i)})` : ""}
                  </span>
                ))}
              </p>
            </div>
          )}
          {result?.type === "answer" && result.ai_error && (
            <p className="ai-error small" role="alert">
              The AI call failed ({result.ai_error}). Check Settings → AI usage.
            </p>
          )}
          {result?.type === "answer" && (
            <Answer answer={result.answer} disclaimer={result.disclaimer ?? null} because={result.because ?? []} items={result.items} onClose={close} />
          )}
        </div>
      )}
      <form
        ref={form}
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button type="button" className={listening ? "roundbtn rec" : "roundbtn"} onClick={mic} aria-label={listening ? "Stop" : "Speak"}>
          <Icon name={listening ? "x" : "mic"} />
        </button>
        <textarea
          ref={area}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSource("text");
            grow(e.target);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={listening ? "Listening…" : "Tell me, or ask…"}
          rows={1}
          maxLength={2000}
          enterKeyHint="send"
          aria-label="Tell or ask"
        />
        <button className="roundbtn send" disabled={busy || !text.trim()} aria-label="Send">
          {busy ? <span className="spinner" /> : <Icon name="send" />}
        </button>
      </form>
    </>
  );
}

function Answer({ answer, disclaimer, because, items, onClose }: { answer: string; disclaimer: string | null; because: Because[]; items: Item[]; onClose: () => void }) {
  const [why, setWhy] = useState(false);
  return (
    <div className="card answer">
      <p className="prewrap brief">{answer}</p>
      {disclaimer && <Disclaimer text={disclaimer} />}
      {because.length > 0 && (
        <>
          <button className="btn ghost small" onClick={() => setWhy(!why)} aria-expanded={why}>
            {why ? "Hide reasons" : `Why? (${because.length})`}
          </button>
          {why && (
            <ul className="because">
              {because.map((b, i) => (
                <li key={i}>
                  <Icon name="known" size={14} />
                  <span>Because: {b.text}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {items.length > 0 && (
        <ul className="list">
          {items.map((i) => (
            <li key={i.id} className="irow">
              <a className="body" href={`#/item/${i.id}`} onClick={onClose}>
                <span className="title">{i.title}</span>
                <span className="meta">
                  {i.status_line ? <span className={`tone-${i.status_line.tone}`}>{i.status_line.text}</span> : localDate(i.created_at)}
                </span>
              </a>
              <Icon name="chevronRight" className="chev" size={18} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Field = "title" | "for" | "by" | "when" | "place" | null;

/** The confirmation line: one chip per field, tap to fix. Saves itself after 5 seconds of no interaction. */
export const AUTO_DISMISS_MS = 6000;

/** The note was added to an existing item: say which, and offer to make it a new item or undo. */
function UpdatedCard({
  item,
  captureId,
  done,
  onDone,
  onNewItem,
  onChanged,
}: {
  item: Item;
  captureId: string;
  done: boolean;
  onDone: () => void;
  onNewItem: (item: Item) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);
  useEffect(() => {
    if (busy || err) return;
    // Longer than a plain save: this changed something that already existed.
    const t = setTimeout(() => doneRef.current(), AUTO_DISMISS_MS * 2);
    return () => clearTimeout(t);
  }, [busy, err]);
  async function revert(asNew: boolean) {
    setBusy(true);
    try {
      const r = await api<{ item: Item }>(`/api/captures/${captureId}/revert-update`, { body: { as_new: asNew } });
      onChanged();
      if (asNew) onNewItem(r.item);
      else onDone();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }
  return (
    <div className="card confirm gold">
      <p className="small muted">
        <Icon name="check" size={14} className="tone-ok" /> {done ? "Marked done" : "Added to"}
      </p>
      <p>
        <a href={`#/item/${item.id}`} onClick={onDone}>
          <b>{item.title}</b>
        </a>
      </p>
      <div className="row">
        <button className="btn ghost small" disabled={busy} onClick={() => revert(true)}>
          Make it a new item instead
        </button>
        <button className="btn ghost small" disabled={busy} onClick={() => revert(false)}>
          Undo
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

export function ConfirmCard({
  item: initial,
  question,
  people,
  onDone,
  onChanged,
}: {
  item: Item;
  question: GapQuestion | null;
  people: Person[];
  onDone: () => void;
  onChanged: () => void;
}) {
  const [item, setItem] = useState(initial);
  const [editing, setEditing] = useState<Field>(null);
  const [touched, setTouched] = useState(!!question);
  const [answer, setAnswer] = useState("");
  const [err, setErr] = useState("");

  // Goes away by itself after a few seconds, unless a chip is being edited or a question is waiting for an answer.
  // (Before, any touch on the card stopped the timer for good, and the card could stay up forever.)
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);
  useEffect(() => {
    if (editing || question || err) return;
    const t = setTimeout(() => doneRef.current(), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [editing, question, err]);

  async function patch(body: Record<string, unknown>) {
    try {
      const r = await api<{ item: Item }>(`/api/items/${item.id}`, { method: "PATCH", body });
      setItem(r.item);
      setEditing(null);
      if ("for_person_name" in body || "requested_by_name" in body) peopleChanged();
      onChanged();
    } catch (e) {
      setErr(errText(e));
    }
  }

  async function answerQuestion(e: React.FormEvent) {
    e.preventDefault();
    if (!question || !answer.trim()) return;
    try {
      await api("/api/facts", { body: { subject_type: question.subject_type, subject_id: question.subject_id, key: question.key, value: answer.trim(), source: "asked" } });
      onDone();
    } catch (e) {
      setErr(errText(e));
    }
  }

  const chip = (f: Field, label: string | null, placeholder: string) => (
    <button
      type="button"
      className={label ? "chip" : "chip empty"}
      onClick={() => {
        setTouched(true);
        setEditing(editing === f ? null : f);
      }}
    >
      {label ?? placeholder}
    </button>
  );

  return (
    <div className="card confirm gold">
      <p className="small muted">
        <Icon name="check" size={14} className="tone-ok" /> Saved
      </p>
      <div className="chips">
        {chip("title", item.title, "title")}
        {chip("for", item.for_person ? `for ${item.for_person.name}` : null, "+ for")}
        {chip("by", item.requested_by ? `asked by ${item.requested_by.name}` : null, "+ asked by")}
        {chip("when", when(item), "+ when")}
        {chip("place", item.place_hint, "+ place")}
        {item.subtype && <span className="pill">{item.subtype.replace(/_/g, " ")}</span>}
        {item.recurrence_text && (
          <span className="pill">
            <Icon name="repeat" size={12} /> {item.recurrence_text}
          </span>
        )}
      </div>
      {item.status_line && <p className={`small tone-${item.status_line.tone}`}>{item.status_line.text}</p>}
      {item.confidence != null && item.confidence < 0.6 && <p className="muted small">Not sure I got this right. Tap anything to fix it.</p>}

      {editing === "title" && <TextEdit value={item.title} onSave={(v) => patch({ title: v })} />}
      {editing === "place" && <TextEdit value={item.place_hint ?? ""} onSave={(v) => patch({ place_hint: v || null })} />}
      {editing === "for" && <PersonPick people={people} value={item.for_person?.name ?? null} onSave={(name) => patch({ for_person_name: name ?? "" })} />}
      {editing === "by" && <PersonPick people={people} value={item.requested_by?.name ?? null} onSave={(name) => patch({ requested_by_name: name ?? "" })} />}
      {editing === "when" && <WhenEdit item={item} onSave={(b) => patch(b)} />}

      {question && (
        <form className="question" onSubmit={answerQuestion}>
          <label className="field">
            {question.question}
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </label>
          <div className="row">
            <button className="btn primary">Save</button>
            <button type="button" className="btn ghost" onClick={onDone}>
              Skip
            </button>
          </div>
        </form>
      )}
      {err && <p className="error">{err}</p>}
      {!question && touched && (
        <button className="btn ghost" onClick={onDone}>
          Done
        </button>
      )}
    </div>
  );
}

function TextEdit({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <form
      className="row edit"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(v.trim());
      }}
    >
      <input value={v} onChange={(e) => setV(e.target.value)} autoFocus maxLength={200} />
      <button className="btn primary">Save</button>
    </form>
  );
}

export function PersonPick({ people, value, onSave }: { people: Person[]; value: string | null; onSave: (name: string | null) => void }) {
  const [v, setV] = useState(value ?? "");
  return (
    <form
      className="edit"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(v.trim() || null);
      }}
    >
      <PersonInput people={people} value={v} onChange={setV} autoFocus />
      <div className="row">
        <button className="btn primary">Save</button>
        {value && (
          <button type="button" className="btn ghost" onClick={() => onSave(null)}>
            Clear
          </button>
        )}
      </div>
    </form>
  );
}

export function WhenEdit({ item, onSave }: { item: Item; onSave: (b: Record<string, unknown>) => void }) {
  const start = item.window_start ? localDate(item.window_start) : "";
  const end = item.window_end ? localDate(new Date(new Date(item.window_end).getTime() - 1).toISOString()) : start;
  const [s, setS] = useState(start);
  const [e, setE] = useState(end);
  const [t, setT] = useState("");
  return (
    <form
      className="edit when"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!s) return onSave({ start_date: null });
        if (t) {
          // Build the instant in the browser's zone; the server stores UTC.
          const d = new Date(`${s}T${t}:00`);
          return onSave({ due_at: d.toISOString() });
        }
        onSave({ start_date: s, end_date: e && e >= s ? e : s });
      }}
    >
      <div className="row">
        <label className="field">
          From <input type="date" value={s} onChange={(x) => setS(x.target.value)} />
        </label>
        <label className="field">
          To <input type="date" value={e} onChange={(x) => setE(x.target.value)} />
        </label>
      </div>
      <label className="field">
        At (optional) <input type="time" value={t} onChange={(x) => setT(x.target.value)} />
      </label>
      <div className="row">
        <button className="btn primary">Save</button>
        <button type="button" className="btn ghost" onClick={() => onSave({ start_date: null })}>
          No date
        </button>
      </div>
    </form>
  );
}
