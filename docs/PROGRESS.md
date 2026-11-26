# Progress and decisions

## 2026-11-26: holidays, daily summary, calendar view

- **Holidays are computed, not fetched** (`worker/core/holidays.ts`): the 11 US federal holidays with the 5 U.S.C. 6103 observed-day rule (Saturday to Friday, Sunday to Monday, so New Year's Day on a Saturday is observed on 31 December), plus notable days (Easter by the Meeus/Jones/Butcher algorithm, Mother's/Father's Day, Halloween, Election Day in even years, Black Friday, Tax Day moved off weekends and Emancipation Day). Clock changes are found by comparing the zone's UTC offset day to day, so they are right for any zone. Setting `holidays`: `all` (default), `federal`, `off`. No network, no list to update each year.
- **The daily summary headline is code, not AI** ("Today is Thursday, November 26. Happy Thanksgiving!"). `GET /api/brief` gains `day`: headline, today's holidays/dates/events, and holidays and important dates in the next 7 days. The AI line is unchanged and its cache key too. The morning brief push uses the holiday greeting as its title.
- **`GET /api/calendar?from&to`** (inclusive, at most 62 days) returns holidays, important dates (birthdays repeat yearly, never before the birth year), dated items (open and done) and, later, linked calendar events. An item with a multi-day window is shown once, on its last day, as "by", not on every day of the range.
- **The Upcoming tab is now Calendar**, with Month and Upcoming (the old list) views; the choice is remembered on the device.

## 2026-11-24: life features, proactive tips, iPhone UI

All 12 roadmap features plus proactive and pattern-based advice. Migration `0002_life.sql` is additive (new columns, indexes, a `tips` table).

- **Code computes, the model only reads language.** Dates, recurrence, money, triggers, streaks, clustering and tip selection are pure functions in `worker/core/` with unit tests. The parser only fills `subtype`, `attrs`, `thing` and `recurrence`; `coerceAttrs` validates every value (http(s) URLs only, phone numbers sanitised, money parsed to minor units).
- **Triggers are the single reminder engine.** Birthdays (-14 days and on the day), anniversaries, document expiries, warranty end, cert expiry (90/30 days), service due, booster due (tetanus +10 years), debt nudges. A conditional `UPDATE` claims each firing so two cron runs cannot fire it twice; missed firings catch up once, and "before" reminders whose date has passed are skipped. `require_open` closes a trigger when its source item is done (a settled debt stops nagging). A newer service record replaces the older one's "service due".
- **Recurring items roll forward on done** (RRULE subset: yearly, monthly, weekly with BYDAY, BYMONTHDAY incl. -1, UNTIL). The 31st clamps to month end, 29 Feb to 28 Feb.
- **Tips are rules, not model output.** 11 rules (upcoming date with gift ideas, stale kid sizes, warranty ending, ageing debt, errand batching, overdue pile, follow-ups, study streak and CPE pace, weather-driven seasonal work, snooze habit). Each tip carries `because` lines built by code from your own data. Feedback uses a Beta prior (acted+2)/(acted+dismissed+3); a rule dismissed 3 times and never acted on is muted. At most 3 tips, shown in Today and the brief, never as extra pushes.
- **Optional AI wording for tips** (`tips_ai`, off by default). The reworded text is accepted only if it keeps every number and name, adds no link and stays under 320 characters; otherwise the code text is used.
- **Weather is opt-in** (Open-Meteo, no key). Only your home coordinates rounded to 2 decimals (about 1 km) leave the Worker, once a day. `Permissions-Policy` now allows `geolocation=(self)` for the "Use my location" button.
- **Ideas digest** clusters ideas by cosine similarity (leader clustering, threshold 0.78) with no model call; pushed Sunday 18:00 within the daily cap and quiet hours.
- **`PATCH /api/life/items/:id` replaces `attrs` whole**, it does not merge. The UI always sends the full form.
- **Tips, triggers and attrs are encrypted** with AES-GCM and AAD `table:id:column`, like the rest. Export is version 2 and includes triggers and tips.
- **iPhone 15 Pro Max UI.** Dark-first design, safe areas (`viewport-fit=cover`), floating glass tab bar and a composer docked above it in thumb reach, bottom sheets instead of dialogs, haptics where supported, custom icon set. New raven-on-moon app icon rendered to every apple-touch size plus startup images (`scripts/render-icons.mjs`).
- **One PR instead of several.** This build could only push to one branch, so the work is one PR in ordered commits (engine, wiring, advice, UI).
- **Tests:** 176, including integration tests running the real migrations on `node:sqlite` (`test/d1-shim.ts`).

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
- Weekly review: v1.1. (Observed patterns and trigger evaluation shipped 2026-11-24.)
