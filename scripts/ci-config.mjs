// CI only: fills wrangler.jsonc with this deployment's public values from repository variables, so a merge to main
// deploys the same config you deploy from your computer. None of these values are secrets.
//   D1_DATABASE_ID     (required) the id printed by `wrangler d1 create muninn`
//   VAPID_PUBLIC_KEY   (required) the public push key; an empty one would switch push off
//   VAPID_SUBJECT      (optional) mailto: sent to push services
//   ENABLE_VECTORIZE   (optional) "true" once the muninn-captures-v1 index exists
//   ENABLE_BACKUPS     (optional) "true" once the muninn-backups R2 bucket exists
import { readFileSync, writeFileSync } from "node:fs";

export function fillConfig(text, env) {
  const need = (k) => {
    const v = (env[k] ?? "").trim();
    if (!v) throw new Error(`Repository variable ${k} is not set`);
    if (/["\\\n]/.test(v)) throw new Error(`${k} has characters that don't belong in it`);
    return v;
  };
  // Replace whatever value is there (placeholder or an id filled in by hand), and fail loudly if a key is missing,
  // rather than deploying a config that silently kept the placeholder.
  const set = (s, key, value) => {
    const re = new RegExp(`"${key}": "[^"]*"`);
    if (!re.test(s)) throw new Error(`wrangler.jsonc has no "${key}" to fill`);
    return s.replace(re, `"${key}": "${value}"`);
  };
  let out = set(text, "database_id", need("D1_DATABASE_ID"));
  out = set(out, "VAPID_PUBLIC_KEY", need("VAPID_PUBLIC_KEY"));
  if (env.VAPID_SUBJECT) out = set(out, "VAPID_SUBJECT", need("VAPID_SUBJECT"));
  // Uncomment the optional bindings; already-uncommented ones are left as they are.
  if (env.ENABLE_VECTORIZE === "true") out = out.replace(/\/\/\s*"vectorize":/, '"vectorize":');
  if (env.ENABLE_BACKUPS === "true") out = out.replace(/\/\/\s*"r2_buckets":/, '"r2_buckets":');
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync("wrangler.jsonc", fillConfig(readFileSync("wrangler.jsonc", "utf8"), process.env));
  console.log("wrangler.jsonc filled from repository variables");
}
