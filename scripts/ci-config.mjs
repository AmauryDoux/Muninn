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
  let out = text.replace('"database_id": "00000000-0000-0000-0000-000000000000"', `"database_id": "${need("D1_DATABASE_ID")}"`);
  out = out.replace('"VAPID_PUBLIC_KEY": ""', `"VAPID_PUBLIC_KEY": "${need("VAPID_PUBLIC_KEY")}"`);
  if (env.VAPID_SUBJECT) out = out.replace(/"VAPID_SUBJECT": "[^"]*"/, `"VAPID_SUBJECT": "${need("VAPID_SUBJECT")}"`);
  if (env.ENABLE_VECTORIZE === "true") out = out.replace('// "vectorize":', '"vectorize":');
  if (env.ENABLE_BACKUPS === "true") out = out.replace('// "r2_buckets":', '"r2_buckets":');
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync("wrangler.jsonc", fillConfig(readFileSync("wrangler.jsonc", "utf8"), process.env));
  console.log("wrangler.jsonc filled from repository variables");
}
