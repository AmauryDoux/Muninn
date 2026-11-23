export interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  VECTORIZE?: VectorizeIndex;
  BACKUPS?: R2Bucket;

  // vars
  PARSE_MODEL: string;
  EMBED_MODEL: string;
  WHISPER_MODEL: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT: string;

  // secrets (wrangler secret put)
  ANTHROPIC_API_KEY: string;
  DATA_KEY: string;          // base64url, 32 bytes
  VAPID_PRIVATE_KEY: string; // base64url, 32-byte P-256 scalar
  SETUP_CODE: string;        // one-time code for first sign-in
}
