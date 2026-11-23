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
5. **Set up on your phone.** Open the `*.workers.dev` URL in Safari, Share → Add to Home Screen, open Muninn from the Home Screen, enter the setup code and a passphrase (16+ characters), add a passkey, then Settings → Turn on reminders. The setup route closes for good after the first success.

Recommended hardening:
- Anthropic Console: a dedicated workspace for Muninn with a monthly spend limit (for example $10).
- Cloudflare: hardware-key 2FA on the account; a custom domain if you want one (passkeys are bound to the hostname, so pick it before registering passkeys).
- GitHub: secret scanning and push protection on.

### Optional
- **Vectorize** (if your plan includes it for free): `npx wrangler vectorize create muninn-captures-v1 --dimensions=768 --metric=cosine`, then uncomment the binding in `wrangler.jsonc`. Without it, search runs over vectors stored in D1 (fine for the first few thousand notes).
- **Weekly encrypted backup to R2**: `npx wrangler r2 bucket create muninn-backups`, then uncomment the binding.
- **Deploy from GitHub Actions**: add secrets `CLOUDFLARE_API_TOKEN` (scoped to Workers Scripts:Edit and D1:Edit on this account) and `CLOUDFLARE_ACCOUNT_ID`, and the variable `DEPLOY_ENABLED=true`.

## Costs

Every AI call is logged with feature, model, tokens and estimated cost. Settings → AI usage shows the month's total per feature. Expected v1 cost: about $0.55/month at 20 notes and 10 questions a day, plus a few cents per advice question.
