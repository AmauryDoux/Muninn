# Architecture

The full design is the v1 spec. This page records how the code maps to it.

```
phone (PWA, service worker) ──HTTPS, same origin, HttpOnly cookie──▶ Cloudflare Worker
                                                                     ├─ static assets (dist/client)
                                                                     ├─ /api/*  (worker/index.ts)
                                                                     └─ cron */5 (worker/scheduled.ts)
Worker ──▶ D1 (encrypted columns) · Workers AI (embeddings, Whisper) · Anthropic API · Apple/Google push relays
```

## Code layout
| Path | What |
|---|---|
| `worker/core/` | Pure logic, no I/O, unit-tested: dates and time references, reminders and push planning, people matching, recall SQL builder, item grouping, cost estimates, model output schemas |
| `worker/lib/` | Crypto (AES-GCM per field, HMAC), web push (VAPID + RFC 8291), HTTP helpers, settings, ULIDs, usage logging |
| `worker/auth.ts` | Setup code, passphrase, passkeys (SimpleWebAuthn), sessions, rate limits, fresh-check for sensitive screens |
| `worker/ai.ts`, `worker/brief.ts` | Every model call |
| `worker/routes/` | Capture/recall/advice, items, profile (people, facts, patterns), push, settings, usage, export |
| `worker/scheduled.ts` | Reminders, morning brief, housekeeping, weekly backup |
| `app/src/` | React 19 PWA |
| `migrations/` | D1 schema |

## Rules the code follows
- **Code computes, the model reads language.** The parser returns a time *reference* ("relative week +1"); `worker/core/time.ts` turns it into dates. Recall gets a filter object; `worker/core/recall.ts` builds parameterised SQL. The model never writes SQL and has no tools.
- **Model output is data.** Every response is validated against a Zod schema (structured outputs); unknown ids are dropped.
- **Encrypted at the application layer:** note text, titles, details, attributes, people's names and aliases, fact values, cached briefs. AES-256-GCM, random IV, `table:id:column` as associated data. Not encrypted: ids, times, status, kind, relation, fact keys, place hints, event metadata.
- **Push payloads carry no item text** ("Reminder: 2 items due").
- **Sensitive screens** (What I know, export, deletes, new passkeys, passphrase change) need a passkey or passphrase check within 5 minutes.

## API
All under `/api`, JSON, same-origin `Origin` required on writes.

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /auth/status` | none | Setup and sign-in state |
| `POST /auth/setup` | setup code | First run only |
| `POST /auth/login` | passphrase | Rate limited |
| `POST /auth/passkey/{login,reauth,register}/{options,verify}` | varies | WebAuthn |
| `POST /auth/reauth`, `/auth/passphrase`, `/auth/logout`, `/auth/logout-all` | session | |
| `POST /capture` | session | Tell or ask: returns a confirmed item or an answer |
| `POST /transcribe` | session | Audio to text (Whisper) |
| `GET /items?view=open|done|recent`, `GET|PATCH|DELETE /items/:id`, `POST /items/:id/act` | session (delete: fresh) | |
| `GET /brief` | session | Today, overdue, one-line summary |
| `GET|POST /people`, `PATCH|DELETE /people/:id` | session (delete: fresh) | |
| `POST /facts`, `PATCH|DELETE /facts/:id` | session (edit: fresh) | |
| `GET /know`, `PATCH /patterns/:id`, `GET /export` | fresh | |
| `POST /push/{subscribe,unsubscribe,test}`, `GET /devices`, `DELETE /devices/:id` | session | |
| `GET|PUT /settings`, `GET /usage?month=` | session | |
