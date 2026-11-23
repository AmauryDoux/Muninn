# Progress and decisions

## 2026-11-23: v1 first build

- **Username + password instead of a passphrase** (asked by the user). Policy: 8+ characters with an uppercase letter, a lowercase letter, a number and a symbol, plus a built-in blocklist of common passwords and sequences (`worker/core/password.ts`). The verifier is HMAC over username + password. An install set up with the old passphrase is upgraded on first login: the user picks a username and signs in with the old passphrase as the password. Trade-off noted for the user: with a fast (non-PBKDF2) verifier, an 8-character password is guessable offline by someone holding both a D1 export and the Worker secret; online guessing is stopped by the rate limits. Passkeys stay the main login.

Built from the v1 spec (Claude Doc "Muninn v1 Spec"). Decisions made while building, newest first:

- **Advice uses Sonnet 5.5** (`ADVICE_MODEL`), parsing, recall and the brief use Haiku 5.5 (`PARSE_MODEL`). If Sonnet declines, the call retries once on Haiku. Health, finance and legal answers get a fixed disclaimer added by code.
- **AI usage log with cost.** Every model call writes a `model_usage` event with job, model, tokens and estimated USD (prices in `worker/core/costs.ts`). `GET /api/usage?month=YYYY-MM` and the Settings screen show per-feature totals.
- **Schema ready for later features** without table rebuilds: no CHECK on `items.kind`, plus `subtype`, encrypted `attrs`, `things`, `places`, `links`, `triggers`, and dated facts. See ROADMAP.md.
- **Password verifier is HMAC-SHA-256 with a key derived from `DATA_KEY`, not PBKDF2-600k.** The spec asked for PBKDF2 at 600,000 iterations. Workers' WebCrypto refuses PBKDF2 above 100,000 iterations, and the free plan allows about 10 ms of CPU per request, so a slow hash would fail. Compensating controls: the verifier is useless without the Worker secret (a D1 leak alone does not allow offline guessing), and login is limited to 5 attempts per IP and 20 in total per 15 minutes. Passkeys remain the main login.
- **Rate limiting in D1** instead of the rate-limiting binding: the binding only supports 10 or 60 second windows, the spec wants 15 minutes. A global cap was added so rotating IPs does not help.
- **Search falls back to D1.** Vectorize is optional. Vectors are always also stored in D1 (`capture_vectors`), so the index can be rebuilt or switched without re-embedding. Brute-force cosine scans at most the latest 3,000.
- **Three extra tables for auth** (`sessions`, `passkeys`, `auth_attempts`) beside the spec's eight, so auth state is easy to audit.
- **`captures.parse_json` became `parse_enc`.** The model output repeats the note text, so it is encrypted like the rest.
- **One input box for telling and asking.** The parser decides capture, recall or advice in one call.
- **Model failure never loses a capture.** If the parse call fails, the raw note is saved as a `note` with confidence 0, ready to fix.
- **Reminders are grouped.** All reminders due in one cron run go out as one push, and the morning brief absorbs reminders due at the same time, so the daily cap (3) is rarely hit.
- **Push endpoints are allow-listed** (Apple, Google, Mozilla, Microsoft push hosts) so a stored endpoint cannot make the Worker call arbitrary URLs.
- **Linter:** oxlint's React-compiler rules `purity` and `set-state-in-effect` are off: they flag `new Date()` in render and async setState in effects, which this app does on purpose.

### Open questions answered with defaults (change any of them)
| Question | Default in v1 | Where to change |
|---|---|---|
| Capture language | English only (`bge-base-en-v1.5`, `en-US` speech) | `EMBED_MODEL` in wrangler.jsonc + re-embed; `sr.lang` in `app/src/capture.tsx` |
| Vectorize free? | Not assumed; D1 fallback | Uncomment the binding |
| Who can capture | Only you | Later (ROADMAP) |
| Quiet hours | 22:00 to 07:00, max 3 pushes a day | Settings screen |
| Raw note retention | Kept indefinitely | Later: purge job |
| iOS target | 16.4+ (web push needs it, installed app only) | n/a |

### Not done yet in v1
- Restore from a backup is not built (export and the weekly encrypted R2 backup are). The spec wants restore tested before v1 is called done.
- Observed patterns, weekly review, triggers evaluation: v1.1.
