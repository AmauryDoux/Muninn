// CI only, before migrations and deploy: compares the config about to be deployed with the Worker that is live now,
// and stops if the deploy would silently drop or repoint something. `wrangler deploy` replaces every binding and
// plain variable with what wrangler.jsonc says (secrets are kept), so a forgotten repository variable would, for
// example, unbind the R2 bucket (no more backups or receipt photos) or change the push key (every phone stops
// getting reminders), with a green deploy.
//
// Stops on: a live binding missing from the new config, a binding whose type or target (D1 id, bucket, index)
// changed, or a change to VAPID_PUBLIC_KEY / VAPID_SUBJECT. Lists, without stopping: new bindings and other changed
// variables (a model change in a PR is normal). Prints names only, never values.
//
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (Workers Scripts:Edit includes the read it needs).
// ALLOW_CONFIG_DRIFT=true (repository variable) turns the stops into warnings for a deliberate change.
import { readFileSync } from "node:fs";

/** Strips // and /* *\/ comments and trailing commas from JSONC, leaving string contents untouched. */
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas: a comma followed only by whitespace before } or ]. Would also hit a string value containing
  // `,}` or `,]`, which no value in this config has.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Bindings declared by a parsed wrangler config, as name → { type, target }. */
export function configBindings(cfg) {
  const b = new Map();
  for (const d of cfg.d1_databases ?? []) b.set(d.binding, { type: "d1", target: d.database_id });
  for (const r of cfg.r2_buckets ?? []) b.set(r.binding, { type: "r2_bucket", target: r.bucket_name });
  for (const v of cfg.vectorize ?? []) b.set(v.binding, { type: "vectorize", target: v.index_name });
  for (const k of cfg.kv_namespaces ?? []) b.set(k.binding, { type: "kv_namespace", target: k.id });
  if (cfg.ai?.binding) b.set(cfg.ai.binding, { type: "ai" });
  if (cfg.assets?.binding) b.set(cfg.assets.binding, { type: "assets" });
  for (const [name, value] of Object.entries(cfg.vars ?? {})) {
    b.set(name, typeof value === "string" ? { type: "plain_text", target: value } : { type: "json", target: JSON.stringify(value) });
  }
  return b;
}

/** Bindings of the live Worker from the Cloudflare API, as name → { type, target }. Secrets are left out. */
export function liveBindings(apiBindings) {
  const b = new Map();
  for (const x of apiBindings) {
    if (x.type === "secret_text" || x.type === "secret_key") continue;
    const target =
      x.type === "d1" ? (x.id ?? x.database_id)
      : x.type === "r2_bucket" ? x.bucket_name
      : x.type === "vectorize" ? x.index_name
      : x.type === "kv_namespace" ? x.namespace_id
      : x.type === "plain_text" ? x.text
      : x.type === "json" ? JSON.stringify(x.json)
      : undefined;
    b.set(x.name, { type: x.type, target });
  }
  return b;
}

// Variables whose change breaks something already in use, so a change has to be deliberate.
const PINNED_VARS = new Set(["VAPID_PUBLIC_KEY", "VAPID_SUBJECT"]);

/** Compares live and next bindings. Returns { stops, notes }, each a list of human-readable lines (names only). */
export function compareBindings(live, next) {
  const stops = [];
  const notes = [];
  for (const [name, l] of live) {
    const n = next.get(name);
    if (!n) {
      stops.push(`${name} (${l.type}) is live but missing from the new config, so the deploy would remove it`);
    } else if (l.type !== n.type) {
      stops.push(`${name} would change type from ${l.type} to ${n.type}`);
    } else if (l.target !== undefined && n.target !== undefined && l.target !== n.target) {
      if (l.type === "plain_text" || l.type === "json") {
        (PINNED_VARS.has(name) ? stops : notes).push(`variable ${name} changes value`);
      } else {
        stops.push(`${name} (${l.type}) would point somewhere else`);
      }
    }
  }
  for (const [name, n] of next) if (!live.has(name)) notes.push(`${name} (${n.type}) is new`);
  return { stops, notes };
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID repository secrets are needed.");
    process.exit(1);
  }
  const cfg = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8")));
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(cfg.name)}/settings`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) {
    console.log(`No live Worker named ${cfg.name} yet: first deploy, nothing to compare.`);
    return;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(body?.result?.bindings)) {
    const why = (body?.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
    console.error(`Could not read the live Worker's settings (${why}). Check the API token's permissions and the account id.`);
    process.exit(1);
  }
  const { stops, notes } = compareBindings(liveBindings(body.result.bindings), configBindings(cfg));
  for (const n of notes) console.log(`note: ${n}`);
  if (stops.length === 0) {
    console.log("The new config keeps every live binding and the push settings.");
    return;
  }
  const allow = process.env.ALLOW_CONFIG_DRIFT === "true";
  for (const s of stops) console.log(`${allow ? "::warning::" : "::error::"}${s}`);
  if (allow) {
    console.log("ALLOW_CONFIG_DRIFT=true: deploying anyway. Set it back to false afterwards.");
    return;
  }
  console.error(
    "Stopped before migrations and deploy. Usually a repository variable is missing (ENABLE_BACKUPS, ENABLE_VECTORIZE, " +
      "VAPID_SUBJECT) or has a different value from the live Worker. If the change is deliberate, set the repository " +
      "variable ALLOW_CONFIG_DRIFT=true for one run.",
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
