// Pure username and password rules. Shared by the Worker (enforces) and the app (shows hints).

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;

/** Lowercase, 3-64 chars of a-z 0-9 . _ - @ + (an email also works). */
export function normalizeUsername(u: string): string | null {
  const n = u.normalize("NFKC").trim().toLowerCase();
  return /^[a-z0-9._@+-]{3,64}$/.test(n) ? n : null;
}

// Small built-in blocklist: the most common passwords and base words, checked after stripping digits and symbols,
// so "Password1!" and "Azerty123$" are refused even though they pass the character rules.
const COMMON_BASES = [
  "password", "passw0rd", "motdepasse", "qwerty", "azerty", "qwertz", "abc", "abcd", "letmein", "welcome", "bienvenue",
  "iloveyou", "jetaime", "admin", "administrator", "root", "user", "login", "monkey", "dragon", "football", "soleil",
  "sunshine", "princess", "master", "shadow", "superman", "batman", "starwars", "secret", "changeme", "summer",
  "winter", "autumn", "spring", "hello", "bonjour", "muninn", "test", "guest", "default", "trustno",
];

export const PASSWORD_RULES = `At least ${MIN_PASSWORD} characters, with an uppercase letter, a lowercase letter, a number and a symbol.`;

/** Why a password is refused, or null if it is acceptable. */
export function passwordProblem(username: string, password: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return "That password is too long.";
  if (!/[A-Z]/.test(password)) return "Add an uppercase letter.";
  if (!/[a-z]/.test(password)) return "Add a lowercase letter.";
  if (!/[0-9]/.test(password)) return "Add a number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Add a symbol, like ! ? # or -.";
  const low = password.toLowerCase();
  if (username && username.length >= 3 && low.includes(username.toLowerCase())) return "Don't put your username in the password.";
  const base = low.replace(/[^a-z]/g, "");
  if (COMMON_BASES.includes(base) || /^(.)\1+$/.test(base)) return "That password is too common.";
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|azer)/.test(low)) return "Avoid simple sequences like 1234 or qwer.";
  return null;
}

/** Rough strength for the hint under the field: 0 refused, 1 fair, 2 good, 3 strong. Not a security boundary. */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 {
  if (password.length < MIN_PASSWORD) return 0;
  if (password.length >= 16) return 3;
  if (password.length >= 12) return 2;
  return 1;
}
