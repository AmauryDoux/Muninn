# Muninn

A private, single-user assistant. Tell it things ("wife told me to buy new sheets for daughter next week"), ask it things ("what did my wife ask me to do 2 weeks ago?", "what should I get Emma for her birthday?"), and it reminds you at the right time.

One Cloudflare Worker serves the PWA, the API (`/api/*`) and a 5-minute cron. Data lives in D1, encrypted per field. Claude (Haiku 5.5) reads notes; Sonnet 5.5 gives advice; Workers AI does embeddings and voice.

- Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Decisions log: [docs/PROGRESS.md](docs/PROGRESS.md)
- What comes next: [ROADMAP.md](ROADMAP.md)

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars        # then fill it: npm run gen:secrets prints values
npm run db:migrate:local
npm run dev:worker                    # builds the PWA and runs the Worker on :8787
npm test && npm run typecheck && npm run lint
```

The `AI` binding (embeddings, Whisper) only runs against Cloudflare, so `wrangler dev` needs you to be logged in (`npx wrangler login`). Without it, captures still save; search and voice are skipped.

## Deploy (first time)

You need a Cloudflare account (free plan) and an Anthropic API key. Everything below runs on your machine; nothing secret goes in the repo.

1. **Log in and create the database**
   ```bash
   npx wrangler login
   npx wrangler d1 create muninn
   ```
   Put the printed `database_id` in `wrangler.jsonc` (it is an id, not a secret).
2. **Generate secrets**
   ```bash
   npm run gen:secrets
   ```
   Save `DATA_KEY` in your password manager: without it the data and backups cannot be decrypted.
   Put `VAPID_PUBLIC_KEY` in `wrangler.jsonc` under `vars`, and set `VAPID_SUBJECT` to a `mailto:` you are fine sharing with Apple and Google.
3. **Store secrets in the Worker** (each command prompts for the value)
   ```bash
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put DATA_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   npx wrangler secret put SETUP_CODE
   ```
4. **Create tables and deploy**
   ```bash
   npm run db:migrate:remote
   npm run deploy
   ```
5. **Set up on your phone.** Open the `*.workers.dev` URL in Safari, Share → Add to Home Screen, open Muninn from the Home Screen, enter the setup code, pick a username and password (8+ characters with upper, lower, number and symbol), add a passkey, then Settings → Turn on reminders. The setup route closes for good after the first success.

Recommended hardening:
- Anthropic Console: a dedicated workspace for Muninn with a monthly spend limit (for example $10).
- Cloudflare: hardware-key 2FA on the account; a custom domain if you want one (passkeys are bound to the hostname, so pick it before registering passkeys).
- GitHub: secret scanning and push protection on.

## Update an existing install
```bash
git pull
npm ci
npm run db:migrate:remote   # only when migrations/ changed
npm run deploy
```

### Optional
- **Weather-aware seasonal tips**: Settings → Life → Use my location (rounded to about 1 km, sent to Open-Meteo once a day).
- **Vectorize** (free tier covers a personal install): `npx wrangler vectorize create muninn-captures-v1 --dimensions=768 --metric=cosine`, then uncomment the binding in `wrangler.jsonc`. The cron copies existing vectors into it, 100 every 5 minutes. Without it, search scans up to 3,000 vectors in D1, which gets close to the free plan's CPU limit as notes grow.
- **Weekly backup and photos (R2)**: `npx wrangler r2 bucket create muninn-backups`, then uncomment the `r2_buckets` binding. The same bucket holds the Sunday backup (`backup-*.json.enc`) and receipt photos (`files/`), all sealed with `DATA_KEY`.
- **Deploy from GitHub Actions** (merge = deploy, handy from the phone): secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit and D1:Edit on this account) and `CLOUDFLARE_ACCOUNT_ID`; variables `DEPLOY_ENABLED=true`, `D1_DATABASE_ID`, `VAPID_PUBLIC_KEY`, optionally `VAPID_SUBJECT`, `ENABLE_VECTORIZE=true`, `ENABLE_BACKUPS=true`. The job fills `wrangler.jsonc` from those (it refuses to deploy without the push key), applies migrations, then deploys.

## Keep `DATA_KEY` safe
Every note, name and backup is encrypted with it. Keep a copy in your password manager. Without it, nothing can be restored.

## Restore a backup
Into a fresh database for an exact copy (`npx wrangler d1 create muninn`, put the new id in `wrangler.jsonc`, `npm run db:migrate:remote`), or over the current one (rows in the backup replace the same rows; nothing else is deleted). D1 Time Travel also restores the last days without any of this.
```bash
npx wrangler r2 object get muninn-backups/backup-2026-11-29.json.enc --remote --file backup.enc
DATA_KEY=... node scripts/restore.mjs backup.enc backup-2026-11-29.json.enc > restore.sql
npx wrangler d1 execute muninn --remote --file restore.sql
rm backup.enc restore.sql   # restore.sql holds encrypted rows and your password verifier
```
Search vectors and push devices are not in the backup: the cron re-embeds notes within the hour, and you turn reminders on again in Settings. Backups made before snapshots existed are decrypted exports: `--json` prints them.

## Shortcuts, Calendar and arrival nudges
Settings → "Siri, Action button, Share and Calendar" makes narrow keys, each shown once and stored only as a hash:
- **Capture key**: an iOS Shortcut posts a note to `/api/shortcut/capture`. It can only add; questions are saved as notes, never answered.
- **Calendar link**: a `webcal://` subscription of dated items (titles and dates only). The link is the key: treat it like a password.
- **Arrival key**: a "When I arrive" automation posts the kind of place to `/api/shortcut/arrive`; your devices get a push naming what's there, the caller only a count.
Revoke any key in the same place.

## Sign-in hardening
- Settings → Sign-in lists signed-in devices with their own sign-out, and every new sign-in pushes a notice to your devices.
- With a passkey added, turn off "Allow password sign-in": the fast password verifier then stops being an attack path. If you lose every passkey: `npx wrangler d1 execute muninn --remote --command "DELETE FROM settings WHERE key = 'password_login'"`.
- Optional extra layer: Cloudflare Access (Zero Trust, free for one user) in front of the hostname, with a bypass rule for `/api/shortcut/*` and `/api/calendar/*` (they carry their own keys). Test it from the Home Screen app before relying on it: Access sessions in an installed iOS web app can expire and need a sign-in in Safari. [Not yet tested here.]
- Set a monthly spend limit in the Anthropic console too; Settings → Health has Muninn's own AI budget.

## Costs

Every AI call is logged with feature, model, tokens and estimated cost. Settings → AI usage shows the month's total per feature. Expected v1 cost: about $0.55/month at 20 notes and 10 questions a day, plus a few cents per advice question.
