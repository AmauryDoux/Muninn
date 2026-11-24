import { concat, fromB64url, toB64url, utf8 } from "./b64";

/**
 * Application-layer encryption for "_enc" columns.
 * AES-256-GCM, random 96-bit IV per value, the row id (plus column) as associated data,
 * so a ciphertext copied to another row or column fails to decrypt.
 */
export class Cipher {
  private constructor(
    private readonly aes: CryptoKey,
    private readonly hmac: CryptoKey,
  ) {}

  static async fromSecret(dataKeyB64url: string): Promise<Cipher> {
    if (!dataKeyB64url) throw new Error("DATA_KEY is not set");
    const raw = fromB64url(dataKeyB64url);
    if (raw.length !== 32) throw new Error("DATA_KEY must be 32 bytes (base64url)");
    // Derive separate keys for encryption and keyed hashing from the one secret.
    const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
    const derive = (info: string, alg: Parameters<SubtleCrypto["deriveKey"]>[2], usages: string[]) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8(info) },
        base,
        alg,
        false,
        usages,
      );
    const aes = await derive("muninn/aes-gcm/v1", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
    const hmac = await derive("muninn/hmac/v1", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign", "verify"]);
    return new Cipher(aes, hmac);
  }

  async encrypt(plain: string, aad: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, this.aes, utf8(plain));
    return `${toB64url(iv)}.${toB64url(ct)}`;
  }

  async decrypt(enc: string, aad: string): Promise<string> {
    const [ivS, ctS] = enc.split(".");
    if (!ivS || !ctS) throw new Error("bad ciphertext");
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64url(ivS), additionalData: utf8(aad) },
      this.aes,
      fromB64url(ctS),
    );
    return new TextDecoder().decode(pt);
  }

  async encryptNullable(plain: string | null | undefined, aad: string): Promise<string | null> {
    return plain == null ? null : this.encrypt(plain, aad);
  }

  async decryptNullable(enc: string | null | undefined, aad: string): Promise<string | null> {
    return enc == null ? null : this.decrypt(enc, aad);
  }

  /** Keyed hash (HMAC-SHA-256), used for the password verifier and IP hashing. */
  async mac(data: string): Promise<string> {
    return toB64url(await crypto.subtle.sign("HMAC", this.hmac, utf8(data)));
  }

  async macVerify(data: string, macB64url: string): Promise<boolean> {
    // crypto.subtle.verify compares in constant time.
    return crypto.subtle.verify("HMAC", this.hmac, fromB64url(macB64url), utf8(data));
  }

  /** Encrypt a whole blob (backups). */
  async sealBytes(bytes: Uint8Array, aad: string): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, this.aes, bytes as Uint8Array<ArrayBuffer>),
    );
    return concat(iv, ct);
  }

  /** Decrypt a blob sealed with sealBytes. */
  async openBytes(sealed: Uint8Array, aad: string): Promise<Uint8Array> {
    if (sealed.length < 12 + 16) throw new Error("bad sealed blob");
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.slice(0, 12), additionalData: utf8(aad) },
      this.aes,
      sealed.slice(12) as Uint8Array<ArrayBuffer>,
    );
    return new Uint8Array(pt);
  }
}

export async function sha256b64url(s: string): Promise<string> {
  return toB64url(await crypto.subtle.digest("SHA-256", utf8(s)));
}

export function randomToken(bytes = 32): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** aad helper so call sites can't mix up the order. */
export const aad = (table: string, id: string, column: string) => `${table}:${id}:${column}`;
