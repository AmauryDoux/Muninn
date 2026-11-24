// Web Push without dependencies: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291 / RFC 8188).
import { concat, fromB64url, toB64url, utf8 } from "./b64";

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string; // base64url, 65-byte uncompressed P-256 point
  auth: string; // base64url, 16 bytes
}

export interface VapidKeys {
  publicKey: string; // base64url, 65-byte uncompressed point
  privateKey: string; // base64url, 32-byte scalar
  subject: string; // mailto: or https:
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, len: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

/** Encrypt `plaintext` for one subscription. Returns the full aes128gcm body. */
export async function encryptPayload(
  sub: PushSubscriptionKeys,
  plaintext: Uint8Array<ArrayBufferLike>,
  // Injectable for tests only.
  opts: { salt?: Uint8Array<ArrayBuffer>; serverKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("bad subscription keys");

  const serverKeys =
    opts.serverKeys ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", serverKeys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as Parameters<SubtleCrypto["deriveBits"]>[0], serverKeys.privateKey, 256),
  );

  const keyInfo = concat(utf8("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const rs = 4096;
  if (plaintext.length + 1 + 16 > rs) throw new Error("payload too large for one record");
  const padded = concat(plaintext, new Uint8Array([2])); // 0x02 = last record, no padding
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

/** ES256 JWT for the push service at `audience` (scheme + host of the endpoint). */
export async function vapidJwt(audience: string, keys: VapidKeys, now = Date.now()): Promise<string> {
  const pub = fromB64url(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 point");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: keys.privateKey,
    x: toB64url(pub.slice(1, 33)),
    y: toB64url(pub.slice(33, 65)),
    ext: false,
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = toB64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toB64url(
    utf8(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: keys.subject })),
  );
  const input = `${header}.${claims}`;
  // WebCrypto returns r||s (P1363), which is exactly the JWS ES256 signature format.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(input));
  return `${input}.${toB64url(sig)}`;
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** 404/410: the subscription is gone and should be deleted. */
  gone: boolean;
}

/** Hosts we accept as push services. Stops a stored endpoint from turning the Worker into an SSRF proxy. */
const PUSH_HOSTS = [
  /^web\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
  /^[a-z0-9.-]+\.push\.services\.mozilla\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export async function sendPush(sub: PushSubscriptionKeys, payload: object, keys: VapidKeys): Promise<PushResult> {
  if (!isAllowedPushEndpoint(sub.endpoint)) return { ok: false, status: 0, gone: true };
  const body = await encryptPayload(sub, utf8(JSON.stringify(payload)));
  const url = new URL(sub.endpoint);
  const jwt = await vapidJwt(`${url.protocol}//${url.host}`, keys);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
