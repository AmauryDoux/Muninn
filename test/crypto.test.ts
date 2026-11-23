import { describe, expect, it } from "vitest";
import ece from "http_ece";
import { createECDH, randomBytes } from "node:crypto";
import { Cipher } from "../worker/lib/crypto";
import { fromB64url, toB64url } from "../worker/lib/b64";
import { encryptPayload, isAllowedPushEndpoint, vapidJwt } from "../worker/lib/webpush";
import { ulid } from "../worker/lib/ulid";

describe("Cipher", () => {
  const key = toB64url(randomBytes(32));
  it("round-trips and binds the row id", async () => {
    const c = await Cipher.fromSecret(key);
    const enc = await c.encrypt("buy sheets", "items:A:title");
    expect(await c.decrypt(enc, "items:A:title")).toBe("buy sheets");
    await expect(c.decrypt(enc, "items:B:title")).rejects.toThrow();
  });
  it("uses a fresh IV each time", async () => {
    const c = await Cipher.fromSecret(key);
    expect(await c.encrypt("x", "a")).not.toBe(await c.encrypt("x", "a"));
  });
  it("rejects a wrong-length key", async () => {
    await expect(Cipher.fromSecret(toB64url(randomBytes(16)))).rejects.toThrow();
  });
  it("mac verifies", async () => {
    const c = await Cipher.fromSecret(key);
    const m = await c.mac("hello");
    expect(await c.macVerify("hello", m)).toBe(true);
    expect(await c.macVerify("hellO", m)).toBe(false);
  });
});

describe("web push", () => {
  it("encrypts so a standard RFC 8291 decoder can read it", async () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = randomBytes(16);
    const sub = { endpoint: "https://web.push.apple.com/x", p256dh: toB64url(ua.getPublicKey()), auth: toB64url(auth) };
    const body = await encryptPayload(sub, new TextEncoder().encode('{"title":"hi"}'));
    const plain = ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: ua, authSecret: auth });
    expect(plain.toString()).toBe('{"title":"hi"}');
  });

  it("signs a verifiable ES256 VAPID token", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const jwt = await vapidJwt("https://web.push.apple.com", { publicKey: toB64url(pub), privateKey: jwk.d!, subject: "mailto:a@example.invalid" });
    const [h, c, s] = jwt.split(".");
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, fromB64url(s), new TextEncoder().encode(`${h}.${c}`));
    expect(ok).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(fromB64url(c))).aud).toBe("https://web.push.apple.com");
  });

  it("only allows known push services (no SSRF through stored endpoints)", () => {
    expect(isAllowedPushEndpoint("https://web.push.apple.com/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("http://web.push.apple.com/abc")).toBe(false);
    expect(isAllowedPushEndpoint("https://169.254.169.254/latest")).toBe(false);
    expect(isAllowedPushEndpoint("https://web.push.apple.com.evil.com/")).toBe(false);
    expect(isAllowedPushEndpoint("https://web.push.apple.com:8443/")).toBe(false);
  });
});

describe("ulid", () => {
  it("is 26 chars and sorts by time", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a).toMatch(/^[0-9A-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});
