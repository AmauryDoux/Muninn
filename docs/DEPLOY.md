# Deploy from GitHub (no terminal)

Once this is set up, every push or merge to `main` goes live in about 3 to 5 minutes: GitHub runs lint, type check, tests and build, checks the AI schemas against the API, compares the new config with the live Worker, applies any new D1 migrations, then runs `wrangler deploy`. Everything below works in a phone browser. It is a one-time setup.

Worker secrets (`DATA_KEY`, `ANTHROPIC_API_KEY`, `VAPID_PRIVATE_KEY`, `GOOGLE_*`, ...) stay in Cloudflare. `wrangler deploy` keeps them; GitHub never sees them.

## 1. Cloudflare API token (least privilege)

1. Open [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) and sign in.
2. **Create Token** → at the bottom, **Create Custom Token** → **Get started**.
3. Token name: `muninn-github-deploy`.
4. Permissions, three rows, all **Account**:
   - `Workers Scripts` → `Edit` (upload the Worker, read its current bindings)
   - `D1` → `Edit` (apply migrations)
   - `Account Settings` → `Read` (wrangler looks up the `workers.dev` subdomain)
5. Account Resources: **Include** → your account (not "All accounts").
6. Client IP Address Filtering: leave empty. GitHub's runners have no fixed IP.
7. TTL: optional. If you set an end date, deploys will fail with an auth error on that day until you replace the token.
8. **Continue to summary** → **Create Token** → copy the token now (it is shown once).

Nothing else is needed: no zone permissions, no KV, no R2. `D1:Edit` can read and change the database and `Workers Scripts:Edit` can replace the Worker, so treat the token as a production credential: it lives only in GitHub secrets, and you can roll it from the same API Tokens page at any time.

## 2. Values to copy from Cloudflare

- **Account ID**: Cloudflare dashboard → **Workers & Pages** → the right column (or account home → the "..." menu next to the account name → Copy account ID).
- **D1 database ID**: **Storage & Databases** → **D1 SQL Database** → `muninn` → the Database ID at the top.
- **Push key and subject**: **Workers & Pages** → `muninn` → **Settings** → **Variables and Secrets** → copy the values of `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT`.
- **Backups**: on the same page, under Bindings, if `BACKUPS` (R2) is listed, you need `ENABLE_BACKUPS=true` below. Same for `VECTORIZE` and `ENABLE_VECTORIZE=true`.

## 3. GitHub secrets and variables

On github.com in the phone browser (the GitHub app can't edit these): repository **muninn** → **Settings** → **Secrets and variables** → **Actions**.

**Secrets** tab → **New repository secret**, three times:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID |
| `ANTHROPIC_API_KEY` | the same Anthropic key as the Worker secret |

**Variables** tab → **New repository variable**:

| Name | Value |
|---|---|
| `D1_DATABASE_ID` | the database ID |
| `VAPID_PUBLIC_KEY` | from the Worker's variables |
| `VAPID_SUBJECT` | from the Worker's variables |
| `ENABLE_BACKUPS` | `true` (if the BACKUPS binding exists) |
| `ENABLE_VECTORIZE` | `true` (only if the VECTORIZE binding exists) |
| `DEPLOY_ENABLED` | `true`, set last. Any other value pauses deploys. |

## 4. First deploy

**Actions** → **CI** → **Run workflow** → branch `main` → **Run workflow**. Or just merge a PR. The `deploy` job's log shows each step; the site is live when the last step is green.

## What protects production

- **Tests first.** `deploy` only runs after the `check` job (lint, type check, tests, build, secret scan) passes.
- **AI schema check.** `npm run check:ai` runs with the `ANTHROPIC_API_KEY` secret, exactly as before a local deploy. No skip switch is wired into CI.
- **Live config check.** `scripts/check-live-config.mjs` reads the live Worker's bindings and stops if the deploy would remove one (for example a forgotten `ENABLE_BACKUPS` would unbind R2: no backups, no receipt photos), point one somewhere else, or change `VAPID_PUBLIC_KEY`/`VAPID_SUBJECT` (every phone would stop getting reminders). For a deliberate change, set the variable `ALLOW_CONFIG_DRIFT=true` for one run, then delete it.
- **Migrations before code, nothing changed before them.** Every step up to the migrations is read-only, so a failure there leaves production untouched. `wrangler d1 migrations apply` only runs migrations that aren't recorded as applied yet, in file order. Keep migrations additive (new tables and columns): the old code keeps working against the new schema if the deploy step itself then fails.
- **One deploy at a time.** A second push waits for the running deploy instead of racing it.
- **Rollback.** Code: Cloudflare dashboard → `muninn` → **Deployments** → pick the previous version → **Rollback**. Data: D1 **Time Travel** can restore the database to any minute in the last 7 days on the free plan, with `wrangler d1 time-travel restore muninn --timestamp=...`.

Local deploys (`npm run deploy`) still work, but they use your local `wrangler.jsonc`. Pick one way and stick to it so the two configs don't drift.
