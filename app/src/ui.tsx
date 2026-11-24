// Small shared UI pieces: sheets, section headers, empty states, haptics.
import { useEffect, type ReactNode } from "react";
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
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="grabber" />
        {title && <h3>{title}</h3>}
        {children}
      </div>
    </>
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
