// Small shared UI pieces: sheets, section headers, empty states, haptics.
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Person } from "./api";
import { Icon } from "./icons";

/** A light tap where supported (Android). iOS web apps have no vibration API; the press animation stands in. */
export function haptic() {
  try {
    navigator.vibrate?.(8);
  } catch {
    /* not supported */
  }
}

export function Sheet({ title, onClose, children }: { title?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    return () => {
      removeEventListener("keydown", k);
      document.body.style.overflow = "";
    };
  }, [onClose]);
  // Rendered into <body>: inside a list card, a transformed, overflow-hidden ancestor trapped the "fixed" sheet in the
  // card, clipped it, and left its backdrop blocking every tap on the screen.
  return createPortal(
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="grabber" />
        {title && <h3>{title}</h3>}
        {children}
      </div>
    </>,
    document.body,
  );
}

export function SectionH({ children, count, action }: { children: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <div className="section-h">
      <span>
        {children} {count != null && <span className="count">{count}</span>}
      </span>
      {action}
    </div>
  );
}

export function Empty({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={36} />
      <div>{children}</div>
    </div>
  );
}

export function Back({ onClick, label = "Back" }: { onClick: () => void; label?: string }) {
  return (
    <button className="back" onClick={onClick}>
      <Icon name="chevronLeft" size={22} />
      {label}
    </button>
  );
}

export function Disclaimer({ text }: { text: string }) {
  return (
    <p className="disclaimer">
      <Icon name="info" size={16} />
      <span>{text}</span>
    </p>
  );
}

export const DOMAIN_NOTE: Record<string, string> = {
  health: "General information, not medical advice. Check with a doctor or pharmacist.",
  finance: "General information, not financial advice.",
  legal: "General information, not legal advice.",
};

/** Tell the app a person may have been created, so every screen reloads the people list. */
export function peopleChanged() {
  window.dispatchEvent(new Event("muninn:people"));
}

const norm = (s: string) => s.toLowerCase().normalize("NFKC").trim();

/**
 * Type a name: existing people are suggested as you type (name, nickname or relation),
 * and a name that matches nobody is created when the form is saved.
 */
export function PersonInput({ people, value, onChange, placeholder = "Type a name", autoFocus }: { people: Person[]; value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const [focused, setFocused] = useState(false);
  const q = norm(value);
  const others = people.filter((p) => p.relation !== "self");
  const exact = others.find((p) => norm(p.name) === q);
  const hits = others
    .filter((p) => !q || norm(p.name).includes(q) || p.aliases.some((a) => norm(a).includes(q)) || norm(p.relation).startsWith(q))
    .slice(0, 6);
  return (
    <div className="person-input">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="words"
        enterKeyHint="done"
        maxLength={80}
      />
      {focused && hits.length > 0 && !exact && (
        <div className="chips suggest" role="listbox">
          {hits.map((p) => (
            <button type="button" role="option" aria-selected={false} key={p.id} className="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange(p.name)}>
              {p.name}
              {p.relation !== "other" && <span className="muted"> · {p.relation}</span>}
            </button>
          ))}
        </div>
      )}
      {q && !exact && !(focused && hits.length) && !["me", "myself", "i"].includes(q) && (
        <p className="muted small">New person: “{value.trim()}” will be added.</p>
      )}
    </div>
  );
}
