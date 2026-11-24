// Generates the values Muninn needs. Prints them; writes nothing to disk.
// Usage: node scripts/gen-secrets.mjs
// Then: npx wrangler secret put DATA_KEY  (paste), same for VAPID_PRIVATE_KEY and SETUP_CODE,
// and put VAPID_PUBLIC_KEY in wrangler.jsonc "vars" (it is public).
import { webcrypto as crypto, randomBytes } from "node:crypto";

const b64url = (b) => Buffer.from(b).toString("base64url");
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
// Setup code: 5 groups of 5 from an unambiguous alphabet (~115 bits).
const alpha = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const code = Array.from(randomBytes(25), (b) => alpha[b % 32]).join("").match(/.{5}/g).join("-");

console.log(`DATA_KEY=${b64url(randomBytes(32))}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log(`VAPID_PUBLIC_KEY=${b64url(pub)}   # public: goes in wrangler.jsonc vars`);
console.log(`SETUP_CODE=${code}`);
console.log("\nKeep DATA_KEY somewhere safe (a password manager). Without it, the encrypted data and backups cannot be read.");
