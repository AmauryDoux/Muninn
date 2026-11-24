// Pure money handling. Amounts are integer minor units (cents) so sums never drift.

export interface Money {
  minor: number;
  cur: string; // ISO 4217
}

const SYMBOLS: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "CHF": "CHF", "C$": "CAD", "A$": "AUD" };
const ZERO_DECIMAL = new Set(["JPY", "KRW"]);
const MAX_MINOR = 100_000_000_00; // 100 million in major units

export function isCurrency(s: string): boolean {
  return /^[A-Z]{3}$/.test(s);
}

/**
 * Parse "$40", "40 USD", "€12,50", "1,234.56", "1.234,56 EUR", "12" (default currency).
 * Rules for separators: when both "," and "." appear, the last one is the decimal mark; a lone "," or "."
 * followed by exactly 1-2 digits is a decimal mark, otherwise a thousands separator.
 */
export function parseMoney(input: string | number, defaultCur = "USD"): Money | null {
  let cur = defaultCur.toUpperCase();
  let s: string;
  if (typeof input === "number") s = String(input);
  else s = input.trim();
  if (!s || s.length > 40) return null;
  for (const [sym, code] of Object.entries(SYMBOLS).sort((a, b) => b[0].length - a[0].length)) {
    if (s.includes(sym)) {
      cur = code;
      s = s.replace(sym, "");
      break;
    }
  }
  const code = /\b([A-Za-z]{3})\b/.exec(s);
  if (code) {
    cur = code[1].toUpperCase();
    s = s.replace(code[0], "");
  }
  s = s.replace(/\s/g, "");
  if (!/^\d[\d.,]*$/.test(s) || !isCurrency(cur)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let intPart = s;
  let frac = "";
  const dec = Math.max(lastComma, lastDot);
  if (lastComma >= 0 && lastDot >= 0) {
    intPart = s.slice(0, dec);
    frac = s.slice(dec + 1);
  } else if (dec >= 0) {
    const after = s.slice(dec + 1);
    const sepCount = s.split(s[dec]).length - 1;
    if (sepCount === 1 && after.length >= 1 && after.length <= 2) {
      intPart = s.slice(0, dec);
      frac = after;
    }
  }
  intPart = intPart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(frac)) return null;
  const digits = ZERO_DECIMAL.has(cur) ? 0 : 2;
  if (frac.length > digits) return null;
  const minor = Number(intPart) * 10 ** digits + Number((frac + "00").slice(0, digits) || 0);
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR) return null;
  return { minor, cur };
}

export function formatMoney(m: Money): string {
  const digits = ZERO_DECIMAL.has(m.cur) ? 0 : 2;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: m.cur, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(
      m.minor / 10 ** digits,
    );
  } catch {
    return `${(m.minor / 10 ** digits).toFixed(digits)} ${m.cur}`;
  }
}

export interface DebtLike {
  person_id: string | null;
  direction: "they_owe_me" | "i_owe_them";
  amount: Money;
  open: boolean;
}

/** Net balance per person and currency. Positive = they owe you. Settled (closed) debts are ignored. */
export function balances(debts: DebtLike[]): { person_id: string | null; cur: string; minor: number; count: number }[] {
  const m = new Map<string, { person_id: string | null; cur: string; minor: number; count: number }>();
  for (const d of debts) {
    if (!d.open) continue;
    const k = `${d.person_id ?? ""}|${d.amount.cur}`;
    const e = m.get(k) ?? { person_id: d.person_id, cur: d.amount.cur, minor: 0, count: 0 };
    e.minor += d.direction === "they_owe_me" ? d.amount.minor : -d.amount.minor;
    e.count++;
    m.set(k, e);
  }
  return [...m.values()].filter((b) => b.minor !== 0).sort((a, b) => Math.abs(b.minor) - Math.abs(a.minor));
}
